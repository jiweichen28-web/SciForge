# Computer Use 三小时 post-dispatch 可靠性定向开发补充报告

日期：2026-08-12（Asia/Shanghai）

## 1. 基线与边界

- 工作树：`SciForge-computer-use-runtime-e2e`
- 起始 HEAD：`096a97144cbed223e25c16ee479a45c5ca2f6566`
- 不可变六小时分支：本地及 fork 的 `test/6h-production-readiness` 均保持 `37b129974b3054d09220e53552bdd1c964847e55`，未修改其历史或 HEAD。
- 本轮分支：`fix/3h-post-dispatch-reliability`
- 代码提交：`18b6a66a fix(computer-use): classify post-dispatch transport failures`
- 未 push，未创建、更新或评论 PR，未操作 PR #57 或 PR #62。

## 2. 可控 post-dispatch unknown：真实 CDP 原始结果

使用测试拥有的临时 Edge、独立 BrowserContext、真实 CDP adapter 和丢响应代理，通过正式 `run_task` 链执行三个确定性动作。代理仅在第三个写动作已由 adapter 提交后丢弃一次响应。

- 协议结果仍为 `ACTION_OUTCOME_UNKNOWN`，`retryable=false`；没有被页面变化改写为成功。
- 前两个动作完成；第三个 type 动作只转发一次，adapter 权威状态变为 `committed-without-response`，但调用方没有收到 action receipt。
- `stepCount=3`，unknown step 保留在 partial trace 中，`verification=unknown`、`committed=false`、`mayHaveTakenEffect=true`。
- unknown 后只执行一次 target-scoped `unknown_readback`；完成后 final revision 为 `cdp:7`。只读结果记录页面已变化，但没有追认写动作成功或 verified。
- 阶段顺序为 `observe -> planner_wait -> action_dispatch -> readback -> planner_wait -> action_dispatch -> readback -> planner_wait -> action_dispatch -> unknown_readback`；各阶段单调时间有效，request/target 关联一致。
- finally 后 lease 与 cleanup pending 为 0；真实 CDP 完整集成文件最终 `10 passed`。

该复现把 unknown 明确定位为：动作已进入 dispatch、请求到达 adapter/backend 并实际提交，但 adapter HTTP 响应在返回调用方前丢失。它不是 planner 等待、observe、dispatch 前失败、verification 或 Host 审批失败。

## 3. 明确根因与小型通用修复

修复前，CDP action transport 失败被压平为无 code 的通用 `BackendOperationError`。虽然安全语义正确地返回 unknown，但时间线无法区分“未收到 adapter 响应”“收到但响应不可解析”和“adapter 返回结构化错误”。

本轮最小修复：

1. 增加内部 `CdpAdapterTransportError`，记录是否收到 HTTP 响应。
2. action 请求未收到响应时，unknown 证据带 `backendCode=ACTION_TRANSPORT_FAILED`、`transportStage=awaiting-action-response`、`adapterResponseReceived=false`、`requestMayHaveReachedAdapter=true`。
3. 已收到但无法解析的 action 响应标记为 `transportStage=parsing-action-response`、`adapterResponseReceived=true`；adapter 的结构化错误标记为 `transportStage=adapter-response`。
4. `BackendOperationError` 和 channel unknown details 保留上述 `backendDetails`，使 runner partial trace 可以直接定位 transport 边界。

安全语义没有变化：写动作未知时不重试、不重放；只允许一次只读 readback；顶层错误仍为 `ACTION_OUTCOME_UNKNOWN`；页面变化仍不能把未知写动作改判为成功。

## 4. 复杂表单新鲜状态真实复现

启动全新独立 SciForge、sidecar、router、自动 composite CDP adapter、测试 Lab 和 BrowserContext。外层使用 Codex in-app Browser 控制同一 renderer；新建内层 Agent 后先确认 Med。使用唯一合成值，只批准一次 `computer_use`，并在 finally 中 release。

- 协议结果：`stuck_repeated_action`，不是 `ACTION_OUTCOME_UNKNOWN`。
- 动作转发：6 次；第 7 步在 dispatch 前被重复动作保护终止，因此没有第 7 次 backend action。
- 已执行步骤：输入框 click/type 前两步 verified；随后四个 click 中一个 verified、三个 unverified。planner 在两个坐标间反复选择，未推进到可靠 submit。
- 阶段定位：初始 observe 完成；一次 planner attempt 失败后在任何对应动作派发前安全重试；其余 planner/action dispatch/readback 均有完整时间线。终止点位于下一动作生成后的重复动作检测，不是 transport、adapter/backend 或 unknown readback。
- Lab 权威状态：`Not submitted`；final revision `cdp:13`，semanticTree 仍包含表单和 `Not submitted` output。
- 没有第二次写任务，没有动作重放，没有 Legacy、降级或宿主全局输入。
- finally release 成功；release 后 sessions、requests、active leases、active channels、active requests、cleanup pending、waiters、backend handles 八类均为 0。

该结果暴露的是通用 planner 非进展问题，但本轮没有足够证据支持小型执行语义修复，因此没有针对 Gamma 文案、坐标、控件或页面结构增加补丁。

## 5. 自动化与门禁

- Computer Use Python：`255 passed, 21 skipped`。
- 新增 transport/channel 定向测试：`31 passed`。
- 真实 CDP 集成：`10 passed`。
- Ruff F/E9：通过。
- Computer Use domain：`97 passed`；typecheck 通过。
- Host MCP gateway：`25 passed`。
- multisession/evidence：`9 passed`。
- capability check：17 packages / 175 actions，通过且无架构旁路。
- 首轮 Python 全量曾出现一次 Windows loopback `WinError 10053`；该单例定向复跑通过，随后全量 `255 passed, 21 skipped`，归类为宿主瞬时事件。
- `git diff --check`：通过；敏感字面量扫描无命中。

## 6. 未解决问题与下一步

- 复杂表单当前可复现为 planner 在控件间非进展并触发 `stuck_repeated_action`，而不是 unknown。下一轮应比较每次 planner 输入中的 screenshot、semanticTree、viewport/scroll 与 readback，定位为何已执行动作没有带来可利用的规划状态变化；根因明确前不改成功判定或写动作重试语义。
- 本轮没有重新运行真实 timeout Agent E2E；上一轮报告已证明 TIMEOUT partial trace、final readback 与八类清零。本轮 full Python 和真实 CDP 回归继续覆盖其契约，但不把它表述为新的生产链原始结果。
- 本轮没有重新运行 parallel[4] Agent 批次，也没有进行并发架构重写。

## 7. 资源清理

所有真实 Agent Session 已 finally release。测试拥有的 SciForge、sidecar、router、adapter、Lab、Edge/BrowserContext 与内层 Codex 子进程均已停止；本轮临时 runtime/profile 目录已删除。最终端口、进程与工作树状态以提交后的收口核对为准。
