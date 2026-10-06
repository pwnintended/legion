# Legion architecture

Legion is a macOS desktop app (Electron + TypeScript) that takes an issue through
**clarify → plan → task DAG → parallel coding agents → cross-engine review → integration branch → draft PR**,
driving both **Claude Code** and **Codex** through their own CLIs. The UI is a niri-style scrollable tiling
workspace. Background research lives in `docs/research/`; the visual reference is the mockup at
https://claude.ai/artifact/A818rw2Q72GGGFwcfVkbkT (Catppuccin Mocha, Geist / Geist Mono).

This document is the contract every contributor (human or agent) builds against. If code and this
document disagree, fix one of them in the same change.

## 1. Product decisions (v1)

| Topic | Decision |
|---|---|
| Platform | macOS (arm64 + x64) first. Don't break Linux needlessly, but don't test it. |
| Claude Code | Spawn the user's installed `claude` CLI: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`. No Agent SDK. Auth = the user's own login (never touch tokens). |
| Codex | Spawn `codex app-server` (JSON-RPC 2.0 over stdio). Types generated with `codex app-server generate-ts --experimental` and committed. Auth = the user's own `codex login`. |
| Approvals | In-band for both engines, surfaced as `approval_request` events → inbox → `session.respond()`. Claude: `--permission-prompt-tool stdio` → `can_use_tool` control requests on stdout, answered with a `control_response` on stdin. Codex: `item/*/requestApproval` server requests. |
| Engine per role | Planner: user choice per run (default Claude). Coder: per task from the plan (`agent.engine`), overridable. Reviewer: always the *other* engine than the task's coder (fallback: same engine, different model). |
| Commits | Legion commits, never the agent (Codex's sandbox makes `.git` read-only anyway). |
| Integration | One integration branch per run; each approved task is squash-merged into it via a serialized merge queue; post-merge verification after every merge. |
| PR | One draft PR per run via `gh pr create --draft`. GitHub only in v1. |
| Required human gates | Plan approval and final PR approval. Everything else is automatic unless it escalates to the inbox. |

## 2. Repository layout

Single package (no monorepo), pnpm, electron-vite.

```
src/
  shared/            pure TS, no Node/DOM APIs. Imported by every process.
    domain.ts        Run, Plan, TaskNode, Task, Attempt, Review, InboxItem, Merge, Verification, Settings,
                     statuses + *_TRANSITIONS tables (zod + inferred types)
    schemas/         zod schemas for agent structured output (clarify, plan DAG, review, task report)
                     + toStrictJsonSchema (strict-mode JSON Schema for --json-schema / outputSchema)
    events.ts        normalized AgentEvent union + ServerEvent (engine → renderer, with seq)
    engine.ts        AgentEngine / AgentSession interfaces, Role, permission profiles
    rpc.ts           typed RPC contract between renderer and engine (procedures + event stream)
    rpc-transport.ts typed client/server over any MessagePort-like object, RpcError
    host-protocol.ts main ↔ engine messages over parentPort;  bridge.ts  window.legion (preload) API
    ids.ts, util.ts
  main/              Electron main: windows, engine supervisor, MessagePort wiring, native niceties
  preload/           minimal contextBridge: hands the renderer its MessagePort
  engine/            runs in an Electron utilityProcess (also runnable in plain Node for tests)
    index.ts         entry: open DB, start RPC server, start MCP server, recover state; startEngine()
    context.ts       EngineContext handed to handler modules
    rpc/             RPC server over MessagePort (implements shared/rpc.ts); core procedures
    db/              node:sqlite, migrations, typed repositories (Store), append-only event log
    util/            AsyncQueue etc.;  test/  test helpers
    adapters/
      claude/        Claude Code CLI adapter (stream-json + control protocol)
      codex/         Codex app-server adapter (JSON-RPC), protocol/ = generated types
      fake/          scripted fake engine used by tests and the dev "demo" mode
    mcp/             Legion MCP server (streamable HTTP on 127.0.0.1, per-session bearer tokens)
    git/             git CLI wrapper, worktrees, merge-tree forecast, integration merge queue, gh PR
    orchestrator/    run lifecycle, review loop; core/ = pure logic (dag validation, graph, estimates,
                     scheduler, task status policy, prompts/)
    pty/             node-pty sessions for terminal takeover (Electron runtime only)
  renderer/          React 19 UI
    app/             bootstrap, EngineConnection (RPC client + reconnect), stores
    layout/          tiling engine (pure TS tree + ops) and its React renderer
    tiles/<kind>/    one folder per tile kind, registered in tiles/registry.ts
    overlays/        inbox, composer, command palette
    chrome/          title bar, rail, status bar
    theme/           tokens (CSS variables), fonts, motion constants
docs/
tests/e2e/          Playwright _electron smoke tests
```

TypeScript projects: `tsconfig.node.json` (shared, main, engine, tests), `tsconfig.preload.json`
(preload, DOM + node types), `tsconfig.web.json` (renderer + shared). `pnpm typecheck` runs all three.

**Ownership rule:** work stays inside the folder you were assigned. Cross-cutting files
(`src/shared/**`, `package.json`, `electron.vite.config.ts`, `tiles/registry.ts`) change only when
your task says so.

## 3. Process model

```
main (thin)     BrowserWindow, Menu, Notification, dock badge, powerSaveBlocker, safeStorage,
  │             login-shell PATH resolution, engine supervisor (restart on crash)
  │ spawns utilityProcess + creates MessageChannelMain; one port to engine, one to renderer
engine          orchestrator, adapters (child processes: claude / codex), git, sqlite, MCP server, pty
  ⇅ MessagePort (structured clone)
renderer        React UI; reconnects after reload and resumes the event stream from its last seq
```

- Main resolves `PATH` from the user's login shell (`$SHELL -ilc 'printf %s "$PATH"'`) at startup and
  passes it to the engine via `env`. GUI-launched apps do not inherit it.
- Port wiring: the engine posts `ready` on `parentPort`; only then does main create a `MessageChannelMain` per
  renderer (`connect` to the engine, `legion:engine-port` to the renderer). The preload forwards the port to the
  page with `window.postMessage` (ports can't cross contextBridge). The renderer asks for a port on every load;
  main re-wires every renderer after an engine restart (exponential backoff, counter reset after 60 s healthy).
- `LEGION_HOME` overrides the data dir (`~/Library/Application Support/Legion`); when set, Chromium's profile
  goes to `$LEGION_HOME/chromium` so isolated instances don't share the single-instance lock.
- The window uses `vibrancy: 'under-window'` with an opaque `#11111b` background (no white flash). Vibrancy
  only shows through if the window background is made transparent; that is a design decision for chrome/.
- The engine must not import `electron` except behind `process.parentPort` checks, so it can run in plain
  Node (tests, headless runs). `node:sqlite` is used precisely so the DB works in both.
- Engine state survives renderer reloads. On engine start it reconciles the DB with reality (§9).

## 4. Stack

| Area | Choice |
|---|---|
| Runtime / build | Electron (latest stable), electron-vite, electron-builder, TypeScript strict, pnpm |
| Versions (pinned exact) | electron 44.5.1 (Node 24.21), electron-vite 5.0.0 + **Vite 7** (electron-vite 5 does not accept Vite 8; hence @vitejs/plugin-react 5.2), TypeScript 7.0 (native `tsc`), React 19.3, Tailwind 4.3, zod 4.6, @modelcontextprotocol/sdk 1.32, vitest 5, Playwright 1.63, Biome 2.5 |
| Lint / format | Biome |
| Tests | Vitest (engine + shared + renderer logic), Playwright `_electron` (smoke) |
| IPC | Hand-rolled typed RPC over MessagePort (`shared/rpc.ts`): request/response + server-pushed events with monotonic `seq` |
| DB | `node:sqlite` (no native rebuilds; verified in Electron 44's main and utilityProcess), WAL, hand-written migrations + typed repositories, zod at boundaries |
| MCP | `@modelcontextprotocol/sdk` streamable HTTP server |
| UI | React 19, Tailwind CSS v4 (tokens as CSS variables), Zustand, Motion, cmdk |
| DAG | @xyflow/react + @dagrejs/dagre |
| Diff | `git diff` output parsed in the engine; rendered with Shiki highlighting in a custom virtualized diff view |
| Markdown | streamdown (agent output), plain textarea/CodeMirror for plan editing |
| Terminal | node-pty (engine) + @xterm/xterm with WebGL only on visible terminals |
| Git / GitHub | system `git` via execa, `gh` CLI |

Do not add dependencies outside your task. If you need one, say so in your report.

## 5. Domain model

```
Run        id, repoPath, baseRef, title, issueText, issueUrl?, status, paused, plannerEngine, plannerModel?,
           integrationBranch?, prUrl?, pr? {url, number, state: open|closed|merged, isDraft}, archived,
           error?, createdAt, updatedAt
           status: draft → clarifying → planning → awaiting_approval → executing → integrating
                   → finalizing → pr_ready → done | failed | cancelled   (+ paused flag)
Plan       id, runId, version, markdown, dag (PlanDag = {nodes, annotations}), source (agent|user), feedback?,
           createdAt, approvedAt?
TaskNode   (inside PlanDag) id "T1".., title, goal, kind (contracts|feature|test|refactor|docs|integration),
           dependsOn[], acceptanceCriteria[{id,text}], touches[{glob, mode: create|modify|read}],
           size S|M|L, verify{commands[]}, contextHints{files[],notes}, agent{engine, model?, effort?}, risk low|med|high
Task       runtime row per node: runId, nodeId, status, branch, worktreePath, startSha, attemptCount, fixRounds,
           mergedSha?, engine/model/effortOverride?, progress?, report? {summary, commitMessage}, error?
           status: blocked → queued → provisioning → running → verifying → reviewing → fixing
                   → approved → awaiting_human → merging → merged | failed | skipped | cancelled
Attempt    id, taskId?, runId, role (planner|coder|reviewer|resolver|finalizer), engine, model,
           sessionId (claude session / codex thread), status, startedAt, endedAt, costUsd?, tokens?, error?
           status: pending → running → succeeded | failed | interrupted | cancelled  (interrupted → running on resume)
Review     id, taskId (null = final review), attemptId, verdict (approve|request_changes|reject_replan),
           criteria[{id,status: met|unmet|unclear,evidence}], findings[{severity: blocker|major|minor|nit,
           file?, line?, title, body, suggestedFix?}], summary
InboxItem  id, runId, taskId?, kind (approval|question|plan_signoff|escalation|pr_ready|conflict|budget),
           payload, createdAt, resolvedAt?, resolution?
Merge      id, runId, taskId, preSha, postSha?, status (pending|merged|conflict|verify_failed|reverted), error?
Verification id, runId, taskId?, attemptId?, phase (setup|task|post_merge|final), command, exitCode?, outputTail,
           durationMs
Event      seq (global, monotonic), runId?, taskId?, attemptId?, ts, type, payload  — append-only
```

`?` fields are `null` when absent (never `undefined`), timestamps are epoch ms. `Run.pr`, `Run.archived` and
`Task.report` (migration 002) are optional in the TS types only so older event-log payloads and fixtures stay
valid; the engine always sets them. The allowed status changes are
data (`RUN_TRANSITIONS`, `TASK_TRANSITIONS`, `ATTEMPT_TRANSITIONS` in `shared/domain.ts`).

Status changes go through one function per entity that does compare-and-set (`UPDATE … WHERE status = ?`)
and appends an Event in the same transaction.

## 6. Agent engines

`shared/engine.ts` defines the interface every adapter implements:

```ts
interface AgentEngine {
  kind: 'claude' | 'codex' | 'fake';
  probe(): Promise<EngineInfo>;                       // installed? version? logged in?
  start(opts: SessionOptions): Promise<AgentSession>; // new session
  resume(sessionId: string, opts: SessionOptions): Promise<AgentSession>;
}
interface AgentSession {
  id: string;                                // engine-native session/thread id (known after init)
  events: AsyncIterable<AgentEvent>;         // normalized, ends when the process exits
  send(text: string, priority?: 'now' | 'next'): Promise<void>; // follow-up / steer
  interrupt(): Promise<void>;                // stop current turn, keep session
  close(): Promise<void>;                    // kill process
  respond(requestId: string, decision: ApprovalDecision): Promise<void>; // answer an approval
}
SessionOptions = { role, cwd, prompt, systemPrompt?, model?, effort?, permission: PermissionProfile,
                   outputSchema?: JSONSchema, mcp: { url, token }, env, addDirs? }
```

Normalized `AgentEvent` kinds: `session_started{sessionId, model, version}`, `text_delta`, `message`
(final assistant text), `reasoning`, `tool_call{id, name, input, kind: read|edit|command|mcp|other}`,
`tool_result{id, ok, output?}`, `file_change{path, added, removed}`, `todo{items}`,
`approval_request{requestId, tool, input, reason?}`, `usage{inputTokens, outputTokens, costUsd?}`,
`rate_limit{engine, window, usedPct, resetsAt}`, `turn_complete{structuredOutput?, isError, reason?}`,
`error{message, retryable}`, `exited{code}`.

### Permission profiles by role

| Role | Claude | Codex |
|---|---|---|
| planner, reviewer, finalizer | `--permission-mode dontAsk --permission-prompts none`, `--allowedTools mcp__legion`, `--disallowedTools` edit tools + AskUserQuestion/Enter/ExitPlanMode. Reads inside cwd/`--add-dir` and commands the CLI classifies as read-only (`ls`, `git diff`, …) need no rule. | `sandbox: read-only`, `approvalPolicy: never` |
| coder, resolver | `--permission-mode acceptEdits` (edits inside the working dirs), `--allowedTools` = `Bash(<cmd>)`/`Bash(<cmd> *)` per verify command + `mcp__legion`; everything else → `--permission-prompt-tool stdio` → `approval_request` (or `--permission-prompts none` when `askHuman` is false) | `sandbox: workspace-write` (cwd = worktree), `approvalPolicy: on-request` → requestApproval → inbox |

Every Claude profile also denies `Bash(git commit *)`, `Bash(git push *)`, Enter/ExitWorktree and the
scheduling tools (Cron*, ScheduleWakeup, RemoteTrigger, PushNotification). Approval decisions: allow →
`{behavior:"allow", updatedInput}`; allow with scope `session` adds the CLI's own scoped rule (`Tool(content)` or
one MCP tool) and directory suggestions with `destination:"session"` (never `localSettings`). Without such a rule it
adds an exact `Bash(<command>)` rule for a plain Bash command and otherwise no rule (= allow once): never a
whole-tool rule. Deny → `{behavior:"deny", message, interrupt?}`.
`AskUserQuestion`/`ExitPlanMode` from a coder arrive as ordinary `approval_request`s (answer AskUserQuestion with
`updatedInput: {questions, answers}`); planners never see them.

Auto-allow is strict on both engines (`engine/util/shell.ts`): a command is covered only when it is exactly an
allowed verify command, or that command followed by plain arguments without shell syntax (`;&|$\`(){}<>*?!~#^[]`,
quotes, backslashes, newlines). Codex: Legion answers `requestApproval` itself only for `kind: command` requests
without `additionalPermissions` or network context whose real `command` (the `<shell> -lc '<script>'` wrapper is
unwrapped; the display-only `commandActions` are ignored) matches; everything else goes to the inbox. Claude: a
verify command containing shell syntax gets only its exact `Bash(<cmd>)` rule, no `Bash(<cmd> *)`.

Config isolation: Claude runs with `--strict-mcp-config --mcp-config <legion only>` (written to a 0600 temp
file so the bearer token stays out of `ps`), explicit `--setting-sources project` (keeps the repo's CLAUDE.md
and `.claude/settings.json`, ignores the user's global hooks/plugins/settings) and `--settings
'{"autoMemoryEnabled":false}'` (otherwise the agent may write `~/.claude/projects/<cwd>/memory/`). Variables of a
*parent* Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) are stripped from the child env. Codex runs with a
Legion-owned `CODEX_HOME` (`<dataDir>/codex-home`) containing only a **symlink** to the user's `auth.json`
(codex writes it in place, so token refreshes reach the user's file; `app-server` has no `--ignore-user-config`)
plus `-c features.hooks=false` etc. Codex threads live in that home, so resume/takeover must use it.
Details: `src/engine/adapters/codex/README.md`.

Structured output: Claude `--json-schema`, Codex `outputSchema` on `turn/start`. Both are re-validated with
zod in the engine; a schema failure is a retryable attempt failure.

Claude specifics the orchestrator must know (session ids known at start, cumulative `usage`, `turn_complete.reason`
values, interrupt/close escalation) are listed in `src/engine/adapters/claude/README.md`.

## 7. Legion MCP server

Streamable HTTP on `127.0.0.1:<random port>`, bearer token per session (token → {runId, taskId?, attemptId, role}).
Tools (all return small JSON):

- `report_progress({summary})` — one-line status shown on the task card
- `request_human_input({question, options?})` — blocks until answered via the inbox
- `mark_task_done({summary, commitMessage})` — coder signals completion

DAG and review output come back as structured output, not via MCP tools. Tool approvals do not go through
MCP either: both adapters receive them in-band (§6). The Claude adapter pre-approves every Legion tool
(`--allowedTools mcp__legion`). The server also has an `approve` tool: an unused fallback (no CLI is configured to
call it); the orchestrator still routes it to an `approval` inbox item. Coders get the task-report output schema
too, so a turn that ends with a valid structured report counts even without `mark_task_done` (the fake engine
relies on this); when both exist the structured report wins.

## 8. Orchestration flow

1. **Create run** (composer): repo, base ref (default: current default branch), issue text/URL, planner engine.
2. **Clarify** (planner, read-only): returns `{questions[]}` (0–5) as structured output → inbox items, answered inline.
3. **Plan** (planner, read-only, same session resumed): returns `{markdown, dag}` per `schemas/plan.ts`.
4. **Validate** (deterministic, `orchestrator/core/dag.ts`): ids unique, deps resolve, acyclic, every node has
   ≥1 acceptance criterion and a verify command, `touches` globs are repo-relative; compute pairwise write-set
   (`create|modify` touches) overlap for nodes not ordered by a path → auto-add a serializing edge (lower
   topological depth first, then lower id) and record it as a `serializing_edge` plan annotation (undoable:
   `undoAutoEdge` leaves a `[overlap_accepted]` note); flag hot files written by several nodes, L-size nodes,
   high-risk nodes and `highRiskGlobs` matches. Estimate cost and wall clock.
5. **Approve** (human). The user can edit the markdown, nodes, deps, engines before approving.
6. **Execute** (`orchestrator/core/scheduler.ts`): a node is *ready* when all deps are **merged** (or
   skipped by a human) into the integration branch. Priority = longest remaining path, then fan-out, then
   risk, then id. Global concurrency cap (default 3) plus per-engine caps, counted in tasks holding a slot
   (provisioning → fixing; one agent session at a time each); pause dispatch on rate-limit events. Status
   decisions for verify/review/fix/merge/retry are pure functions in `orchestrator/core/policy.ts`.
   - Provision: `git worktree add -b legion/<run>/<task>-<slug> <wt> <integration HEAD>`; record `startSha`;
     run repo `legion.json` `setup` commands.
   - Code (coder session) → Legion commits (`git add -A && git commit`, message from `mark_task_done`).
   - Verify: run node `verify.commands` + repo `legion.json` `verify`; scope check (actual changed files vs
     declared `touches`).
   - Review (other engine, fresh session, read-only): input = node spec, issue, `git diff startSha..HEAD`,
     verify results, scope report → `Review`. Approve iff all criteria met and no blocker/major.
   - Fix loop: send blocker/major findings back to the coder session (resume), re-verify, re-review.
     Max 2 fix rounds, then escalate to inbox.
   - High-risk nodes → `awaiting_human` after approval.
   - Merge queue (serialized): `git merge-tree --write-tree` forecast; clean → squash-merge into integration
     worktree, commit `T<n>: <title>`, run post-merge verify; failure → reset integration to the pre-merge SHA,
     send the task back to fixing with integration HEAD merged into its branch. Conflicts → resolver session
     (coder engine) in the task worktree; 2 failures → inbox. Lockfiles: never hand-merged — take ours, re-run
     the install command.
   - Failure: retry up to 2 more attempts from a reset worktree with the failure summary; then `failed`,
     downstream `blocked`, inbox escalation (retry / skip / edit / abort).
7. **Finalize**: full verify on integration; final holistic review (engine other than the majority of coders)
   over `base...integration`; blocker findings → inbox.
8. **PR**: `git push -u origin legion/<run>/integration`, `gh pr create --draft --base <base> --title … --body-file …`.
   Body: issue link, plan summary, task table (engine, reviewer verdict), verification, minor findings, run id.
9. **Cleanup** (`runs.archive`, also run automatically when the PR is merged or closed): cancel the run if still
   active, close its sessions and takeover terminals, remove the task worktrees and local task branches and the
   integration worktree (the integration branch stays while the PR is open), restore `gc.auto`, set
   `archived: true` (hidden from `runs.list` unless `includeArchived`). Idempotent.

### 8.1 Lifecycle service (`engine/orchestrator/`)

The service applies `core/` decisions with CAS transitions; every flow is re-entrant from the persisted state.

- **Engines**: `EngineRegistry` holds `ClaudeEngine`, `CodexEngine` (`CODEX_HOME` = `<dataDir>/codex-home`) and
  `FakeEngine`. `LEGION_FAKE_ENGINES=1` serves *every* kind with the scripted demo agent (`orchestrator/demo.ts`)
  and a PR host that never pushes. Engines are probed at start and by `engines.list/probe`; an engine that is not
  installed, not logged in or disabled fails `runs.create` (`failed_precondition`) or the session start (an `auth`
  failure → escalation), with the probe's message.
- **Attempts**: one `Attempt` row per agent *process*. Resuming a session (planner plan step, fix rounds, hand-back
  after takeover, recovery) keeps the engine `sessionId`; a resume after a crash re-uses the interrupted row
  (`interrupted → running`), others insert a new row. Usage events are cumulative per engine session: an attempt's
  cost/tokens = latest total − what the session's other attempts were charged (engines whose totals restart per
  process are detected on the first usage event). Run cost = sum of attempt costs.
- **Planner**: runs read-only in the run's integration worktree (`legion/<run>/integration`, created at the base
  sha when planning starts, so the planner sees exactly `baseRef`). Clarify and plan resume one planner session.
  Invalid plans get up to 2 corrective follow-ups in the same session; a plan still invalid is stored with its errors
  as `[error]` notes (approval then answers `bad_request` until a human edit fixes it). Each new version supersedes
  the open `plan_signoff` item. Approval creates the tasks (`blocked`), sets `integrationBranch` and `gc.auto=0`, and
  runs `legion.json` copy/symlink/setup in the integration worktree.
- **Task driver** (`tasks.ts`, one per task, re-entrant by status): provisioning → coder → `commitAll` (message from
  the report) → verify (`node.verify` + `legion.json` verify, stop at the first failure) + scope check (report only;
  lockfiles always allowed when there is an install command) → reviewer (other engine, fresh, read-only, cwd = task
  worktree) → `decideAfterReview`. Fix rounds resume the coder session with the fixer prompt; a session that cannot
  be resumed is replaced by a fresh one. A high-risk approval → `awaiting_human` + an `escalation` item (`reason:
  other`, actions `[skip, abort]`): the UI approves with `tasks.approveMerge` (resolves it with `{action: retry, note:
  "approved for merge"}`) or sends it back with `tasks.requestChanges` (`{action: edit, note}`).
- **Merge queue** (`merge.ts`, serialized per run): `merging` tasks first (resume), then `approved` FIFO. Clean
  forecast → `insertMerge(preSha)` → squash → post-merge verify (install command first when a lockfile changed) →
  `merged`; a failed verify resets to `preSha` (merge `reverted`) and starts a fix round with integration merged into
  the task branch. Conflict → merge integration into the task branch, lockfiles take integration's side and the
  install command reruns, a `resolver` session (coder engine) handles the rest, `finishMerge`, forecast again.
  Exhausted resolver attempts → `conflict` item (`retry` = back into the merge queue with a fresh budget).
- **Escalations**: task items carry `taskId`; run-level items (`taskId: null`) come from the final verify
  (`verify_failed`), the final review (`final_review`) or a finalizer that cannot run (`other`), with actions `[retry,
  skip, abort]`: retry reruns the step, skip moves on (integrating → finalizing → pr_ready), abort cancels the run.
  Task `edit` = retry with the note as context for the next attempt. Answering through `inbox.resolve` and through
  the `tasks.*` procedures is equivalent; both resolve the item.
- **Rate limits**: a `rate_limit` event with `usedPct ≥ 95`, or a retryable 429-like error, pauses new sessions on that
  engine until the reset (60 s when unknown); the failed coder attempt is re-queued without being charged.
- **Budget**: `settings.budget.perRunUsd` (or a per-run limit raised through the `budget` item) reached → run paused +
  `budget` item; `raise` (default 1.5× the spend) resumes, `stop` cancels. A notification fires at `warnAtPct`.
- **Pause** gates new agent sessions (dispatch, reviewers, fixers, resolvers, finalizer); turns in flight finish.
  **Cancel** cancels open tasks and attempts, dismisses open inbox items, interrupts and closes live sessions and
  takeover terminals (worktrees are kept).
- **Steering**: `sessions.send` / `sessions.interrupt` need a live session; a human interrupt does not end the step,
  the session waits for the next message. **Takeover**: `sessions.takeover` interrupts and closes the adapter
  session, marks the attempt `interrupted` (`error: "taken over by a human"`) and opens a PTY running
  `claude --resume <id>` / `codex resume <id>` (with Legion's `CODEX_HOME`) in the attempt's worktree. When the PTY
  exits, the adapter session is resumed with a hand-back prompt and the attempt is `running` again. The renderer
  attaches with `terminals.open({target: {kind: "attempt", attemptId}, terminalId, cols, rows})`.
- **Diffs**: task = `startSha` → the task worktree including uncommitted and untracked files (staged into a
  throwaway index); once the worktree is gone, `startSha..branch`. Run = `base...integration`.
- **Bookkeeping** that is not a domain row (planner session id, clarify answers, fix context, coder session, latest
  report, resolver attempts, per-run budget) lives in the `settings` key/value table under `run:<id>` /
  `task:<id>`. `gc.auto` is reference-counted per repository under `repo:<repoPath>` (`repo-gc.ts`): the user's
  value is saved once by the first run that disables it and restored when the last holding run ends.
- **Host messages**: `notify` for every new inbox item (main decides about focus), `badge` = open inbox items,
  `power` = any agent process alive.
- **Plan edits**: `runs.updatePlan` takes the DAG's `annotations` from the client; an `[overlap_accepted]` note
  (left by `undoAutoEdge`) keeps that pair unserialized on re-validation. Without `annotations` the base version's
  are used.
- **Same-engine review**: reviewers and the finalizer use the other engine when it is *available* (enabled and
  usable per the last probe); otherwise the coder's engine with a different model:
  `settings.engines.<kind>.fallbackReviewModel` (claude `opus`, codex `null`) unless the coder ran that model, then
  the Claude sibling (opus ↔ sonnet) or another model from the engine's probe (`core/engines.ts`).
- **PR status** (`cleanup.ts`): `runs.createPr` stores `run.pr`; `runs.refreshPr` and a 3-minute poll of open PRs
  read it again through the `PrHost` (`gh pr view`). A merged or closed PR moves a still-open run to `done` and
  archives it (§8 step 9). The coder's final report is copied to `task.report` (cleared when a fresh attempt starts).
- **Settings**: `settings.updated` rebuilds an engine whose binary path changed (`EngineRegistry.reconfigure`, then
  a re-probe); live sessions keep their instance. Models, effort and `enabled` are read at each session start.
- **Fake mode**: the demo script (`demo.ts`) hits every human touch point once: one clarify question, a 3-task plan
  (T2 after T1), a tool approval (T3's coder), a major review finding on T2 fixed in the next round, the PR gate. The
  PR host is `FakePrHost({ push: false })`: nothing is pushed, GitHub is never called.

## 9. Git & filesystem conventions

- Worktrees: `~/Library/Application Support/Legion/worktrees/<repoHash>/<runId>/<taskId>/` and `.../_integration/`.
  Never touch the user's main checkout's working tree or index.
- Branches: `legion/<runShort>/integration`, `legion/<runShort>/<taskId>-<slug>`.
- A per-repo mutex serializes ref-changing git commands. `gc.auto=0` on repos Legion manages while runs are active.
  No other repository config is written: rerere is enabled per merge command (`-c rerere.enabled=true`).
  `removeWorktree` removes only its own worktree entry (also when the directory is gone) and never runs
  `git worktree prune`, which would drop the user's worktrees on unmounted volumes.
- Recovery on engine start (`orchestrator/recovery.ts`): attempts in `running` → `interrupted`; coder attempts of
  running/fixing tasks are resumed in the same row with a "Legion was restarted" prompt, the others fail and their
  step reruns. Approval and agent-question items are dismissed (their sessions are gone). `pending` merges are rolled
  back (`resetIntegration(preSha)`, merge `reverted`) and the task is merged again. `git worktree list` is reconciled
  with the DB: missing worktrees are restored from their branch, else the task is re-queued without charging the
  attempt; unknown worktrees under Legion's directory are only logged. Conflict merges left in progress are aborted.
  Planner and finalize jobs restart; dispatch resumes. Before every integration merge record the pre-merge SHA.
- Per-repo config `legion.json` (optional): `{ setup?: string[], verify?: string[], copy?: string[],
  symlink?: string[], highRiskGlobs?: string[], installCommand?: string }`.
- App data: `~/Library/Application Support/Legion/legion.db` (override with `LEGION_HOME` for tests).

## 10. RPC & events

`shared/rpc.ts` holds a single contract object: procedure names → zod input/output, and an event channel.
Renderer calls `rpc.call('runs.create', input)`; engine pushes `ServerEvent` batches (coalesced ~16 ms).
Every ServerEvent is one row of the `events` table (its `seq`), and entity events carry the full updated row, so
applying them is idempotent. On (re)connect the renderer sends `subscribe({sinceSeq})`: the engine replays missed
events (`replayed: true`) or, if it cannot (fresh client, gap > 20k events), answers `replayed: false` and the
client refetches snapshots (`runs.list`, `runs.get` — each carries the `seq` it was read at) and ignores older
events. Unimplemented procedures answer `RpcError('not_implemented')` (none are left).
Raw PTY bytes use a dedicated MessagePort per terminal, not the RPC channel. `terminals.open` with a `terminalId`
re-attaches the transferred port to a live terminal (a detached shell, or the terminal of `sessions.takeover`).

## 11. UI

- Concept: workspace = run; strip of columns = tasks (plus plan/DAG/PR tiles); tile = a view; layout modes
  Strip / Focus / Overview / Pipeline; urgency borders; overlays: composer (⌘N), inbox (⌘I), palette (⌘K);
  waybar-style status bar; rail of runs. See `docs/research/tiling-ux.md` and the mockup.
- Layout engine is a pure TS tree (Workspace → Strip → Column(split|stacked|tabbed) → Tile) with ops
  (insertAfter, remove, focusDir, moveDir, setWidthPreset, collapse, toggleStacked) and full unit tests.
  The run's DAG drives insertion; the user's manual changes persist per run.
- Keyboard: one command registry feeds keybindings, palette and tooltips. `Mod` = ⌘. Focus h/j/k/l
  (`⌘⌥` + hjkl or arrows to avoid clobbering text input), terminal tiles get a "locked" mode.
- Motion: springs (stiffness ~800, critically damped), transform/opacity only, honour reduced motion,
  urgency pulse stops on acknowledgement.
- Theme: Catppuccin Mocha tokens as CSS variables; Claude = mauve `#cba6f7`, Codex = teal `#94e2d5`,
  attention = peach `#fab387`, ok = green `#a6e3a1`, error = red `#f38ba8`, running = blue `#89b4fa`.

## 12. Working agreements for contributors

- Adding an RPC procedure: add it to `shared/rpc.ts` (zod input/output; `null` not `undefined`), then
  `server.implement(name, handler)` from a `register*Handlers(server, ctx)` function wired in `engine/index.ts`.
  Throw `RpcError` with a meaningful code; anything else becomes `internal`. Transferred ports (terminals) arrive in
  the handler's `ctx.ports`.
- Persisting: only through `Store` (`engine/db/store.ts`). Schema changes are new migrations in
  `engine/db/migrations/` (never edit a released one).
- Agent structured output: define the zod schema in `shared/schemas/`, export `toStrictJsonSchema(schema)`, re-validate
  with zod in the engine.
- Engine tests run in plain Node: `startEngine({ dataDir: tempDir, env, log: silentLogger, probeOnStart: false })`
  and `engine.connect(new MessageChannel().port1)` with `createRpcClient(port2)`; use `adapters/fake` (`FakeEngine`,
  scenarios `success|edit|approval|structured|fail` or a custom script) instead of real CLIs: `fakeEngines: true`
  (the demo agent for every kind) or `engines: {claude, codex}` (scripted stand-ins), plus `prHost: new
  FakePrHost()` and `ptySpawn` for terminals. `orchestrator/test-harness.ts` sets all of that up on a temp repo with a
  bare `origin`.
- Demo the app without real CLIs: `LEGION_FAKE_ENGINES=1 pnpm dev` (any repo; the PR step never pushes).
- Test hooks: `LEGION_E2E_PICK_DIR=<path>` makes main answer the folder dialog with that path (Playwright cannot
  drive native dialogs); `LEGION_SELFTEST=1` makes the engine spawn a PTY and query node:sqlite after start and log
  `selftest ok …` (`pnpm test:packaged` uses it on the packaged app).

- `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass before you report done. Add tests for logic you write.
- Never run real `claude`/`codex` sessions in the default test suite. Live tests live under
  `*.live.test.ts`, run only with `LEGION_LIVE=1`, use the cheapest model (`haiku` / Codex low effort) and tiny prompts.
- Never push, never open PRs, never touch remotes, never modify `~/.claude` or `~/.codex`.
- Keep comments sparse and useful. No placeholder TODO stubs in code you report as done.
