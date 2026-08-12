# Computer Use 两小时 Agent E2E 可靠性定向开发补充报告

日期：2026-08-12（Asia/Shanghai）

## 1. 基线与边界

- 工作树：`SciForge-computer-use-runtime-e2e`
- 不可变六小时基线及远端备份：`test/6h-production-readiness@37b129974b3054d09220e53552bdd1c964847e55`
- 本轮分支：`fix/2h-agent-e2e-reliability`
- 代码验收提交：`c4222cc7 fix(computer-use): preserve unknown outcome diagnostics`
- 本报告作为后续文档提交附加在代码验收提交之后；最终 HEAD 以包含本报告的本地提交为准。
- 未 push，未创建或修改 PR，未操作 PR #57 或 PR #62。

## 2. 真实生产链原始结果（脱敏）

使用全新独立 SciForge、sidecar、CDP adapter 和测试拥有的八个 BrowserContext；外层使用 Codex in-app Browser 操作同一 renderer，新建内层 Agent 后已确认思考模式为 Med。唯一测试值为一次性合成值，未使用真实账号或敏感数据。

复杂表单第一次复现没有得到 `ACTION_OUTCOME_UNKNOWN`，而是明确的 `TIMEOUT`：

- 协议结果：`TIMEOUT`，message 为 `request deadline expired during model call`；错误没有被改写为成功。
- 阶段定位：初始 observe、规划和五个动作均已发生；第五个动作后的下一次 planner 等待耗尽 240 秒总 deadline。不是 Host 审批、sidecar 调度、动作前断线或 post-dispatch transport unknown。
- 动作转发：共五个动作，每个只有一个 action record 和 action ID；没有重试或重放。
- outcome：五个动作均 `committed=true`、`mayHaveTakenEffect=true`；前三个 `verified`，后两个 `unverified`。
- partial trace：五个已发生动作及各自 action timeline、outcome、verification 均保留。
- 权威页面状态：final revision `cdp:11`；semanticTree 的 output 为 `Not submitted`，所以协议失败与页面未提交一致。页面局部变化没有被当成任务成功。
- release：finally release 成功，session 进入 `closed/client_release`。
- release 后八类活动资源：sessions、requests、active leases、active channels、active requests、cleanup pending、waiters、backend handles 均为 0。

该真实结果同时完成 P1 的主要检查：最终错误仍为 `TIMEOUT`，partial trace 没有丢失，已发生动作不重放，final revision 和脱敏 semanticTree 保留，资源最终归零。

## 3. 明确诊断缺口与修复

50 分钟内没有在新鲜复杂表单上再次得到 unknown，因此没有猜测性调整 transport timeout、重试策略或成功判定。代码审查确认了一个可复现的通用诊断缺口：当 `channel.perform()` 抛出 `ACTION_OUTCOME_UNKNOWN` 时，runner 原先不会把当前写动作加入 partial trace，也不会留下 dispatch/backend/verification 阶段证据，更不会执行允许的只读核验。

本轮实施的最小通用修复：

1. channel 在 unknown 错误中保留 action ID、action kind、dispatch 是否进入、adapter receipt 是否收到、committed、mayHaveTakenEffect、expected revision，以及 request/session/target 关联。
2. channel 以 `time.monotonic()` 记录 backend execution 和 verification 阶段的开始、结束、状态和耗时；wall time 仅用于跨进程可读关联。
3. runner 对 observe、planner wait、action dispatch、readback 建立通用单调阶段时间线，每条都关联 request/session/target。
4. 写动作 unknown 后绝不重新调用 perform；只尝试一次 target-scoped `channel.observe()`，记录 final revision 与 provider 已脱敏的 semanticTree。
5. 只读核验无论显示页面变化与否，原错误仍保持 `ACTION_OUTCOME_UNKNOWN`、`verification=unknown`，不得追认为成功或 verified。

没有添加 Gamma、Web Task Lab 文案、坐标、控件名或页面结构硬编码；没有放宽审批/隔离，没有启用 Legacy/PyAutoGUI 或宿主全局输入。

## 4. 自动化证据

- 定向 runner/channel：`22 passed`。
- Computer Use Python：`255 passed, 21 skipped`。
- Ruff F/E9：通过。
- Computer Use domain：`97 passed`；typecheck 通过。
- Host MCP gateway：`25 passed`。
- multisession/evidence：`9 passed`。
- capability check：17 packages / 175 actions，通过且无架构旁路。
- `git diff --check`：通过。
- 待提交 diff 敏感信息关键词扫描：无命中。

新增回归明确证明：

- unknown 的 backend perform 调用次数严格为 1；
- unknown 后只发生一次只读 observe；
- error code 不变，partial trace 包含 unknown 当前 step；
- timeout partial trace 保持 committed outcome；
- 阶段时间线单调，且 request/session/target 关联正确；
- finally cleanup 后 lease 与 backend handle 归零。

## 5. 未完成与下一步

- 本轮没有稳定复现复杂表单原始 `ACTION_OUTCOME_UNKNOWN`，因此没有声称修复其上游根因；准确结论是补齐了下一次 unknown 所需的通用定位证据与安全只读核验。
- P2 四路 action overlap=0 没有继续做架构修改，也没有在本轮重新运行真实 parallel[4]；避免在 P0 根因未出现时扩大范围。
- 由于本轮属于诊断增强而非执行语义根因修复，没有强行跑三次表单或完整真实矩阵。
- 下一轮应在全新栈上注入一次可控 post-dispatch transport loss，直接读取新增 phase/stage timeline；随后再用新鲜复杂表单复现。只有证据指向确定的 transport、adapter、verification 或 readback 阶段后，才实施对应小修复。

## 6. 资源清理

本轮测试拥有的 SciForge、sidecar、plan gateway、CDP Lab、BrowserContext/Edge、Codex 子进程均已停止；本轮临时 runtime/profile 目录及该次 screenshot artifact 目录已删除。结束核对时测试端口和测试拥有进程均无残留。
