# Computer Use domain

This package owns the Computer Use MCP binding and its public v1 compatibility
contract. PR2 exposes only the existing `{ instruction }` tool and routes the
GUI-Owl worker through a host-approved, process-global Legacy input channel.
The package also owns its generic settings section, permission/status
capabilities, MCP launch contribution, and trusted invocation metadata rule.

Live input requires a Host-confirmed invocation and one process-global lease.
Success, failure, timeout, and cancellation close the request-owned channel;
failed cleanup retains ownership and the next run must reclaim it before new
ownership is granted. Requests for
`host-app-scoped` or `agent-isolated` isolation fail closed. Target-scoped CDP
support belongs to the next stacked layer and is not present here.
