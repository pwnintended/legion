# adapters/claude

Claude Code CLI adapter: implements `AgentEngine` (`@shared/engine`) by spawning the user's `claude`
binary (resolved from `SessionOptions.env.PATH`; verified against 2.1.289) with
`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` and
translating stream-json + control-protocol frames into normalized `AgentEvent`s (architecture §6). No Agent SDK;
the control-protocol shapes follow the published `@anthropic-ai/claude-agent-sdk` 0.3.292 sources.

| File | |
|---|---|
| `args.ts` | pure flag builder: model/effort/system prompt/`--json-schema`, permission profile → flags, config isolation, child env scrubbing |
| `parser.ts` | pure stream-json → `AgentEvent` normalizer (+ control frames as `ParserOutput`) |
| `protocol.ts` | stdin messages: user turns, interrupt, `can_use_tool` answers |
| `read-only-policy.ts` | host-side answers for read-only roles' `can_use_tool` requests: version/help probes and plain reads pass (chains parsed strictly), the rest is denied with a message; no human involved |
| `session.ts` | one process = one `AgentSession`: stdin open for the session's lifetime, delta coalescing, interrupt/close escalation |
| `engine.ts` | `ClaudeEngine`: binary resolution, `probe()` (`--version` + `auth status --json`), `start`/`resume` |
| `testing.ts` | test-only: `FakeChild`, fixture replay, recording spawn |
| `fixtures/*.jsonl` | sanitized live transcripts (`{dir: in|out|exit}` lines), replayed by the unit tests |

## Behaviour the orchestrator relies on

- **Session id**: `start()` pre-assigns a UUID (`--session-id`), so `session.id` is known immediately; `resume(id)`
  keeps the same id (no fork). `session_started` is emitted once even though the CLI repeats `system/init` per turn.
- **Turns**: one `turn_complete` per user turn. `reason`: `null` (ok), `interrupted`, `missing_structured_output`,
  a result subtype (`error_max_structured_output_retries`, `error_max_turns`, `error_during_execution`, …),
  `api_error_<status>`, or `process_exited` (crash mid-turn). Errors come with an `error{retryable}` event first;
  schema failures and 408/429/5xx/529 are retryable. `system/api_retry` → `error{retryable: true}` (informational,
  the CLI retries by itself).
- **Usage is cumulative**: `usage` events carry running session totals (tokens incl. cache reads/creation, and
  `costUsd`), including the spend of earlier processes of a resumed session. Take the latest; never sum.
  Interrupted turns may report zeros; those are not emitted. Cost is the CLI's estimate.
- **Read-only roles** (planner, reviewer, finalizer, researcher) run in `default` mode with the prompt tool and never
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
- **setApprovals('auto' | 'ask')**: `set_permission_mode` control request (`auto` / `acceptEdits`). `workspace_write`
  sessions start in `acceptEdits` and switch to `auto` when `permission.approvals` is `auto`: a model without auto
  mode refuses the switch and keeps asking, where `--permission-mode auto` would silently fall back to `default`.
- **interrupt()**: `interrupt` control request → wait 5 s for the turn to end → SIGINT → wait 5 s → kill. The
  transcript stays resumable with `resume(session.id)`.
- **close()**: end stdin; idle sessions get 2 s to exit, busy ones are SIGTERMed at once; SIGKILL after 3 s.
- The internal `StructuredOutput` tool is hidden. Subagent text is dropped; subagent tool calls are kept.
- Unknown message types are logged once and ignored; unsupported CLI → host control requests are declined.

Live tests: `pnpm test:live` (`claude.live.test.ts`, haiku, ~$0.25 per run). `LEGION_RECORD_DIR=<dir>` records
the transcripts; sanitize them (paths, account, thinking signatures) before adding them to `fixtures/`.
