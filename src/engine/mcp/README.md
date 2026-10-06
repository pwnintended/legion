# mcp

Legion MCP server (architecture §7): `@modelcontextprotocol/sdk` streamable HTTP on `127.0.0.1:<random port>`,
one bearer token per agent session (token → `{ runId, taskId, attemptId, role }`).

Tools: `report_progress`, `request_human_input`, `approve` (Claude's permission prompt tool; returns
`{behavior:"allow", updatedInput}` / `{behavior:"deny", message}`), `mark_task_done`. Blocking tools create
inbox items through the Store and wait for `inbox.resolve`. Exposes `{ url, token }` as `McpConnection`.
