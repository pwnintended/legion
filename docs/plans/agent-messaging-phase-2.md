# Agent messaging, phase 2: the implementation lead

Builds on phase 1 (hierarchy, mailbox, `coordinate` mode). Adds the `lead` role: a coordinating agent per run
that cannot touch files, owns the plan as its task ledger once the human approved it, answers its coders'
questions and amends the plan when new work turns up.

## Decision: planner plus lead

The report proposed the lead replacing the planner. Phase 2 keeps the planner (read-only, explores the repo) and
hands the approved plan to a lead, because a `coordinate` session cannot read the repository and research agents
(phase 3) do not exist yet. When research lands, the lead can take over planning through researchers; nothing here
prevents that.

## Mechanics

- **Role** `lead`, permission mode `coordinate`, in `COORDINATOR_ROLES` (gets the messaging tools). Engine and
  model: the run's planner engine, `settings.roles.lead`. `settings.lead.enabled` (default on) turns the lead off
  for a run.
- **One attempt for the run's life.** The lead process stays alive and idle between turns; the lead loop
  (`orchestrator/lead.ts`) sends it a wake message when something happened: queued messages (a coder's `ask_lead`),
  task status changes, plan amendments approved or rejected. The loop ends the turn, waits for the next wake. The
  lead never blocks in `wait_for_reply`.
- **Identity across restarts.** If the lead process dies (crash, rate limit, engine restart), the loop resumes the
  engine session as a new attempt and re-parents the children of the old attempt. `ask_lead` sends to the
  caller's *current* parent (`to: "lead"`), never to an attempt id captured at start.
- **Dispatch waits for the lead.** A run with the lead enabled does not dispatch tasks until the lead attempt
  exists, so every coder is opened with `parentAttemptId` set and sees `ask_lead`. If the lead cannot start after
  three failures, the run continues without one (`RunMeta.leadDisabled`).
- **Lead tools** (role `lead` only): `plan_status` (the board), `add_task(node)`, `amend_task(node_id, patch)`
  (tasks not started yet), `cancel_task(node_id, reason)` (skips a task not started yet). Every change is a new
  plan version (source `agent`) validated with `validatePlan`.
- **Amendment policy** (`core/lead.ts`, pure): an added or amended task is applied at once when its risk is not
  `high` and every write touch stays inside a directory the approved plan already writes. Otherwise the version
  waits as a `plan_signoff` inbox item; approving it applies the change, rejecting it tells the lead why.
- **Coders** get the `ask_lead` rule in their prompt when they have a lead.

## Files

`shared/domain.ts` (role, settings), `shared/engine.ts`, `mcp/server.ts` + `config.ts`, `core/lead.ts`,
`core/prompts/lead.ts` + `coder.ts` + `types.ts`, `orchestrator/lead.ts`, `orchestrator.ts` (loops, host),
`planner.ts` (amendments, approval while executing), `tasks.ts` / `merge.ts` (parent), `meta.ts`, `index.ts`,
`demo.ts`, `test-harness.ts`, renderer role labels and settings, docs.

## Out of scope

Stall detection and replanning prompts, research spawning (phase 3), the assistant (phase 4), UI tiles (phase 5).
