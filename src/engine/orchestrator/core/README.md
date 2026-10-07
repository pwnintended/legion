# orchestrator/core

The deterministic brain of the run lifecycle: pure functions, no I/O, no clocks (pass `now`), no randomness.
Import everything from `orchestrator/core` (`index.ts`). The lifecycle service owns adapters, git, the
Store and MCP, and calls into this module to decide what to do.

## Plan validation — `dag.ts`

`validatePlan({nodes, annotations?}, {highRiskGlobs?, acceptedOverlaps?, enabled?, estimate?})` →
`{ok, errors, warnings, annotations, dag, autoEdges, layers, estimate}`.

- Errors (plan cannot be approved): `no_nodes`, `invalid_id`, `duplicate_id`, `unknown_dependency`,
  `self_dependency`, `cycle` (message shows the cycle), `no_acceptance_criteria`,
  `invalid_acceptance_criterion`, `no_verify_command`, `invalid_touch` (absolute, `..`, `.git`, negated,
  unbalanced). Structural errors (ids/deps/cycle) skip the graph phase and return the nodes unchanged.
- Warnings: duplicate deps, touch warnings (whole-repo glob, extglob), `no_write_touches`,
  `redundant_dependency`, `integration_not_last`, `engine_disabled`, `stale_auto_edge`.
- Overlap: every pair not ordered by a dependency path whose write globs (`create|modify`) can match a
  common path gets a serializing edge, from the node earlier in (depth, id) order. Overlapping groups become
  chains, never cliques. Each edge is an `auto_edge` annotation `{from, to, reason, paths, overlaps}`.
- Flags: `hot_file` (lockfiles, manifests, barrels, route registries, schemas, configs written by ≥2
  nodes; see `HOT_FILE_GLOBS`), `large_node`, `high_risk`, `high_risk_glob`, `cost_estimate`.
- Persist `result.dag` (a `PlanDag`). Structured annotations are encoded into the shared `PlanAnnotation`
  shape by `toPlanAnnotations`: `auto_edge` → `serializing_edge` `[from, to]`, the others → `note` with a
  `[kind]` message prefix (`noteTag()` reads it back). Re-validating a persisted DAG is idempotent.
- Undo in the UI: `undoAutoEdge(dag, from, to)` then re-validate (the pair is remembered as
  `[overlap_accepted]`); `restoreAutoEdge(dag, a, b)` forgets it.

## Globs — `glob.ts`

`globsOverlap(a, b)`, `globMatchesPath(glob, path)`, `globProblems(glob)`, `compileGlob`. Supports `*`, `?`,
`[...]`, `[!...]`, `**` segments, `{a,b}` and escapes. A wildcard-free pattern or one ending in `/` means
"this path and everything below it" (planners declare directories as plain paths).

Overlap is **exact** for that language: an emptiness check on the product of the two globs' segment
automata, with each segment pair checked by a character-level product. Limitations, all on the safe side
(over-reporting): extglobs, `{1..3}` ranges and brace expansions above 256 alternatives are treated as
"matches everything"; `*` may match an empty segment; dotfiles are not special; directory-literal semantics
make `src/db` overlap `src/db/x.ts`. Globs say what *may* be written, so two broad globs (`src/**`) always
serialize their nodes: the planner prompt asks for narrow touches.

## Graph — `graph.ts`

`topologicalOrder`, `layeredOrder`, `depths`, `depthLayers` (Pipeline layout), `findCycle`,
`ancestors`, `descendants`, `reachability`, `redundantEdges`, `transitiveReduction`,
`isTransitivelyReduced`, `fanOut`, `longestRemainingPath`, `criticalPath` (weights `SIZE_WEIGHT` S=1, M=2,
L=4, or any weight function), `compareNodeIds` (T2 < T10). Ordering functions throw `CycleError`.

## Estimates — `estimate.ts`

`estimateNode(node, opts)` and `estimatePlan(nodes, {concurrency, maxFixRounds, enabled, coderEngine,
constants})` → per-node minutes/cost (coder + verify + reviewer on the other engine + expected fix rounds by
risk and size + retry overhead), serial and critical-path minutes, and a simulated list schedule (scheduler
priority, global and per-engine caps, FIFO merge queue) giving `executionMinutes` and `wallClockMinutes`
(+ finalize). All tunables are in `ESTIMATE_CONSTANTS`; they are rough guesses until calibrated from
finished attempts. The planner's own cost is not included.

## Scheduling — `scheduler.ts`

`planDispatch({nodes, tasks, settings, otherRunsInFlight?, paused, rateLimits?, now})` →
`{enqueue, block, dispatch, waiting, blockedByFailure, inFlight, run, nextWakeAt}`.

- Apply `enqueue` (blocked → queued) and `block` (queued → blocked) first, then `dispatch`
  (queued → provisioning, already in priority order).
- A dependency is satisfied when `merged` or `skipped`. `failed`/`cancelled` ancestors put not-yet-started
  descendants in `blockedByFailure` (their status stays `blocked`).
- Slots: a task holds one slot on its coder engine while provisioning/running/verifying/reviewing/fixing.
  Only new starts are gated; reviews, fix rounds and resolvers of in-flight tasks never wait.
  `otherRunsInFlight` must count slot-holding tasks of all *other* active runs (the global cap spans runs).
- `run.state`: `complete` (every task terminal: start integrating), `active`, `waiting` (paused / cap /
  rate limit; `until`), `needs_human` (nothing can move without the inbox).
- Call again on every task status change, settings change, pause/resume, and at `nextWakeAt`.
- `previewEscalation(state, nodeId, 'retry' | 'skip')` tells the inbox what an answer would unblock.

## Task status policy — `policy.ts`

Each decision returns `{action, path, patch, escalation, reason}`: apply `path` step by step with CAS
transitions (all steps are legal in `TASK_TRANSITIONS`; empty = stay), apply `patch` to the counters, and
raise an `escalation` inbox item when `escalation` is set.

- `decideAfterCoderTurn(task, {report, changedFiles}, limits)`: done → verifying; blocked → awaiting_human;
  no report / partial / empty diff → retry policy.
- `decideAfterVerify(task, passed, limits)`: → reviewing, or a fix round (`fixRounds + 1`), or escalate
  after `maxFixRounds` (default 2).
- `decideAfterReview(task, review, {node, highRiskGlobs, previousFindings}, limits)`: approve iff no
  `reject_replan`, all criteria met and no blocker/major (`reviewApproves`); high-risk nodes go
  `approved → awaiting_human` (`requiresHumanGate`); repeated identical findings escalate early.
  `blockingFindings(review)` is what the fixer gets.
- `decideHumanGate`, `decideAfterMerge(task, 'merged' | 'conflict' | 'verify_failed', resolverAttempts,
  limits)`, `decideAfterFailure(task, {kind, message}, limits)` (max `1 + maxRetries` = 3 attempts;
  `rate_limited` requeues without charging an attempt; `auth` escalates), `decideEscalation(task, action)`.
- Counters: increment `attemptCount` when a fresh coder attempt starts (queued → provisioning). Fix rounds
  resume the coder session and do not count as attempts.

Also: `checkScope(node, changedPaths, alwaysAllowed)` (§8 scope check), `reviewerEngineFor`,
`finalizerEngineFor`, `coderEngineFor` (`engines.ts`).

## Prompts — `prompts/`

Pure builders returning `{systemPrompt, prompt}` (`AgentPrompt`): `buildClarifyPrompt`,
`buildPlanPrompt` (also for revisions and validation-error retries), `buildCoderPrompt`,
`buildFixerPrompt` (follow-up in the resumed coder session; self-contained enough for a fresh one),
`buildReviewerPrompt`, `buildResolverPrompt`, `buildFinalizerPrompt`; and `buildPrBody` → `{title, body,
truncated}` (body ≤ 65,536 chars, shrinks minor findings, logs and the summary before hard-cutting).

- Prompts never name engine-specific tools. Pass the Legion MCP tool names as the adapter exposes them
  (`tools: {markTaskDone, requestHumanInput, reportProgress}`, default bare names).
- Set `structuredReport: true` when the session also gets the task-report output schema.
- Diffs, logs, plans and issues are clipped to `PROMPT_LIMITS`; embedded markdown headings are demoted.
- `markdownSection(planMarkdown, 'Summary')` extracts the plan's summary for the PR body.
- Outputs are snapshot-tested (`prompts/__snapshots__`); review the snapshot diff when changing wording.

## Agent messaging — `messaging.ts`

Attempts form a tree through `parentAttemptId`. `messageEdge(from, to)` → `'parent' | 'child' | null` (same run,
adjacent only); `canMessage` and `messageRefusal` (worded for the agent that tried) wrap it. `renderMessages(lines)`
turns queued messages into the block the lifecycle service prepends to a resumed prompt (one `### <Kind> from
<peer> · id <msg>` section each, so the recipient can answer by id); `messageLine` and `peerLabel` (`coder of T3
(att_…)`) build those lines.

## The lead's rules — `lead.ts`

`amendmentNeedsSignoff(approvedNodes, node)` → the reason a plan amendment must wait for the human, or null when it
may apply at once: a new `high`-risk node, or a write touch whose directory (`touchDirectory`: the literal prefix's
directory, `src/api/**` → `src/api`, `README.md` → `.`) is not inside a directory the approved plan already writes
to. A changed node asks only when it becomes high risk or gains such a write; its own approved writes stay
approved, so rewording a high-risk task applies at once.
`boardChanges(snapshot, board)` → one line per task whose status changed since the snapshot (the wake digest);
`AMENDABLE_STATUSES` = blocked, queued. Prompts: `prompts/lead.ts` (`buildLeadPrompt`, `buildLeadWakePrompt`).

## Research agents — `research.ts`

`RESEARCH_ROLES` (researcher, research_lead), `RESEARCH_CAPS` (running research agents a parent may have: lead 3,
research lead 4), `formatResearchReport(title, report)` → the markdown a parent reads (bounded to `REPORT_MAX_CHARS`).
Prompts: `prompts/research.ts` (`buildResearcherPrompt`, `buildResearchLeadPrompt`).
Assistant prompts: `prompts/assistant.ts` (`buildAssistantPrompt`, `buildAssistantWakePrompt`).
