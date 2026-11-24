#!/usr/bin/env bash
# ============================================================================
# C01 · SoduWork 本机「安装 + 运行 + 取证」一条龙脚本
#
# 官方要求（2026-11-24 官方公告）：
#   「须在本人使用的电脑上完成安装和实际运行，记录真实操作和结果。」
#   源码解读方向：「先 Fork 到本地并跑起来……写明 Fork 地址、你看过的部分，
#                   以及它和这次结果的对应关系。」
#
# 本脚本在你自己的电脑上完成：
#   1) 克隆 Fork（github.com/kkkkikun/SoduWork）
#   2) sh start.sh --prepare-only   → 装依赖 + 构建管理台
#   3) sh start.sh --password-stdin → 启动本地 Hub（默认 127.0.0.1:18989）
#   4) 管理 API 取证（5 条断言，对应源码行）
#   5) 跑上游仓库自带的自检套件（launcher 123 项 + 公开源清单）
#   6) 实跑上游的确定性门禁（8 用例）与独立复核协议层（6 用例）——两项都不需要模型 API Key
#   7) 打印「该截哪 7 张图」清单
#
# 用法：
#   bash source/local_run_probe.sh
# 可选环境变量：
#   SODU_PORT=18989          本地端口（默认 18989）
#   SODU_REPO_DIR=$HOME/SoduWork        Fork 克隆目录
#   SODU_DATA_DIR=$HOME/.local/share/soduwork/source-service   数据目录
#   SODU_OUT_DIR=$HOME/soduwork-local-evidence                取证输出目录
#   SODU_DESKTOP=1           额外安装并打开 Electron 桌面端（需图形环境）
#   SODU_OFFICIAL_MIRROR=1   用官方 pypi/npm 源（默认用国内镜像，更稳）
#
# 退出码：0 = 全流程通过；非 0 = 某一步失败（脚本会指明第几步）
# ============================================================================
set -euo pipefail

FORK_URL="https://github.com/kkkkikun/SoduWork.git"
PORT="${SODU_PORT:-18989}"
REPO_DIR="${SODU_REPO_DIR:-$HOME/SoduWork}"
STATE_DIR="${SODU_DATA_DIR:-$HOME/.local/share/soduwork/source-service}"
OUT_DIR="${SODU_OUT_DIR:-$HOME/soduwork-local-evidence}"
SCRIPT_DIR="$(cd "$(dirname -- "$0")" && pwd)"
PROBE_PY="$SCRIPT_DIR/probe_admin_api.py"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n\033[1m===== [步骤 %d] %s =====\033[0m\n' "$STEP" "$1"; }
die()  { printf '\n\033[31m[失败] %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$PROBE_PY" ] || die "找不到探针脚本 $PROBE_PY（脚本目录定位错误）"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
LOG="$OUT_DIR/local_run.log"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }

say "SoduWork 本机取证脚本 —— 开始"
say "时间 = $(date -Is)"
say "输出目录 = $OUT_DIR"
say "仓库目录 = $REPO_DIR"
say "数据目录 = $STATE_DIR"

# ---------------------------------------------------------------- 步骤 0 前置
step "检查前置环境（Python 3.12+ / Node 22.19+ / Git / 磁盘）"

PY=""
for cand in python3.14 python3.13 python3.12; do
  if command -v "$cand" >/dev/null 2>&1 && \
     "$cand" -c 'import sys; sys.exit(sys.version_info < (3,12))' >/dev/null 2>&1; then
    PY="$(command -v "$cand")"; break
  fi
done
if [ -z "$PY" ]; then
  say "未找到 Python 3.12+，尝试用 uv 安装（不需要 sudo）…"
  if command -v uv >/dev/null 2>&1; then
    uv python install 3.12 >>"$LOG" 2>&1 || true
    [ -x "$HOME/.local/bin/python3.12" ] && PY="$HOME/.local/bin/python3.12"
  else
    say "提示：可先执行 'pip3 install uv -i https://mirrors.aliyun.com/pypi/simple' 再重跑本脚本。"
  fi
fi
[ -n "$PY" ] || die "缺少 Python 3.12+（SoduWork 要求 3.12 及以上）。请先装好再重跑。"
say "Python = $PY ($("$PY" -V 2>&1))"

command -v git >/dev/null 2>&1 || die "缺少 git"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"
  NODE_OK="$(printf '%s\n' "$NODE_VER" | sed 's/^v//' | awk -F. '{ if ($1>22 || ($1==22 && $2>=19)) print 1; else print 0 }')"
  say "Node = $NODE_VER"
  [ "$NODE_OK" = "1" ] || say "⚠ 建议 Node 22.19+（上游 README 要求），当前 $NODE_VER 可能有问题"
else
  say "⚠ 未找到 node —— 管理台构建可能失败"
fi

AVAIL_GB="$(df -BG "$HOME" | awk 'NR==2{gsub("G","",$4); print $4}')"
say "可用磁盘 = ${AVAIL_GB}G（首次安装需要约 3-5 GB）"
[ "${AVAIL_GB:-0}" -ge 5 ] || say "⚠ 可用磁盘不足 5G，安装可能失败"

# 国内镜像（R4 同源策略；服务器上已验证 aliyun pypi + npmmirror 可用）
if [ "${SODU_OFFICIAL_MIRROR:-0}" = "1" ]; then
  export PIP_INDEX_URL="https://pypi.org/simple"
  export NPM_CONFIG_REGISTRY="https://registry.npmjs.org"
else
  export PIP_INDEX_URL="https://mirrors.aliyun.com/pypi/simple"
  export NPM_CONFIG_REGISTRY="https://registry.npmmirror.com"
fi
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PATH="$HOME/.local/bin:$PATH"

# ---------------------------------------------------------------- 步骤 1 克隆
step "克隆 Fork（$FORK_URL）"
if [ -d "$REPO_DIR/.git" ]; then
  say "已存在，跳过克隆：$REPO_DIR"
else
  git clone "$FORK_URL" "$REPO_DIR" 2>&1 | tee -a "$LOG"
fi
cd "$REPO_DIR"
say "--- git remote -v ---"
git remote -v | tee -a "$LOG"
say "--- git log -1 ---"
git log -1 --format='commit %H%n作者 %an <%ae>%n日期 %ad' | tee -a "$LOG"
FORK_COMMIT="$(git rev-parse HEAD)"
say "取证 commit = $FORK_COMMIT"

# ---------------------------------------------------------------- 步骤 2 准备
step "准备依赖与构建管理台（sh start.sh --prepare-only）"
BASE="http://127.0.0.1:$PORT"
ALREADY_RUNNING=0
if curl -fsS -o /dev/null --max-time 3 "$BASE/" 2>/dev/null; then
  ALREADY_RUNNING=1
fi
say "首次运行需联网下载依赖，可能 3-10 分钟。"
if [ "$ALREADY_RUNNING" = "1" ]; then
  say "检测到 $BASE 已在运行，跳过 prepare（数据目录已被运行中的实例锁定）。"
else
  if [ "${SODU_DESKTOP:-0}" = "1" ]; then
    sh start.sh --prepare-only --desktop --data-dir "$STATE_DIR" 2>&1 | tee -a "$LOG"
  else
    sh start.sh --prepare-only --data-dir "$STATE_DIR" 2>&1 | tee -a "$LOG"
  fi
  say "prepare 完成。"
fi

# ---------------------------------------------------------------- 步骤 3 启动
step "启动本地 Hub（sh start.sh --password-stdin）"
PW_FILE="$OUT_DIR/admin_password.txt"
if [ -n "${SODU_PASSWORD:-}" ]; then
  # 显式指定的密码优先（用于复用已在运行的实例时）
  PW="$SODU_PASSWORD"
  say "使用 SODU_PASSWORD 环境变量指定的密码"
elif [ "$ALREADY_RUNNING" = "1" ] && [ ! -f "$PW_FILE" ]; then
  # 复用「已经在跑的实例」时，管理员密码属于那份实例，不在本次输出目录里
  # （例如用 SODU_OUT_DIR=/tmp/xxx 做隔离复跑时）。
  # 这里按优先级去找，找不到就明确报错 —— 绝不能自己生成一个新密码，
  # 那样登录必然失败，而失败原因还容易被误读成「接口有问题」。
  for CAND in "$HOME/soduwork-local-evidence/admin_password.txt" "$STATE_DIR/admin_password.txt"; do
    if [ -f "$CAND" ]; then PW_FILE="$CAND"; break; fi
  done
  if [ ! -f "$PW_FILE" ]; then
    die "实例已在 $BASE 运行，但找不到它的管理员密码文件（已查 $OUT_DIR、$HOME/soduwork-local-evidence、$STATE_DIR）。
     请用 SODU_PASSWORD 环境变量指定该实例的 admin 密码后重跑。"
  fi
fi
if [ -z "${PW:-}" ]; then
  if [ -f "$PW_FILE" ]; then
    PW="$(cat "$PW_FILE")"
    say "复用已记录的管理员密码（$PW_FILE）"
  else
    PW="SoduLocal-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
    printf '%s\n' "$PW" > "$PW_FILE"
    chmod 600 "$PW_FILE"
    say "已生成管理员密码并保存到 $PW_FILE（权限 600，仅本机可见）"
  fi
fi

BASE="http://127.0.0.1:$PORT"
if [ "$ALREADY_RUNNING" = "1" ]; then
  say "复用已在运行的实例：$BASE"
else
  say "启动中…（首次启动要等数据库迁移，最多 10 分钟）"
  START_OUT="$OUT_DIR/service_stdout.log"
  ( printf '%s\n' "$PW" | sh start.sh --data-dir "$STATE_DIR" --port "$PORT" --no-browser --password-stdin ) \
      >"$START_OUT" 2>&1 &
  SERVICE_PID=$!
  say "服务进程 PID = $SERVICE_PID，输出见 $START_OUT"
  printf '%s\n' "$SERVICE_PID" > "$OUT_DIR/service.pid"
  READY=0
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null --max-time 3 "$BASE/" 2>/dev/null; then READY=1; break; fi
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then break; fi
    sleep 5
  done
  [ "$READY" = "1" ] || { tail -30 "$START_OUT" >&2; die "服务未在预期时间内就绪，请看 $START_OUT"; }
fi
say "服务就绪：$BASE"

# ---------------------------------------------------------------- 步骤 4 取证
step "管理 API 取证（对应源码行）"
PROBE_OUT="$OUT_DIR/probe_admin_api.txt"
set +e
"$PY" "$PROBE_PY" --base "$BASE" --user admin --password "$PW" 2>&1 | tee "$PROBE_OUT"
PROBE_RC="${PIPESTATUS[0]}"
set -e
say "探针退出码 = $PROBE_RC（输出见 $PROBE_OUT）"

# ---------------------------------------------------------------- 步骤 5 自检
step "跑上游仓库自带的自检套件"
CHECK_OUT="$OUT_DIR/upstream_selfcheck.txt"
VENV_PY="$STATE_DIR/venv/bin/python"
# 注意：这个 { } 块被管道给 tee，会跑在子 shell 里，块内变量出不来。
# 所以退出码要落到临时文件，块外再读回来 —— 否则总判定会漏掉上游自检的失败。
A_RC_FILE="$OUT_DIR/.selfcheck_a_rc"
B_RC_FILE="$OUT_DIR/.selfcheck_b_rc"
{
  echo "===== 上游自带检查（upstream commit $FORK_COMMIT）====="
  echo
  echo "----- A. 启动器单元测试：python -m unittest tools.dev.test_start_local -----"
  if [ -x "$VENV_PY" ]; then
    set +e
    "$VENV_PY" -m unittest tools.dev.test_start_local 2>&1 | tail -20
    A_RC="${PIPESTATUS[0]}"
    set -e
    echo "$A_RC" > "$A_RC_FILE"
    echo "A 退出码 = $A_RC"
  else
    echo "跳过：找不到 venv 解释器 $VENV_PY"
    echo "125" > "$A_RC_FILE"
  fi
  echo
  echo "----- B. 公开源清单：node tools/check-public-source.cjs -----"
  if command -v node >/dev/null 2>&1; then
    set +e
    node tools/check-public-source.cjs 2>&1 | tail -20
    B_RC="${PIPESTATUS[0]}"
    set -e
    echo "$B_RC" > "$B_RC_FILE"
    echo "B 退出码 = $B_RC"
  else
    echo "跳过：没有 node"
    echo "125" > "$B_RC_FILE"
  fi
} 2>&1 | tee "$CHECK_OUT"
A_RC="$(cat "$A_RC_FILE" 2>/dev/null || echo 125)"
B_RC="$(cat "$B_RC_FILE" 2>/dev/null || echo 125)"
rm -f "$A_RC_FILE" "$B_RC_FILE"
say "上游自检退出码：A=$A_RC · B=$B_RC"

# ---------------------------------------------------------------- 步骤 5b 门禁实测
step "实跑上游的确定性门禁与独立复核协议层（两项都不需要模型 API Key）"

# 两个探针脚本可能与本脚本同目录（公开证据仓库），也可能在 evidence/local_run/ 下（内部工作区）
find_probe() {
  local name="$1"
  for cand in "$SCRIPT_DIR/$name" \
              "$SCRIPT_DIR/../evidence/local_run/$name" \
              "$OUT_DIR/$name"; do
    [ -f "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

GATE_JS="$(find_probe probe_goal_verifier.js || true)"
REVIEW_JS="$(find_probe probe_goal_review.js || true)"

GATE_OUT="$OUT_DIR/probe_goal_verifier.txt"
REVIEW_OUT="$OUT_DIR/probe_goal_review.txt"

if [ -n "$GATE_JS" ] && command -v node >/dev/null 2>&1; then
  say "运行确定性门禁探针（8 个用例）→ $GATE_OUT"
  set +e
  node "$GATE_JS" --repo "$REPO_DIR" 2>&1 | tee "$GATE_OUT"
  GATE_RC="${PIPESTATUS[0]}"
  set -e
  say "门禁探针退出码 = $GATE_RC"
else
  GATE_RC=1
  say "⚠ 找不到 probe_goal_verifier.js 或没有 node —— 跳过确定性门禁实测"
fi

if [ -n "$REVIEW_JS" ] && command -v node >/dev/null 2>&1; then
  say "运行独立复核协议层探针（6 个用例）→ $REVIEW_OUT"
  set +e
  node "$REVIEW_JS" --repo "$REPO_DIR" 2>&1 | tee "$REVIEW_OUT"
  REVIEW_RC="${PIPESTATUS[0]}"
  set -e
  say "复核协议层探针退出码 = $REVIEW_RC"
else
  REVIEW_RC=1
  say "⚠ 找不到 probe_goal_review.js 或没有 node —— 跳过独立复核协议层实测"
fi

# ---------------------------------------------------------------- 步骤 6 汇总
step "汇总与截图指引"
SUMMARY="$OUT_DIR/SUMMARY.txt"
{
  echo "SoduWork 本机运行取证汇总"
  echo "生成时间 = $(date -Is)"
  echo "本机 = $(uname -srm) / $(python3 -c 'import platform;print(platform.platform())' 2>/dev/null || echo unknown)"
  echo "Fork 地址 = $FORK_URL"
  echo "取证 commit = $FORK_COMMIT"
  echo "服务地址 = $BASE"
  echo "管理员账号 = admin"
  echo "管理员密码 = 见 $PW_FILE"
  echo "数据目录 = $STATE_DIR"
  echo
  echo "== 探针结论 =="
  cat "$PROBE_OUT"
  echo
  echo "== 自检结论 =="
  cat "$CHECK_OUT"
  echo
  echo "== 确定性门禁实测结论（8 个用例）=="
  [ -f "$GATE_OUT" ] && cat "$GATE_OUT" || echo "（未运行）"
  echo
  echo "== 独立复核协议层实测结论（6 个用例）=="
  [ -f "$REVIEW_OUT" ] && cat "$REVIEW_OUT" || echo "（未运行）"
} > "$SUMMARY"

cat <<'EOF'

────────────────────────────────────────────────────────────
✅ 全流程跑完了。现在请在「你自己的电脑」上截这 7 张图：

  图 1  终端里执行 `git -C <仓库目录> remote -v` 的输出
        （要能看到 origin = https://github.com/kkkkikun/SoduWork.git）
  图 2  浏览器打开 http://127.0.0.1:18989/ ，用 admin 登录后的
        「能力配置 → 模型目录」页面（应显示 10 家内置服务商）
  图 3  终端里 `cat <输出目录>/probe_admin_api.txt` 的完整输出
        （5 条断言：200 / 404 / 404 / 200 / 401）
  图 4  终端里 `cat <输出目录>/upstream_selfcheck.txt` 的输出
        （上游自检：launcher 123 项 + 公开源清单 ok=true）
  图 5  终端里 `cat <输出目录>/probe_goal_verifier.txt` 的完整输出
        （确定性门禁 8 个用例：类型门禁拦得住 / 超 2MB 与超 120 文件处漏检 / 对照组与放宽变体验证归因）
  图 6  终端里 `cat <输出目录>/probe_goal_review.txt` 的完整输出
        （独立复核协议层 6 个用例：模型不能覆盖已失败的确定性门禁 / verdict=pass 但分数不够被降级）
  图 7  （可选但加分）浏览器打开 http://127.0.0.1:18989/ ，
        截一张能体现「这是你自己机器上的本地实例」的图（含地址栏 127.0.0.1）。

  把图和 <输出目录>/ 整个目录发给我，我据此定稿文章的 §10 与 §11。
────────────────────────────────────────────────────────────
EOF
say "汇总已写入 $SUMMARY"

# 服务保持运行，方便截图；结束时用 `kill $(cat $OUT_DIR/service.pid)` 停掉。
RC=0
[ "${PROBE_RC:-1}" = "0" ] || { say "⚠ 管理 API 探针存在不符项（退出码 $PROBE_RC）—— 以实测值为准，不要改预期凑数。"; RC=1; }
[ "${GATE_RC:-1}" = "0" ]  || { say "⚠ 确定性门禁探针存在不符项（退出码 $GATE_RC）—— 以实测值为准。"; RC=1; }
[ "${REVIEW_RC:-1}" = "0" ] || { say "⚠ 独立复核协议层探针存在不符项（退出码 $REVIEW_RC）—— 以实测值为准。"; RC=1; }
[ "${A_RC:-125}" = "0" ]    || { say "⚠ 上游自带启动器单元测试未通过（退出码 $A_RC）—— 以实测值为准。"; RC=1; }
[ "${B_RC:-125}" = "0" ]    || { say "⚠ 上游公开源清单校验未通过（退出码 $B_RC）—— 以实测值为准。"; RC=1; }
if [ "$RC" != "0" ]; then
  say "完成，但有探针不符项（退出码 $RC）。"
  exit "$RC"
fi
say "完成。退出码 0。"
exit 0
