# @sciforge/gui-owl-computer-use

Computer Use execution worker with a target-scoped CDP browser backend and a
host-approved Legacy desktop compatibility backend.

For a bound CDP page, the worker supplies its canonical semantic observation to
the domain-owned planner bridge, which uses the Host's active Agent runtime in
one-shot background mode. The Legacy compatibility path continues to use the
app-owned Model Router for screenshot planning and grounding. Neither path
accepts direct upstream provider credentials.

```
                ┌──────────────────────────────────────────────┐
task ──▶        │  observe → routed model plans+grounds+decides → act → …    │
                │   model  → active Host Agent runtime (CDP) or Model Router  │
                │   act    → session/channel/router → CDP or Legacy backend   │
                └──────────────────────────────────────────────┘
```

The model is remote (it only sees screenshots + text); the executor runs locally
where the desktop is. No Linux VM required. This package does not ship model
weights. The development-only
[`server/serve-gui-owl-32b.sh`](server/serve-gui-owl-32b.sh) helper refuses to
start unless the operator explicitly opts in and supplies a licensed checkpoint.

## Relationship to the retired primitive MCP path

This worker is now the single computer-use path. The old
`@sciforge/computer-use` GUI-managed primitive MCP server has been retired, and
the Host no longer registers either retired server name.

All runtimes expose the same domain-managed Computer Use tools through the
`gui_owl_computer_use` MCP wrapper. That wrapper calls this HTTP sidecar. The
Host selects the active Agent runtime for CDP planning; the compatibility path
uses Model Router policy.

## Boundary (Servic_Module_Template.md / PROJECT_mcp.md)

- Returns a **`ServiceResult`** with status + trace + screenshot artifact refs —
  **never a final answer or completion truth**. The agent host decides if the
  task is truly done.
- **External side effects require approval**: dry-run by default. Real
  mouse/keyboard happens only when the call sets `execute=true` **and**
  `approve=true`, the worker was started with `CUA_ALLOW_EXECUTE=true`, **and**
  the domain MCP supplied the matching Host-trusted confirmed invocation;
  otherwise it returns `NEEDS_APPROVAL`. Direct HTTP and worker-native MCP
  callers cannot mint this approval identity.
- **HTTP sidecar auth**: all Computer Use status, discovery, lifecycle,
  configuration, run, and cancel routes require the configured bearer token via
  `CUA_SERVICE_TOKEN`. The GUI launcher generates a random token per start and
  passes it to the GUI-managed MCP wrapper as `SCIFORGE_CUA_SERVICE_TOKEN`.
- **Refs-first**: screenshots are written to disk and returned as artifact refs,
  never inlined into a tool result.
- **Model Router only**: computer-use and optional reflection share the local
  Model Router public alias (`sciforge-router` by default). This worker accepts
  no upstream provider URL, provider model name, provider header, or provider
  credential.

## Package layout

| Concern | File |
|---|---|
| Public contract (tool names, schemas, error codes, result mapping) | `cua/contract.py` |
| ServiceResult envelope | `cua/result.py` |
| Service core: the observe→plan→act→reflect loop, trace, safety | `cua/runner.py` |
| Grounding model driver (prompt, call, parse, coord mapping) | `cua/owl_agent.py` |
| Mobile-Agent-v3 reflector | `cua/reflector.py` |
| Env-driven config | `cua/config.py` |
| Session/request/target and process-global lease authority | `cua/session_registry.py` |
| Service lifecycle authority | `cua/service.py` |
| **MCP** stdio transport adapter | `cua/mcp_server.py` |
| **HTTP** ServiceResult sidecar | `cua/server.py` |
| Local entry (`--stdio` / `--http`) | `cua/cli.py` |
| Target-bound input channel and fail-closed router | `driver/channel.py`, `driver/router.py` |
| Host-approved compatibility backend | `driver/backends/legacy_pyautogui.py` |
| Target-scoped browser backend | `driver/backends/cdp_adapter.py` |
| Pure contract/result/parse tests | `tests/test_contract.py` |
| Service/registry/router/channel lifecycle tests | `tests/test_service_lifecycle.py`, `tests/test_cdp_service_lifecycle.py` |
| Development-only local model serve helper | `server/serve-gui-owl-32b.sh` |
| One-click launcher: Model Router config + service + SciForge GUI | `一键启动-computer-use.bat`, `启动-sciforge-computer-use.ps1` |
| Launcher secrets template (copy to `启动-secrets.local.ps1`) | `启动-secrets.example.ps1` |

Everything for the module lives in this one folder; see **Integration touchpoints**
below for the few unavoidable edits elsewhere in the app.

## Domain-managed MCP tools

- `computer_use_get_capabilities`
- `computer_use_list_targets`
- `computer_use_bind_target` — acquires one target-scoped session/lease
- `computer_use` — stable `{ instruction }`, one bound session, or a bounded
  `parallel` batch of two to eight unique bound sessions
- `computer_use_release_session`

The worker-native stdio tools remain an internal compatibility/debug surface;
the application uses the domain-managed wrapper and Host-trusted approvals.

The full machine-readable `ServiceResult` is returned as a compact JSON text
block alongside a one-line summary; screenshots stay as artifact refs.

Different bound CDP targets may run concurrently. Each target session permits
one active child request, the Legacy backend keeps one process-global request,
and parent/child cancellation never replays an action. Per-child `deadlineMs`
returns a partial trace when planning times out. Runtime status exposes
sessions, requests, active leases/channels/requests, cleanup pending, waiters
(always zero because this runtime has no queue), and backend handles.

The repeatable, test-owned headless-browser evidence procedure is documented in
[`docs/computer-use-cdp-reliability-evidence.zh-CN.md`](../../../docs/computer-use-cdp-reliability-evidence.zh-CN.md).

## Run

```bash
python -m pip install -r requirements.txt
export CUA_SERVICE_TOKEN=dev-local-token
export SCIFORGE_MODEL_ROUTER_BASE_URL=http://127.0.0.1:3892/v1
export SCIFORGE_MODEL_ROUTER_MODEL=sciforge-router
export SCIFORGE_MODEL_ROUTER_RUNTIME_API_KEY=replace-with-router-runtime-key

# MCP stdio server (worker-native contract; the app uses a managed wrapper):
python -m cua.cli --stdio

# HTTP sidecar (curl-able; what the GUI-managed MCP wrapper calls):
python -m cua.cli --http        # -> http://127.0.0.1:3900

# dry-run (safe): plan + ground against a static screen, no actions
curl -s localhost:3900/computer-use/run \
  -H "Authorization: Bearer $CUA_SERVICE_TOKEN" \
  -d '{"instruction":"click the Save button","imagePath":"some_ui.png"}'

# live execution is intentionally available only through SciForge's
# domain-owned computer_use MCP tool and its Host confirmation prompt.
```

Standalone service smoke test (no GUI): start `--http`, then
`python accept.py --task "open Notepad"` (add `--execute` for real actions).

To launch the **full SciForge GUI with this module wired in** (so the in-app
agent gets a `computer_use` tool), double-click `一键启动-computer-use.bat`
(or run `启动-sciforge-computer-use.ps1`) **in this folder**: it verifies
the local Model Router runtime key, starts this service, sets `SCIFORGE_CUA_SERVICE_URL`,
then runs `npm run dev` from the repo root.

## Integration touchpoints (outside this folder)

The module is self-contained here; the only edits elsewhere in the app are the
minimal wiring needed to expose it to the agent runtime:

| File | Why |
|---|---|
| `packages/domains/computer-use` | Domain-owned v1 MCP contract, launch contribution, and trusted invocation metadata rule |
| `src/main/modules/runtime-mcp-contributions.ts` | Generic Host composition for domain-provided MCP servers |

## Config

See [`.env.example`](.env.example). Key vars: `SCIFORGE_MODEL_ROUTER_BASE_URL`,
`SCIFORGE_MODEL_ROUTER_MODEL`, `SCIFORGE_MODEL_ROUTER_RUNTIME_API_KEY`,
`CUA_MAX_STEPS`, `CUA_REFLECT`, `CUA_ALLOW_EXECUTE`,
`CUA_PORT`, `CUA_SERVICE_TOKEN`, `CUA_ARTIFACT_DIR`.
