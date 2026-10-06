# mcp

Legion MCP server (architecture §7): `@modelcontextprotocol/sdk` streamable HTTP on `127.0.0.1:<random port>/mcp`,
one bearer token per agent session (token → `{ runId, taskId, attemptId, role }`).

- `startMcpServer({ host: McpHost, port? }) → { url, port, issueToken(binding), revokeToken(token), close() }`
- Stateless transport (fresh server per POST, no `Mcp-Session-Id`; GET/DELETE → 405). Responses are SSE with a
  15s keep-alive comment, and Node's request/socket timeouts are disabled, so `request_human_input` / `approve`
  can wait for hours. The client side limits then apply: set `MCP_TOOL_TIMEOUT` (ms) for Claude Code and
  `tool_timeout_sec` for Codex (`codexMcpConfigOverrides` defaults to 24h).
- Tools: `report_progress`, `request_human_input`, `approve`, `mark_task_done` (coder/resolver only).
  Host errors become MCP tool errors (`isError`).
- `revokeToken` also drops that token's in-flight requests (the agent sees a connection error).
- `config.ts`: `claudeMcpConfig(url, token)` and `codexMcpConfigOverrides(url, envVarName)` for adapters.
