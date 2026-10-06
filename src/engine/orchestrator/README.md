# orchestrator

The run lifecycle service (architecture §8, details in §8.1): clarify → plan → DAG validation → approval →
dispatch → per-task driver (provision, code, verify, cross-engine review, fix rounds) → serialized merge queue →
finalize → PR. Crash recovery (§9). The pure decision logic lives in `core/` (see `core/README.md`); this layer
applies it with CAS transitions through `Store`, runs git through `engine/git`, and drives agents.

| File | |
|---|---|
| `orchestrator.ts` | `Orchestrator`: shared state, `openSession` (attempt row, MCP token, env), usage/budget, rate limits, inbox helpers, `applyDecision`, the dispatch `tick`, the `McpHost` |
| `live-session.ts` | `AgentRun`: one agent process bound to one attempt; turn results, takeover / hand-back |
| `planner.ts` | `runs.create`, clarify, plan (validation retries), plan versions, revision, approval |
| `tasks.ts` | the per-task driver (re-entrant by task status) |
| `merge.ts` | merge queue, conflict resolution (lockfiles, resolver sessions) |
| `finalize.ts` | integration verify, final review, PR text, `runs.createPr` |
| `cleanup.ts` | `runs.refreshPr` + polling of open PRs, `runs.archive` (§8 step 9; auto on PR merged/closed) |
| `actions.ts` | human actions: pause/resume/cancel, `tasks.*`, `inbox.resolve` effects |
| `sessions.ts` | `sessions.send/interrupt/takeover`, attempt terminals |
| `diff.ts` | `diff.get` |
| `recovery.ts` | crash recovery on engine start |
| `registry.ts` | `EngineRegistry` (Claude, Codex, fakes; probes, usability) |
| `pr-host.ts` | `PrHost` (`ghPrHost` for the app, `FakePrHost` for tests and demo mode) |
| `demo.ts` | the scripted agent of `LEGION_FAKE_ENGINES=1` |
| `meta.ts` | persisted bookkeeping (`run:<id>` / `task:<id>` in the settings key/value table) |
| `handlers.ts` | RPC procedures |
| `test-harness.ts` | test-only: temp repo + bare origin, fake engines standing in for Claude/Codex, RPC client |

Wiring is in `engine/index.ts` (`createOrchestrator`, MCP server, terminals, `recover`). Tests: `lifecycle.test.ts`
(end to end on a real repo), `service.test.ts`, `accounting.test.ts`, `finish.test.ts` (plan annotations, PR status,
archive, task reports, same-engine review, live engine settings), `demo.test.ts` (fake mode end to end); `run.live.test.ts` runs a tiny real run with
`pnpm test:live` (Claude haiku coders, Codex low-effort reviewer, stops at `pr_ready`).
