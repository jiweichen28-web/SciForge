# Computer Use domain

This package owns the Computer Use MCP binding, its stable `{ instruction }`
compatibility call, and the target-scoped CDP browser backend. It also owns the
generic settings/status capabilities, MCP launch contribution, trusted
invocation metadata rule, CDP adapter lifecycle, and Agent planner bridge.

The managed MCP exposes capability/target discovery, target bind, run, and
release. Bind/run/release require Host-trusted approval metadata. A bound
browser page gets a canonical ID and generation plus one target lease; every
observation, action, navigation readback, and verification stays on that exact
page. There is no CDP-to-PyAutoGUI fallback. The old `{ instruction }` call
continues through the host-approved process-global Legacy channel.

The planner bridge calls the Host's active Agent runtime through
`runEphemeral`, with no hard-coded Codex or Claude selection and no tools. It
requires the bound target's bounded canonical semantic observation and uses
Ajv to validate the declared forced-function schema and returned arguments
before any backend action is dispatched.

Set `SCIFORGE_CUA_CDP_ENDPOINTS` in the GUI process to a comma-separated
allowlist of credential-free loopback CDP endpoints owned by the operator or
the application. The domain starts an authenticated loopback adapter and
registers it with the authenticated sidecar. Do not point it at a user browser
profile. Startup, cancellation, release, and shutdown retain or reclaim
ownership on cleanup failure; post-dispatch transport loss is reported as
`ACTION_OUTCOME_UNKNOWN`, is never replayed, and permits only one bounded
target-scoped readback.

This layer supports attached Playwright `browser-page` targets. UIA, macOS AX,
Remote Worker, isolated desktop, and concurrent multi-session orchestration are
outside this package layer.
