# mcp

Legion MCP server (architecture §7): `@modelcontextprotocol/sdk` streamable HTTP on `127.0.0.1:<random port>/mcp`,
one bearer token per agent session (token → `{ runId, taskId, attemptId, role, parentAttemptId }`).

- `startMcpServer({ host: McpHost, port? }) → { url, port, issueToken(binding), revokeToken(token), close() }`
- Stateless transport (fresh server per POST, no `Mcp-Session-Id`; GET/DELETE → 405). Responses are SSE with a
  15s keep-alive comment, and Node's request/socket timeouts are disabled, so `request_human_input`
  can wait for hours. The client side limits then apply: set `MCP_TOOL_TIMEOUT` (ms) for Claude Code and
  `tool_timeout_sec` for Codex (`codexMcpConfigOverrides` defaults to 24h).
- Tools: `report_progress`, `request_human_input`, `approve`, `mark_task_done` (coder/resolver only); for attempts with
  a `parentAttemptId` or a role in `COORDINATOR_ROLES`: `list_agents`, `send_message`, `wait_for_reply`, and (with a
  parent) `ask_lead`. The host (`McpHost.listAgents/sendMessage/awaitMessage`) enforces the parent ↔ child rule
  (`orchestrator/core/messaging.ts`, architecture §7).
  Host errors become MCP tool errors (`isError`). `approve` is an unused fallback: both adapters receive tool
  approvals in-band (Claude `--permission-prompt-tool stdio`, Codex `requestApproval` server requests), so no
  CLI is configured to call it. The orchestrator still implements it (routes it to an `approval` inbox item).
- `revokeToken` also drops that token's in-flight requests (the agent sees a connection error).
- `config.ts`: `claudeMcpConfig(url, token)` and `codexMcpConfigOverrides(url, envVarName)` for adapters.
