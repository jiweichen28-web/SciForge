# Computer Use CDP 可靠性证据流程

本流程只验证测试拥有的 headless Microsoft Edge `browser-page` target，不能替代真实
SciForge 产品 smoke，也不代表 Electron webContents、frame、Windows input desktop、
UIA、AX、Remote Worker 或 isolated desktop 已验证。禁止连接用户浏览器 profile。

## 自动回归

```powershell
npm run computer-use:cdp-reliability:test
npm --workspace @sciforge/domain-computer-use test
E:\Research\parttime\03_AI\03_shanghai_ailab_bio_prep\.venv-cua\Scripts\python.exe `
  -m pytest packages/workers/gui-owl-computer-use/tests -q
```

domain 的 headless integration 会创建临时 HTTP 页面和测试拥有的 Edge，经过正式
adapter HTTP API 与 Playwright CDP 验证两个 target、stale observation 的 dispatch 前
拒绝、一个 target 丢失时 survivor 继续 readback、attached handle release 不关闭邻页，
最后确认 adapter handle 为零。fixture 的 browser、profile、端口和临时目录必须在
`finally` 中关闭。

Python lifecycle 测试直接驱动 `ComputerUseService -> SessionRegistry -> BackendRouter ->
SessionInputChannel -> CdpAdapterBackend` 的实际 map；仅最末端 backend transport 使用
可控测试替身。门禁包含 bounded parallel、parent 注册窗口取消、exact-child 取消、
cancel delivery failure、target loss、planner deadline partial trace、transport loss、
cleanup quarantine/reclaim，以及重复成功/失败后资源回 baseline。

## 脱敏证据包

原始 capture 只放临时目录，不得提交。它必须包含：

- `runId`、固定的 `capturedAt`；
- `source.commit` 完整 40 位 SHA；
- platform、arch、Node、Python 版本；
- browser name/version，且 `testOwned=true`、`headless=true`；
- 一次 bounded batch 的原始 ServiceResult；
- 每个 child 对应的成功 release 与 targetId；
- 最终 sidecar status。

最终 status 的八类活动资源必须全部为 0：`sessions`、`requests`、`activeLeases`、
`activeChannels`、`activeRequests`、`cleanupPending`、`waiters`、`backendHandles`。
当前 runtime 不实现 queue，`waiters=0` 是显式合同，不是未统计。当前真实 headless
integration 使用同一测试拥有 browser context 内的两个独立 page target；它不证明
多个 BrowserContext 或 OS 级隔离。

```powershell
npm run computer-use:cdp-reliability:evidence -- `
  --input .tmp\cua-reliability\capture.json `
  --output-dir outputs\computer-use-cdp-reliability
```

导出器 fail closed 拒绝重复 session/target/request、串行伪并发、未验证成功动作、
release 不完整、隔离降级和任何非零活动资源。Authorization、token、secret、API key、
cookie/storage、CDP endpoint、URL、截图和本地路径会被删除或脱敏。输出固定为：

- `computer-use-cdp-reliability-evidence.json`；
- `computer-use-cdp-reliability-sha256.json`。

manifest 记录 evidence 文件的字节数与 SHA256。相同 capture 必须生成逐字节相同的
evidence 与 manifest。可用 `Get-FileHash -Algorithm SHA256` 独立复核。导出后删除原始
capture、临时 browser profile 和 runtime 目录，只保留脱敏产物。
