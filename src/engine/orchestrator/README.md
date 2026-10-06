# orchestrator

Run lifecycle (architecture §8): clarify → plan → DAG validation (`dag.ts`) → approval → scheduler
(`scheduler.ts`, concurrency caps from `Settings`) → verify → cross-engine review → fix loop → merge
queue → finalize → PR. Prompts live in `prompts/`. Recovery on engine start (§9).

All state changes go through `Store` (`engine/db`): `transitionRun/Task/Attempt` (CAS + event in one
transaction). Agent events are persisted with `Store.appendAgentEvent`. Implements most `runs.*`,
`tasks.*`, `inbox.*`, `sessions.*` procedures via `server.implement(...)` in a `register*Handlers` function.

The pure decision logic (plan validation, graph utilities, estimates, `planDispatch`, task status policy,
prompt builders) lives in `core/`; see `core/README.md` for its API.
