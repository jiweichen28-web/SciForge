# SciForge Computer Use 六小时生产就绪性附加测试

日期：2026-08-11 至 2026-08-12（Asia/Shanghai）

性质：独立本地附加测试，不属于 PR #62 或 PR #57

分支：`test/6h-production-readiness`
基线：`5cd7e5728e516139af36e4e3365055cc94d3d8ba`

## 结论

当前实现是能力较完整的可用原型，但本轮证据**不支持“生产级可靠”结论**。

底层 target-scoped CDP、会话隔离、失败关闭、未知动作结果不重放和资源回收表现稳定；但 SciForge 内 Agent 的端到端任务成功率仍受规划质量、工具参数组装、上游模型可用性和长尾延迟影响。四路批次证明了不同 BrowserContext 的会话与页面状态没有串线，却没有观察到跨 Session 动作时间重叠。上线到真实业务前仍需持续运行统计、明确 SLO、上游重试策略与更多安全边界测试。

## 测试边界

- 主要目标是测试拥有的本地 Web Task Lab，不使用真实账号或业务数据。
- 八个独立 BrowserContext 覆盖 Todo、Wiki-style 搜索与导航、复杂表单、多页面流程、下载边界和动态 DOM。
- 上传控件明确禁用：当前 target-scoped CDP 动作契约不能安全填充宿主文件选择器，不以全局输入绕过。
- 第三方网站仅做一次 Wikipedia 首页只读观察冒烟，与本地 Lab 分开统计。
- 每个新 SciForge Agent 聊天均由外层 Codex 在界面确认 `Med` 后开始。
- 所有动作批次都要求 `host-app-scoped`、`allowDegraded=false`，禁止 Legacy；`ACTION_OUTCOME_UNKNOWN` 不重试、不重放。

## 端到端结果

### 首轮八上下文

两批各四路并发，调度与执行生命周期均发生公共重叠，所有会话 finally 释放且八类活动资源归零。

- 按当时提示中的严格文本判据：3/8 任务通过。
- Wiki-style `CRISPR` 搜索和 Enter 导航通过，Enter 的 URL/semanticTree 变化为 `verified`。
- 多页面流程通过；下载触发一次真实测试文件下载并由 Lab 计数确认。
- 一次复杂表单在部分动作后遇到 `ACTION_OUTCOME_UNKNOWN`，动作只转发一次且未重放。
- 多路失败来自 Agent 提前报告失败或未完成流程，不是 Session 串线。

### 顺序对照

从干净状态顺序执行 Todo、复杂表单、动态页面、Wiki-style 搜索，4/4 完成。复杂表单第一次复用脏页面状态的结果不计入冷启动成功率；重置后冷启动成功。

并发批次明显弱于顺序对照，说明主要瓶颈位于 Agent 规划/上游调用与批量长尾，而不是页面基本动作能力。

### 判据更正与回归

测试提示曾错误要求 Wiki 结果标题等于查询词、以及多页面结果出现页面从未定义的文案。实际 Lab 契约分别是 `Knowledge Result: {query}` 和 `Workflow Complete {label}` / `Verified code {code}`。

- 更正判据后，相关两路页面实际均完成，所有 7 个动作均为 `verified`。
- 由于当时提示仍携带错误预期，Agent 正确返回显式失败；报告不把该次 `0/2` 误写成产品任务失败。
- Lab ready 契约升为 v2，为全部八个任务提供机器可读权威 oracle，防止测试者再次手写漂移判据。

### 后续四路批次

- Batch 5：四路 bind 成功，但 Agent 错把已绑定的 `target` 放进 parallel child。正式 schema 在调度前拒绝，页面动作 0，未重试；四路均释放，八类资源归零。该结果计为 Agent 工具组装失败。
- Batch 6：使用正式 parallel schema 后只调用一次四路执行。下载、动态页面、Todo 3/3 完成并 `agent_reported_done`；Wiki-style 路在 planning step 遇到上游 HTTP 502 `UNAVAILABLE`，没有动作且未重试。批次任务层 3/4，公共执行重叠 `60,992.203 ms`，最大跨 Session 动作重叠 `0 ms`。四路均释放，八类资源归零。

Batch 6 的已执行动作全部 `verified`；最终 semanticTree 分别包含 `Download requested`、`Dynamic task completed Zeta` 和 `Completed: eta-batch5`。

- Batch 7：Todo、CRISPR 搜索和多页面流程成功；复杂表单返回 `ACTION_OUTCOME_UNKNOWN`，未重试。任务层 3/4，13 个已返回动作全部 `verified`；公共执行重叠 `205,231.716 ms`，动作重叠 `0 ms`。Lab 状态确认 unknown 路没有提交副作用。
- Batch 8：任务层 4/4；公共执行重叠 `59,086.386 ms`，动作重叠 `0 ms`。Todo 与 Bacteriophage 搜索完成；重复下载令 Lab 下载计数从 1 增至 2，重复动态点击刷新状态时间。由于 E/Z 页面开始时已经处于成功状态，协议层点击 readback 仍如实为 `unverified`，不能因外部 Lab 证据改写为 `verified`。
- Batch 9：CRISPR 与多页面流程成功；Todo 达 300 秒 `TIMEOUT`，复杂表单再次 `ACTION_OUTCOME_UNKNOWN`，任务层 2/4。公共执行重叠 `198,215.051 ms`，动作重叠 `0 ms`。Lab 状态显示超时 Todo 实际已完成且 count 增加；原错误结果没有保留已发生动作的 partial trace，促成本轮观测性修复。复杂表单仍无提交副作用。

Batch 7–9 均只调用一次 `parallel[4]`，未重试/重放，finally 后四会话 closed、八类活动资源归零。复杂表单 unknown 连续复现、Batch 9 出现 deadline 失败，说明端到端稳定性仍不满足生产要求。

### 第三方只读冒烟

Wikipedia 首页 target 成功绑定并以 `browser-cdp`、`host-app-scoped` 观察；semanticTree 包含搜索控件和欢迎内容。Agent 在 step 0 错误报告 canonical visible state 不可用，未执行动作，结果 0/1；会话释放且资源归零。第三方结果不与本地 Lab 成功率合并。

## 本轮发现并修复的通用缺陷

1. 并发截图读取在 3 秒超时下偶发 `BACKEND_UNAVAILABLE`。只把只读 capture 的超时放宽到与动作超时一致的 10 秒；不改变动作次数，也不重试 click/key。
2. `action=answer` 原来无条件映射为 done。现在显式 `status=failure` 或以 `Failure:` 开头的回答映射为 `agent_reported_fail`，避免未完成任务假报成功。
3. CDP 已提供非空 semanticTree 时，模型仍可能声称可见状态不可用。现在提示明确最新非空树是 target-bound canonical state，必须据此继续流程和最终验证。
4. Web Task Lab 原先没有公开权威成功判据，测试提示可能漂移。v2 ready 契约为每个任务公开状态与语义文本 oracle。
5. Agent 曾把 `target` 错放进 parallel child。运行时继续 strict 拒绝；MCP 工具描述与 JSON Schema 现在明确 child 只用 `sessionId` 引用 immutable binding，绝不在 child 重传 target。
6. 动作完成后若下一次模型调用达到 deadline，`TIMEOUT` 错误原来丢失已发生动作的 trace。现在仍返回失败且不重试，但 error details 与 batch evidence 保留已有 steps、committed/verification、finalRevision 和 provider-redacted semanticTree。

## 自动化与故障证据

- 修复前真实 CDP 故障矩阵累计 99/100；唯一失败是高争用下只读 screenshot capture 超时。该失败不涉及动作重放。
- 修复后真实 CDP 故障矩阵累计 550/550（55 轮 × 10 项）。覆盖真实 transport/auth、三目标并发、parent cancel、目标丢失幸存者、post-dispatch 丢包的 unknown outcome 和资源清理。一次尝试运行 50 轮的命令被外层 15 分钟工具预算截断，因无完整计数而没有并入 550 项。
- 最新 partial trace 修复后真实 CDP/UIA/mixed 集成先单轮 18/18，再重复 5 轮 90/90，合计 108/108。
- Python：255 passed, 21 skipped；Ruff F/E9 通过。
- Python 全量 soak：前两轮 510/510 后，第 3 轮出现一次 Windows loopback `WinError 10053`；对应 model-access HTTP 用例随后 50/50 定向转绿。另一组全量确认首轮 255/255，第二轮出现一次 reaper failed-close retry 竞态（期望 `TIMEOUT`，实际 `REQUEST_NOT_FOUND`）；对应生命周期用例随后 100/100 定向转绿。两次低频失败均保留，不计为全量 soak 通过。
- Computer Use domain：96 passed；typecheck 通过。
- Web Task Lab：5 passed。
- managed multisession harness/evidence：9 passed。
- Host gateway/Codex lifecycle：148 passed；扩展相关 Host 集合：153 passed。
- capability governance：17 packages / 175 actions，无架构旁路。
- Node/Web/Domain SDK typecheck 通过；Electron main/preload/renderer build 通过。
- 17/17 domain package 逐包 typecheck 通过。根 `npm run typecheck` 仍在已知 Windows 基线处停止：仓库随附 Workspace Host Node runtime 不可执行；前三个 agent-support build 已通过。聚合 `domain-packages:typecheck` 还会输出 `spawnSync npm.cmd EINVAL` 却错误返回 0，因此本报告只采用逐包真实结果。
- Domain SDK：86 passed, 1 failed；唯一失败是 Windows 创建 symlink fixture 的 `EPERM`，未进入 Computer Use 业务逻辑。

## 已证明与未证明

已证明：

- 不同测试拥有 BrowserContext 可独立绑定、观察、动作、验证与释放；未观察到跨页状态污染。
- click/key 未因导航销毁 execution context 被重放；只读 readback 可以有界重试。
- Enter 导航可由 URL 或 semanticTree 变化返回 `verified`。
- cancel、target loss、transport loss 与上游失败不会阻塞其他 child；unknown outcome 保持不重放。
- 多个真实批次结束后 sessions、requests、active leases/channels/requests、cleanup pending、waiters、backend handles 全部归零。

未证明：

- 没有达到可承诺的端到端成功率或延迟 SLO。
- 本轮四路 Agent 批次有执行区间重叠，但动作时间戳没有重叠；不能把它描述为四个动作真实同时发生。
- 未覆盖真实登录、验证码、真实权限升级、上传文件选择器、真实业务数据或不可逆操作。
- 第三方网站只读冒烟失败，不能外推到开放互联网的稳定成功率。
- 未覆盖大规模、多小时无间断的模型端到端任务成功率；底层 soak 不能替代 Agent 任务 soak。

## 最终状态

本测试分支相对基线的语义提交顺序如下；最后另有包含本报告的文档提交。最终 HEAD 以结束时 `git rev-parse HEAD` 与外部持续 Worklog 为准。

1. `test(computer-use): add production readiness web lab`
2. `fix(computer-use): tolerate bounded CDP capture contention`
3. `fix(computer-use): reject explicit failed answers`
4. `fix(computer-use): trust canonical CDP semantic state`
5. `test(computer-use): publish web task success oracles`
6. `test(computer-use): align web task terminal oracles`
7. `fix(computer-use): clarify parallel bound targets`
8. `fix(computer-use): preserve partial timeout evidence`

测试结束时必须停止测试拥有的 SciForge/sidecar/router/Lab/Chromium 进程并核对端口、临时 profile、Git 状态。PR #62 与 PR #57 只做只读核对，不创建、更新或推送任何 PR。
