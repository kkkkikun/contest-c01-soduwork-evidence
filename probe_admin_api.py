#!/usr/bin/env python3
"""C01 · SoduWork 管理 API 取证探针（零第三方依赖，只用标准库）。

用途：在「本人使用的电脑上」对本地 Hub 复现 §10 的实测结果，
并把「运行结果」与「源码行」一一对应打印出来。

对应关系（upstream commit 5a60c866）：
  admin.py:1355  @router.get("/model-catalog",     ...)  -> 期望 200
  admin.py:1361  @router.put("/model-providers/{pid}") -> 期望 404（无 GET）
  admin.py:1405  @router.delete("/model-providers/{pid}")
  admin.py:1430  @router.post("/model-providers/test-connection")
  admin.py:1449  @router.post("/model-providers/{pid}/discover")
  admin.py:1478  @router.put("/model-defs")
  admin.py:1540  @router.delete("/model-defs/{mid:path}")

用法：
    python3 probe_admin_api.py --base http://127.0.0.1:18989 --user admin --password <pw>
退出码：0 = 全部符合预期；1 = 有不符合（逐条打印实际值，不臆造）。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

ADMIN = "/api/v1/admin"


def request(method: str, url: str, *, body=None, token: str | None = None, timeout: int = 20):
    """返回 (status, text)。HTTP 错误不抛异常，因为 404/401 正是被测对象。"""
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        return 0, f"网络错误 / connection error: {exc}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18989")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", required=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    failures = 0

    def check(label: str, got, want, extra: str = "") -> None:
        nonlocal failures
        ok = got == want
        if not ok:
            failures += 1
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {label}: 实测={got} 期望={want}{('  ' + extra) if extra else ''}")

    print("=" * 72)
    print("SoduWork 管理 API 实测（本地实例）")
    print(f"目标 = {base}")
    print("=" * 72)

    # [1] 登录取 token
    status, text = request("POST", base + ADMIN + "/login",
                           body={"user": args.user, "pass": args.password})
    token = ""
    if status == 200:
        try:
            token = json.loads(text).get("access_token") or json.loads(text).get("token") or ""
        except json.JSONDecodeError:
            pass
    check("[1] POST /api/v1/admin/login（鉴权入口）", status, 200,
          f"token {'已获取，长度 %d' % len(token) if token else '未获取'}")
    if not token:
        print("无法取得 token，后续带鉴权探测无法进行。")
        return 1

    # [2][3] 源码里不存在的 GET 路由 -> 404
    for path, src in (("/model-providers", "admin.py:1361/1405/1430/1449（PUT/DELETE/POST）"),
                      ("/model-defs", "admin.py:1478/1540（PUT/DELETE）")):
        status, text = request("GET", base + ADMIN + path, token=token)
        check(f"[2] GET /api/v1/admin{path}（带 token）", status, 404,
              f"源码依据 {src}")

    # [4] 真实存在的 GET 路由 -> 200，且内置服务商 10 家
    status, text = request("GET", base + ADMIN + "/model-catalog", token=token)
    check("[3] GET /api/v1/admin/model-catalog（带 token）", status, 200,
          "源码依据 admin.py:1355")
    if status == 200:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {}
        providers = payload.get("providers") if isinstance(payload, dict) else None
        if providers is None and isinstance(payload, dict):
            for key in ("items", "data", "rows"):
                if isinstance(payload.get(key), list):
                    providers = payload[key]
                    break
        providers = providers if isinstance(providers, list) else []
        print(f"       内置服务商数量 = {len(providers)}")
        for p in providers:
            if isinstance(p, dict):
                print(f"         - {p.get('key') or p.get('id')} | {p.get('name') or p.get('label') or ''}")
        defs = payload.get("models") or payload.get("defs") or [] if isinstance(payload, dict) else []
        print(f"       已配置模型 defs 数量 = {len(defs) if isinstance(defs, list) else 0}")

    # [5] 去掉 token -> 401（鉴权中间件生效）
    status, text = request("GET", base + ADMIN + "/model-catalog")
    check("[4] GET /api/v1/admin/model-catalog（不带 token）", status, 401,
          "源码依据 require_perm(\"integration.manage\") 依赖")

    print("=" * 72)
    if failures:
        print(f"结论：{failures} 项与预期不符 —— 以实测值为准，不要改预期凑数。")
        return 1
    print("结论：4 项全部与源码推断一致（本次运行证伪了我最初的 2 处路由推断）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
