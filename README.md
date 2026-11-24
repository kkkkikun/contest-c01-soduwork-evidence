# SoduWork 源码解读 · 取证证据包

本仓库是 CSDN × SoduWork「开源项目测评创作者招募」参赛文章
**《SoduWork 源码解读：把验收回路的三把钥匙拆给你看》**（选题方向：**源码解读**）的**原始取证证据包**。

> 官方要求：「须在本人使用的电脑上完成安装和实际运行，记录真实操作和结果。」
> 「文章应包含必要的操作步骤、实际运行结果，以及相关截图或日志。」
> 本包里的每一个文件都是**在作者本人的电脑上跑出来的原始输出**，未经改写（仅对用户主目录路径做了脱敏）。

---

## 一、复现方法

```bash
bash local_run_probe.sh
```

在任意一台装了 **Python 3.12+** 与 **Node.js 22.19+** 的机器上执行本目录下的脚本，它会依次完成：

1. 从 Fork `https://github.com/kkkkikun/SoduWork.git` 克隆（默认到 `~/SoduWork`）
2. `sh start.sh --prepare-only` —— 装依赖 + 构建管理台
3. `sh start.sh --password-stdin` —— 启动本地 Hub（默认 `127.0.0.1:18989`）
4. `python3 probe_admin_api.py` —— 跑 4 项管理 API 探针
5. `python3.12 -m unittest tools.dev.test_start_local` —— 跑上游自带的启动器单元测试
6. `node tools/check-public-source.cjs` —— 跑上游自带的公开源清单校验
7. `node probe_goal_verifier.js --repo <repo>` —— 实跑上游确定性门禁（8 个用例，归因闭环）
8. `node probe_goal_review.js --repo <repo>` —— 实跑上游独立复核协议层（6 个用例）
9. 打印输出目录与汇总（`SUMMARY.txt`）

**脚本不使用任何预置的"标准输出"**——所有数字都是当次跑出来的。
探针的「期望值」来自**回查源码路由装饰器后的结论**（`hub-backend/app/api/admin.py` 的 1355 / 1361 / 1405 / 1430 / 1449 / 1478 / 1540 行），
一旦实际行为与源码推断不一致，探针会打印 `FAIL` 并以非 0 退出。

可选环境变量：`SODU_PORT`、`SODU_REPO_DIR`、`SODU_DATA_DIR`、`SODU_OUT_DIR`、`SODU_DESKTOP=1`、`SODU_OFFICIAL_MIRROR=1`。

## 二、文件清单

| 文件 | 内容 |
|---|---|
| `local_run.log` | 完整运行日志：克隆 → 预装 → 启动 → 探针 → 自检 → 汇总 |
| `local_run_reuse_prepare.txt` | 同一数据目录上**二次 `--prepare-only`** 的输出（1.866s，四步安装全部跳过 —— 依赖指纹复用的实证） |
| `service_stdout.log` | Hub 启动 stdout，含 `SoduWork is ready: http://127.0.0.1:18989` |
| `probe_admin_api.txt` | 4 项管理 API 探针逐条输出（200 / 404 / 404 / 200 / 401 + 10 家内置服务商清单） |
| `upstream_selfcheck.txt` | 上游启动器 123 项测试 + 公开源清单校验输出 |
| `probe_goal_review.txt` | **独立复核协议层 6 个用例的实测输出**（模型不能覆盖已失败的确定性门禁 · 畸形输出不兜底 · `verdict=pass` 但分数不够被强制降级为 `repair`） |
| `probe_goal_review.js` | 复核协议层实测脚本（直接 require 上游 `goal-review.js` 的 `outcome()`，**不需要模型 API Key**） |
| `SUMMARY.txt` | 取证汇总：机器、时间、Fork 地址、取证 commit、服务地址 |
| `probe_admin_api.py` | 探针脚本本体（仅用 Python 标准库） |
| `local_run_probe.sh` | 「一条命令跑完全流程」的封装脚本 |

## 三、取证环境

| 项 | 值 |
|---|---|
| 运行机器 | 作者本人的电脑：Linux 5.15.167.4-microsoft-standard-WSL2 x86_64（Ubuntu 22.04） |
| 解释器 / 运行时 | Python 3.12.13 · Node.js 22.21.1 |
| Fork | `https://github.com/kkkkikun/SoduWork`（父仓库 `https://github.com/mdiri-ai/SoduWork`） |
| 取证 commit | `5a60c86697bcde25548c4277ba585b71f31c9338` |
| Hub 地址 | `http://127.0.0.1:18989`（回环，未对外暴露） |
| 取证时间 | 2026-11-24 12:00–12:08 +08:00 |

## 四、诚实边界

- 本包中的所有结果都来自**部署层、接口层与门禁协议层**（Hub 生命周期、管理台、鉴权边界、模型目录、
  确定性门禁 `goal-verifier.js` 的判定分支、独立复核 `goal-review.js` 的协议分支）。
- 两个探针脚本测的是**上游自己的判定代码**，模型输出是用构造样本代替的——
  它们能证明「即使模型想放行，这段代码也不会让它放行」，**不能**证明模型评审的质量。
- **本包不含任何模型跑分、通过率或性能数字** —— 当时没有可用的模型 API Key，
  因此「跑完一件真实业务任务」这件事没有做，文章 §8.2 已如实登记为未完成。
- 本包不含任何他人（第三方）的截图、日志或测试结果。

## 五、许可

本证据包中的脚本（`probe_admin_api.py`、`local_run_probe.sh`）与日志可自由引用与复跑。
SoduWork 本体版权归 MDiRi 所有，遵循 MIT 协议。
