# engine/claude

Claude Code CLI adapter: implements `AgentEngine` (`../types.ts`) by spawning the account's binary
(`EngineAccount.command` resolved on the merged env's `PATH`, no shell, `account.args` first; verified against
2.1.289–2.1.310) with
`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` and
translating stream-json + control-protocol frames into normalized `AgentEvent`s. No Agent SDK;
the control-protocol shapes follow the published `@anthropic-ai/claude-agent-sdk` 0.3.292 sources.

- `args.ts`: pure flag builder: model/effort/system prompt/`--json-schema`, permission mode → flags, MCP config, config isolation, child env (process → account → session, parent-session vars stripped)
- `parser.ts`: pure stream-json → `AgentEvent` normalizer (+ control frames as `ParserOutput`)
- `protocol.ts`: stdin messages: user turns, interrupt, `can_use_tool` answers
- `read-only-policy.ts`: host-side answers for read-only sessions' `can_use_tool` requests: read tools, version/help probes and plain reads pass (chains parsed strictly), the rest is denied with a message; no human involved. `READ_ONLY_GUIDE` states the rules in the system prompt
- `session.ts`: one process = one `AgentSession`: stdin open for the session's lifetime, delta coalescing, interrupt/close escalation
- `engine.ts`: `ClaudeEngine(account)`: binary resolution, `probe()` (`--version` + `auth status --json` under the account env, so `CLAUDE_CONFIG_DIR` picks the account), `start`/`resume`
- `testing.ts`: test-only: `FakeChild`, fixture replay, recording spawn, account/schema helpers
- `fixtures/*.jsonl`: sanitized live transcripts (`{dir: in/out/exit}` lines), replayed by the unit tests

## Behaviour callers rely on

- **Session id**: `start()` pre-assigns a UUID (`--session-id`), so `session.id` is known immediately; `resume(id)`
  keeps the same id (no fork). `session_started` is emitted once even though the CLI repeats `system/init` per turn.
- **Turns**: one `turn_complete` per user turn. `reason`: `null` (ok), `interrupted`, `missing_structured_output`,
  a result subtype (`error_max_structured_output_retries`, `error_max_turns`, `error_during_execution`, …),
  `api_error_<status>`, or `process_exited` (crash mid-turn). Errors come with an `error{retryable}` event first;
  schema failures and 408/429/5xx/529 are retryable. `system/api_retry` → `error{retryable: true}` (informational,
  the CLI retries by itself).
- **Limits**: a failing `result` for an account out of quota (a `rate_limit_event` with `status: "rejected"` and not
  `isUsingOverage`, `api_error_status` 429, or text like `usage limit` / `Claude AI usage limit reached|<epoch s>`)
  emits `limit_reached{kind, resetsAt (ms), message}` just before the `error`. `api_retry` 429 does not.
- **Usage is cumulative**: `usage` events carry running session totals (tokens incl. cache reads/creation, and
  `costUsd`), including the spend of earlier processes of a resumed session. Take the latest; never sum.
  Interrupted turns may report zeros; those are not emitted. Cost is the CLI's estimate.
- **Read-only sessions** run in `default` mode with the prompt tool and never
  emit `approval_request`: the session answers `can_use_tool` itself via `read-only-policy.ts` (`dontAsk` would deny any chain
  holding a command outside the CLI's fixed, non-configurable read-only set, e.g. `npm -v`).
- **Approvals** are in-band (`--permission-prompt-tool stdio`): `approval_request.requestId` is the CLI's
  control request id; answer with `respond()`. Pending approvals are dropped when the turn ends or the CLI
  withdraws them (`control_cancel_request`), after which `respond()` throws.
- **send(text, 'now')** interrupts the running turn (CLI capability `interrupt_send_now_v1`); `'next'` queues it
  (folded into the running turn after its current tool, or starts a new turn when idle). With
  `--replay-user-messages` the CLI echoes each message when it takes it in. A message still unechoed when a turn
  ends (sent while the model thought or wrote its structured output, with no tool call after) runs as a turn of
  its own right away: the session holds the first result and reports the two as one turn, so a structured step
  gets the answer that took the message into account (`HELD_RESULT_MS` safety net).
- **MCP**: `SessionOptions.mcp` is written to a 0600 temp `--mcp-config` file (removed on exit) and its servers
  are allowed by name (`mcp__<name>`). `--strict-mcp-config` unless `userSettings`.
- **setApprovals('auto' | 'ask')** (`ClaudeSession` only): `set_permission_mode` control request (`auto` / `acceptEdits`). `workspace_write`
  sessions start in `acceptEdits` and switch to `auto` when `permission.approvals` is `auto`: a model without auto
  mode refuses the switch and keeps asking, where `--permission-mode auto` would silently fall back to `default`.
- **interrupt()**: `interrupt` control request → wait 5 s for the turn to end → SIGINT → wait 5 s → kill. The
  transcript stays resumable with `resume(session.id)`.
- **close()**: end stdin; idle sessions get 2 s to exit, busy ones are SIGTERMed at once; SIGKILL after 3 s.
- The internal `StructuredOutput` tool is hidden. Subagent text is dropped; subagent tool calls are kept.
- Unknown message types are logged once and ignored; unsupported CLI → host control requests are declined.

Live tests: `claude.live.test.ts` (haiku, ~$0.25 per run), gated on `LEGION_LIVE=1` and excluded from the default
vitest run (run them with a config that includes `*.live.test.ts`; `LEGION_CLAUDE_CONFIG_DIR` picks the account). `LEGION_RECORD_DIR=<dir>` records
the transcripts; sanitize them (paths, account, thinking signatures) before adding them to `fixtures/`.
