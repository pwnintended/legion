# adapters/codex

Codex adapter: implements `AgentEngine` (`@shared/engine`) over `codex app-server` (JSON-RPC 2.0, JSONL on
stdio), one child process per session. Verified live against codex-cli 0.160.0.

```ts
const codex = new CodexEngine({ codexHome: join(dataDir, 'codex-home'), env, clientVersion });
await codex.probe();                       // version, loggedIn, account label, models (no turn)
const s = await codex.start(opts);         // resolves after initialize + thread/start + turn/start
await codex.resume(threadId, opts);        // thread/resume (same codexHome!) + turn/start(opts.prompt)
```

| File | |
|---|---|
| `index.ts` | `CodexEngine` (start/resume/probe) |
| `session.ts` | `CodexSession`: process lifecycle, turns, approvals, delta coalescing |
| `normalize.ts` | notifications → `AgentEvent`; approval requests ↔ `ApprovalDecision` (pure) |
| `json-rpc.ts` | `JsonRpcPeer` + `LineSplitter` (pure, transport-agnostic) |
| `config.ts` | binary resolution, CODEX_HOME isolation, permission → sandbox/approval, MCP config |
| `methods.ts` | the protocol subset Legion uses, typed with `protocol/` (generated, see its README) |
| `fixtures/` | sanitized live transcripts + `replay-app-server.mjs` (fake app-server for session tests) |

## Protocol (verified)

- Handshake: `initialize {clientInfo:{name:'legion',title,version}, capabilities:{experimentalApi:true,
  requestAttestation:false}}` → `{userAgent:'legion/0.160.0 (...)', codexHome, ...}`, then notification
  `initialized`. No `jsonrpc` member on the wire. Server-request ids are numbers starting at **0**.
- `thread/start {cwd, model, sandbox, approvalPolicy, approvalsReviewer:'user', config, developerInstructions}`
  → `{thread:{id}, model, ...}`. `thread/started` arrives *after* the response and `thread/resume` sends
  none, so `session_started` is emitted from the response. `thread/resume {threadId, ..., excludeTurns:true}`
  (without `excludeTurns` codex emits a deprecation notice). Unknown id → error `-32600 no rollout found`.
- `turn/start {threadId, input:[{type:'text',text,text_elements:[]}], effort, outputSchema}` → `{turn:{id}}`.
  Effort and outputSchema are per turn; the session passes them on every turn.
- `turn/steer {threadId, input, expectedTurnId}` → `{turnId}`; `turn/interrupt {threadId, turnId}` → `{}`
  then `turn/completed` with `status:'interrupted'` (the running command gets **no** `item/completed`; the
  normalizer closes it). Both answer `-32600 no active turn to …` when idle.
- Approvals (server requests; the reply echoes the id, then `serverRequest/resolved` fires):
  `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` → `{decision: 'accept' |
  'acceptForSession' | 'decline' | 'cancel'}` (cancel = also interrupt the turn);
  `item/permissions/requestApproval` → `{permissions, scope:'turn'|'session'}`; `item/tool/requestUserInput`
  → `{answers:{id:{answers:[]}}}`; `mcpServer/elicitation/request` → `{action, content, _meta}`; legacy
  `execCommandApproval`/`applyPatchApproval` → `ReviewDecision`. All become `approval_request` (requestId =
  `String(id)`). `currentTime/read` is answered; anything else (`item/tool/call`,
  `account/chatgptAuthTokens/refresh`, `attestation/generate`, unknown) gets a `-32601` error reply.
- Commands whose `commandActions` all match `permission.allowedCommands` (exact or `prefix + ' '`) are
  accepted without asking.
- MCP: thread `config.mcp_servers.legion = {url, bearer_token_env_var:'LEGION_MCP_TOKEN',
  default_tools_approval_mode:'approve', tool_timeout_sec: 86400}` works inline on `thread/start` (no `-c`
  needed); the token is set only in the child env. The 24 h tool timeout lets `request_human_input` block
  until a human answers (the server never times out; Claude gets the same via `MCP_TOOL_TIMEOUT`).

## Config isolation

`codex app-server` has no `--ignore-user-config`/`--ignore-rules` (those are `exec` flags). Legion runs it
with a **Legion-owned `CODEX_HOME`** whose only content from the user is `auth.json`, as a **symlink** to
`~/.codex/auth.json` (or `$CODEX_HOME/auth.json`). Evidence:

- Login works: `account/read` → `chatgpt`/`pro` and all live turns ran with the user's ChatGPT login.
- Token refresh: codex writes auth.json in place — a `codex login --with-api-key` with a dummy key in a
  temp home whose auth.json was a symlink updated the link target and kept the symlink. Refreshed tokens
  therefore land in the user's real file (a copied auth.json would fork the refresh token and could log
  the user's own CLI out).
- No leakage: no `hook/*` notifications, `instructionSources: []` (no ~/.codex/AGENTS.md), the user's
  `approvals_reviewer = "auto_review"` and `notify` no longer apply, and Legion threads are stored in the
  Legion home, not `~/.codex/sessions`.

Also passed on the command line: `-c features.{hooks,apps,plugins,remote_plugin,memories,computer_use,
browser_use,image_generation}=false`. Fallback when the user has no auth.json (keyring store) and no API
key env: the user's own CODEX_HOME (still with those features disabled). A human takeover via
`codex resume <threadId>` must use `CODEX_HOME=<legion codex home>`.

## Event mapping notes

- `usage` carries the thread's **cumulative** totals (`thread/tokenUsage/updated.total`), several per turn:
  treat as "latest value", don't sum. `costUsd` is always null.
- `rate_limit`: primary/secondary windows (`300` min → `5h`, `10080` → `weekly`), `resetsAt` converted from
  seconds to ms, duplicates dropped.
- `file_change` comes from apply_patch (`fileChange` items) only; files written by shell commands appear as
  `tool_call` kind `command`. Paths inside cwd are relative.
- `turn_complete.structuredOutput` = the turn's final agent message parsed as JSON when the session has an
  `outputSchema`; unparsable → `error{retryable:true}` + `turn_complete{isError:true}`.
- Notifications from other threads (sub-agents) are ignored.
- `send(text)` steers the active turn (`next`), or interrupts it first (`now`); when idle it starts a new turn.
