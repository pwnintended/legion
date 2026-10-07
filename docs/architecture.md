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
    attachments.ts   attachment limits, magic-byte sniffing, AttachmentRef (shared by engine and renderer)
    ids.ts, util.ts
  main/              Electron main: windows, engine supervisor, MessagePort wiring, native niceties
  preload/           minimal contextBridge: hands the renderer its MessagePort
  engine/            runs in an Electron utilityProcess (also runnable in plain Node for tests)
    index.ts         entry: open DB, start RPC server, start MCP server, recover state; startEngine()
    context.ts       EngineContext handed to handler modules
    rpc/             RPC server over MessagePort (implements shared/rpc.ts); core procedures
    db/              node:sqlite, migrations, typed repositories (Store), append-only event log
    attachments/     content-addressed attachment store (`attachments.add/get`, draft GC)
    util/            AsyncQueue etc.;  test/  test helpers
    adapters/
      claude/        Claude Code CLI adapter (stream-json + control protocol)
      codex/         Codex app-server adapter (JSON-RPC), protocol/ = generated types
      fake/          scripted fake engine used by tests and the dev "demo" mode
    mcp/             Legion MCP server (streamable HTTP on 127.0.0.1, per-session bearer tokens)
    git/             git CLI wrapper, worktrees, merge-tree forecast, integration merge queue, gh PR
    projects/        projects + read-only repository browsing (files, grep, log/show, gh PR list), confinement
    orchestrator/    run lifecycle, review loop; core/ = pure logic (dag validation, graph, estimates,
                     scheduler, task status policy, prompts/)
    pty/             node-pty sessions for terminal takeover (Electron runtime only)
  renderer/          React 19 UI
    app/             bootstrap, EngineConnection (RPC client + reconnect), stores
    layout/          tiling engine (pure TS tree + ops) and its React renderer
    tiles/<kind>/    one folder per tile kind, registered in tiles/registry.ts
    overlays/        inbox, composer, command palette
    attachments/     draft attachments (paste / drop / dialog), chip tray, preview lightbox
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
Project    id, path (real path of the checkout's top level, unique), name, addedAt, lastOpenedAt?, pinned
Run        id, projectId?, repoPath, baseRef, title, issueText, issueUrl?, status, paused, plannerEngine, plannerModel?,
           integrationBranch?, prUrl?, pr? {url, number, state: open|closed|merged, isDraft}, archived,
           attachments? (AttachmentRef[]: id, name, mime, size, kind image|text|file, sha256), error?, createdAt,
           updatedAt
           status: chatting → | draft → clarifying → planning → awaiting_approval → executing → integrating
                   → finalizing → pr_ready → done | failed | cancelled   (+ paused flag; chatting = a
                   conversation with the assistant, §8.6, that may become work or end as done/cancelled)
Plan       id, runId, version, markdown, dag (PlanDag = {nodes, annotations}), source (agent|user), feedback?,
           createdAt, approvedAt?
TaskNode   (inside PlanDag) id "T1".., title, goal, kind (contracts|feature|test|refactor|docs|integration),
           dependsOn[], acceptanceCriteria[{id,text}], touches[{glob, mode: create|modify|read}],
           size S|M|L, verify{commands[]}, contextHints{files[],notes}, agent{engine, model?, effort?}, risk low|med|high
Task       runtime row per node: runId, nodeId, status, branch, worktreePath, startSha, attemptCount, fixRounds,
           mergedSha?, engine/model/effortOverride?, progress?, report? {summary, commitMessage}, error?
           status: blocked → queued → provisioning → running → verifying → reviewing → fixing
                   → approved → awaiting_human → merging → merged | failed | skipped | cancelled
Attempt    id, taskId?, runId, role (planner|coder|reviewer|resolver|finalizer|lead|researcher|research_lead|assistant), engine, model,
           sessionId (claude session / codex thread), parentAttemptId? (the attempt it reports to), status,
           startedAt, endedAt, costUsd?, tokens?, error?
           status: pending → running → succeeded | failed | interrupted | cancelled  (interrupted → running on resume)
AgentMessage id, runId, fromAttemptId, toAttemptId, kind (brief|question|answer|report|status), body (markdown),
           replyTo?, createdAt, deliveredAt?  — the mailbox between an attempt and its parent / children (§7)
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

`?` fields are `null` when absent (never `undefined`), timestamps are epoch ms. `Run.pr`, `Run.archived`,
`Task.report` (migration 002) and `Attempt.parentAttemptId` (migration 005) are optional in the TS types only so
older event-log payloads and fixtures stay valid; the engine always sets them. The allowed status changes are
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
  send(text: string, priority?: 'now' | 'next', attachments?: SessionAttachment[]): Promise<void>; // follow-up / steer
  interrupt(): Promise<void>;                // stop current turn, keep session
  close(): Promise<void>;                    // kill process
  respond(requestId: string, decision: ApprovalDecision): Promise<void>; // answer an approval
}
SessionOptions = { role, cwd, prompt, systemPrompt?, model?, effort?, permission: PermissionProfile,
                   outputSchema?: JSONSchema, mcp: { url, token }, env, addDirs?, attachments? }
SessionAttachment = { name, mime, kind: image|text|file, path, size }   // sent with `prompt` / `send`
```

Attachments on the wire (verified with the live tests, `*/attachments.live.test.ts`): Claude stream-json user
messages get `content` blocks — `{type:'image', source:{type:'base64', media_type, data}}` per image and
`{type:'document', source:{type:'base64', media_type:'application/pdf', data}, title}` per PDF, then one text
block. Codex `turn/start` / `turn/steer` get one `text` input plus `{type:'localImage', path}` per image. Both
inline text files as fenced blocks headed by the file name (first 100k characters, then the path) and reference
anything else by path (`adapters/attachments.ts`).

Normalized `AgentEvent` kinds: `session_started{sessionId, model, version}`, `text_delta`, `message`
(final assistant text), `reasoning`, `activity{activity: thinking|output|tool_input, tool?, chars}` (a block that
streams without visible text, e.g. the structured plan: at its start and every 2k characters; Claude only),
`tool_call{id, name, input, kind: read|edit|command|mcp|other}`,
`tool_result{id, ok, output?}`, `file_change{path, added, removed}`, `todo{items}`,
`approval_request{requestId, tool, input, reason?}`, `usage{inputTokens, outputTokens, costUsd?}`,
`rate_limit{engine, window, usedPct, resetsAt}`, `turn_complete{structuredOutput?, isError, reason?}`,
`error{message, retryable}`, `exited{code}`.

### Permission profiles by role

| Role | Claude | Codex |
|---|---|---|
| planner, reviewer, finalizer | `--permission-mode dontAsk --permission-prompts none`, `--allowedTools mcp__legion`, `--disallowedTools` edit tools + AskUserQuestion/Enter/ExitPlanMode. Reads inside cwd/`--add-dir` and commands the CLI classifies as read-only (`ls`, `git diff`, …) need no rule. | `sandbox: read-only`, `approvalPolicy: never` |
| researcher | as above plus `--allowedTools WebSearch,WebFetch` (`PermissionProfile.web`) | as above plus `web_search = "live"` |
| coder, resolver | `--permission-mode acceptEdits` (edits inside the working dirs), `--allowedTools` = `Bash(<cmd>)`/`Bash(<cmd> *)` per verify command + `mcp__legion`; everything else → `--permission-prompt-tool stdio` → `approval_request` (or `--permission-prompts none` when `askHuman` is false). `settings.permissions.approvals = auto` (default): switched to auto mode over the control protocol (kept in `acceptEdits` when the model has none) | `sandbox: workspace-write` (cwd = worktree), `approvalPolicy: on-request` → requestApproval → inbox; `auto`: `approvalsReviewer: auto_review` |
| lead, assistant (`coordinate`); research_lead = the same plus `WebSearch`, `WebFetch` allowed | `dontAsk --permission-prompts none`, `--allowedTools mcp__legion`, `--disallowedTools` = the read-only list + `Read, Glob, Grep, LS, Bash, BashOutput, KillShell, WebFetch, WebSearch, Task, Agent, NotebookRead, TodoWrite, Skill, ToolSearch`: the session can only talk | `sandbox: read-only`, `approvalPolicy: never` (best effort: Codex's tool list cannot be trimmed) |

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

Trust boundary. Reviewer and finalizer sessions read worktrees that coders wrote, so they load **no**
configuration from them (`SessionOptions.untrustedWorkdir`): Claude runs with `--setting-sources=` (no project or
local `.claude/settings*.json`, hence no planted hooks or permission rules), Codex with `project_doc_max_bytes=0`
(no worktree `AGENTS.md`; project `.codex/config.toml` is only read for trusted projects and the Legion
`CODEX_HOME` trusts none; hooks are disabled for every session). A task whose diff touches agent or Legion
config (`.claude/**`, `.codex/**`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `legion.json`), CI configs, git hooks or
`package.json` `scripts` (`orchestrator/core/sensitive.ts`) is high risk: after an approving review it waits at
the human gate with the files named. **Verify and setup commands are trusted execution of repository code**:
Legion runs them unsandboxed in the worktree (`legion.json` and plan verify commands are human-approved, but
`pnpm test` still executes whatever `package.json` scripts and test files the coder wrote). The Codex sandbox
and the read-only reviewer profile limit the agents, not the code Legion itself runs on their behalf.

Structured output: Claude `--json-schema`, Codex `outputSchema` on `turn/start`. Both are re-validated with
zod in the engine; a schema failure is a retryable attempt failure.

Claude specifics the orchestrator must know (session ids known at start, cumulative `usage`, `turn_complete.reason`
values, interrupt/close escalation) are listed in `src/engine/adapters/claude/README.md`.

## 7. Legion MCP server

Streamable HTTP on `127.0.0.1:<random port>`, bearer token per session (token → {runId, taskId?, attemptId, role,
parentAttemptId?}). Tools (all return small JSON):

- `report_progress({summary})` — one-line status shown on the task card
- `request_human_input({question, options?})` — blocks until answered via the inbox
- `mark_task_done({summary, commitMessage})` — coder signals completion

Agent hierarchy and mailbox (`orchestrator/core/messaging.ts`). Attempts form a tree through
`parentAttemptId` (`openSession({parentAttemptId})`; a resumed engine session inherits it). An attempt may message
only its parent and its children; the MCP host refuses anything else with a message naming the lead. The tools
below exist only for attempts that have a parent or whose role is in `COORDINATOR_ROLES` (`lead`); the lead's own
tools are in §8.4:

- `list_agents()` — the caller's parent and children (attempt id, role, task node, status)
- `send_message({to, kind, body, reply_to?})` — queue an `AgentMessage` (kinds §5); never blocks
- `wait_for_reply({message_id?, timeout_seconds?})` — the next message for the caller (a reply to `message_id`
  when given); `null` on timeout
- `ask_lead({question})` (parent only) — `send_message(question)` to the caller's *current* parent (`to: "lead"`) +
  `wait_for_reply` in one blocking call
- `spawn_research({title, brief, mode})` (coordinators) — open a researcher (`single`) or a research lead (`team`) as
  the caller's child; its report comes back as a `report` message (§8.5)
- `start_implementation({title, brief, clarify})`, `run_status()` (assistant only, §8.6)

Delivery: a message resolves a blocked `wait_for_reply` / `ask_lead` of its recipient at once; otherwise it stays
queued (`deliveredAt: null`) and is prepended to the prompt the next time the orchestrator resumes that recipient's
engine session (fix rounds, hand-backs, recovery), marked delivered then. Nothing is injected into a running turn:
the task driver would receive a turn it did not ask for. Messages and transcripts are separate: an agent sees
messages, never another agent's transcript. `messages.list({runId})` and the `message.updated` event expose them.

DAG and review output come back as structured output, not via MCP tools. Tool approvals do not go through
MCP either: both adapters receive them in-band (§6). The Claude adapter pre-approves every Legion tool
(`--allowedTools mcp__legion`). The server also has an `approve` tool: an unused fallback (no CLI is configured to
call it); the orchestrator still routes it to an `approval` inbox item. Coders get the task-report output schema
too, so a turn that ends with a valid structured report counts even without `mark_task_done` (the fake engine
relies on this); when both exist the structured report wins.

## 8. Orchestration flow

1. **Create run** (composer): repo, base ref (default: current default branch), issue text/URL, planner engine. A
   repo without commits is refused (runs branch from a commit); the composer offers `repos.initialCommit` (its
   files, `.gitignore` applied, as "Initial commit").
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
   - Review (other engine, fresh session, read-only): input = node spec, issue, `git diff <diff base>..HEAD` (§8.1 Diffs),
     verify results, scope report → `Review`. Approve iff all criteria met and no blocker/major.
   - Fix loop: send blocker/major findings back to the coder session (resume), re-verify, re-review.
     Max 2 fix rounds, then escalate to inbox.
   - High-risk nodes, and tasks whose diff touches agent/CI/hook config or package scripts (§6) →
     `awaiting_human` after approval.
   - Merge queue (serialized): `git merge-tree --write-tree` forecast; clean → squash-merge into integration
     worktree, commit `T<n>: <title>`, run post-merge verify; failure → reset integration to the pre-merge SHA,
     send the task back to fixing with integration HEAD merged into its branch. Conflicts → resolver session
     (coder engine) in the task worktree; 2 failures → inbox. Lockfiles: never hand-merged — take integration's
     side, regenerate with the non-frozen lockfile command, commit it; a failed regeneration → inbox.
   - Failure: retry up to 2 more attempts from a reset worktree with the failure summary; then `failed`,
     downstream `blocked`, inbox escalation (retry / skip / edit / abort).
7. **Finalize**: full verify on integration; final holistic review (engine other than the majority of coders)
   over `base...integration`; blocker findings → inbox.
8. **PR**: `git push -u origin legion/<run>/integration`, `gh pr create --draft --base <base> --title … --body-file …`.
   Body: issue link, plan summary, task table (engine, reviewer verdict), verification, minor findings, run id.
9. **Cleanup** (`runs.archive({runId, force?})`, also run automatically when the PR is **merged**): an active run
   is refused unless `force` (which cancels it first). Close its sessions and takeover terminals, then remove
   worktrees and local branches **only where no work is lost**: a worktree with uncommitted changes is kept, a task
   branch with commits or content in neither integration nor the base (content check via `merge-tree`, since
   tasks are squash-merged) is kept (`force` removes both anyway); the integration branch is deleted only when
   the PR was merged, or closed with the branch fully pushed to its upstream, or when it has nothing beyond the
   base (`force` never deletes it). The result's `archiveReport` lists what was kept and why. Restore
   `gc.auto`, set `archived: true` (hidden from `runs.list` unless `includeArchived`). Idempotent.

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
  the task branch. Conflict → merge integration into the task branch, lockfiles take integration's side and are
  regenerated with the lockfile command (`legion.json` `lockfileCommand`, else `pnpm install --lockfile-only`,
  `npm install --package-lock-only`, `yarn install`, `bun install --lockfile-only`; exit code checked, the lockfile
  committed, a failure escalates the task), a `resolver` session (coder engine) handles the rest, `finishMerge`, forecast again.
  Exhausted resolver attempts → `conflict` item (`retry` = back into the merge queue with a fresh budget). When a
  resolver is needed (the forecast has non-lockfile conflicts) but the run is paused or the coder engine is rate
  limited, the queue parks *before* touching git (`mergeParked`); the tick does not restart it until the run
  resumes or the limit resets (a wake timer is armed at the reset).
- **Escalations**: task items carry `taskId`; run-level items (`taskId: null`) come from the final verify
  (`verify_failed`), the final review (`final_review`) or a finalizer that cannot run (`other`), with actions `[retry,
  skip, abort]`: retry reruns the step, skip moves on (integrating → finalizing → pr_ready), abort cancels the run.
  Task retry (`tasks.retry`, escalation `retry`) resumes the step that failed when the task has work to keep: the
  escalation payload's `resume` (also `TaskMeta.resumeStep`) is `review` (reviewer failed → `reviewing`), `merge`
  (merge failed, conflict unresolved, lockfile regeneration failed, high-risk gate → `approved`, fresh resolver
  budget), `fix` (fix rounds or verify exhausted, reviewer asked for a re-plan, agent blocked → `fixing` in the same
  coder session with a fresh fix budget and the note) or `code` (coder auth failure → `running` in the existing
  worktree). Without `resume` (or for `failed` tasks) retry starts over. Starting over explicitly: `tasks.restart
  ({taskId, note?})` or the escalation resolution `restart` (accepted wherever `retry` is offered): fresh worktree from
  integration, fresh attempt budget, the note as context. Task `edit` = start over with the note as context for the
  next attempt. Answering through `inbox.resolve` and through the `tasks.*` procedures is equivalent; both resolve
  the item.
- **Rate limits**: a `rate_limit` event with `usedPct ≥ 95`, or a retryable 429-like error, pauses new sessions on that
  engine until the reset (60 s when unknown); the failed coder attempt is re-queued without being charged.
- **Budget**: `settings.budget.perRunUsd` (or a per-run limit raised through the `budget` item) reached → run paused +
  `budget` item; `raise` (default 1.5× the spend) resumes, `stop` cancels. A notification fires at `warnAtPct`.
- **Pause** gates new agent sessions (dispatch, reviewers, fixers, resolvers, finalizer); turns in flight finish.
  **Cancel** cancels open tasks and attempts, dismisses open inbox items, interrupts and closes live sessions and
  takeover terminals (worktrees are kept).
- **Attachments** (`engine/attachments/`): `attachments.add` sniffs the content (PNG/JPEG/GIF/WebP ≤ 10 MB;
  UTF-8 text/code and PDF ≤ 2 MB; ≤ 10 per run/answer/message), stores `<dataDir>/attachments/<sha256>.<ext>` and
  an `attachments` row (`run_id` null = draft); drafts unclaimed for a day are deleted with files no row references
  (at start and hourly). `runs.create`, `runs.answerClarify` and `sessions.send` take `attachmentIds` and claim them.
  The planner's first message carries the run's attachments, the resumed plan prompt the clarify answers' ones;
  fresh coder sessions, reviewers and the finalizer get all of them (`Orchestrator.runAttachments`) and the issue
  section of their prompt names them; resumed sessions (fix rounds, hand-back) do not resend them. The PR body
  lists the names. Steer messages carry their own.
- **Steering**: `sessions.send` / `sessions.interrupt` need a live session; a human interrupt does not end the step,
  the session waits for the next message. **Takeover**: `sessions.takeover` interrupts and closes the adapter
  session, marks the attempt `interrupted` (`error: "taken over by a human"`) and opens a PTY running
  `claude --resume <id>` / `codex resume <id>` (with Legion's `CODEX_HOME`) in the attempt's worktree. When the PTY
  exits, the adapter session is resumed with a hand-back prompt and the attempt is `running` again, but only while
  the attempt, its run (not terminal, not archived) and its task are still live, checked before and after the
  resume; otherwise the resumed process is closed and the attempt is `cancelled`. The renderer
  attaches with `terminals.open({target: {kind: "attempt", attemptId}, terminalId, cols, rows})`.
- **Diffs**: task = its diff base → the task worktree including uncommitted and untracked files (staged into a
  throwaway index); once the worktree is gone, `base..branch`. The diff base (`taskDiffBase`) is the merge-base of
  the task branch with integration: `startSha` until integration is merged into the task branch (post-merge fix
  round, conflict resolution), then that integration commit, so the task's diff, scope check, sensitive-change
  check and reviewer input never include other tasks' merged code. Run = `base...integration`.
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
  read it again through the `PrHost` (`gh pr view`). A merged or closed PR moves a still-open run to `done`; only a
  merged one archives it (§8 step 9). A closed PR keeps everything (it may be reopened; the work is not in the
  base) and is no longer polled. The coder's final report is copied to `task.report` (cleared when a fresh attempt starts).
- **Settings**: `settings.updated` rebuilds an engine whose binary path changed (`EngineRegistry.reconfigure`, then
  a re-probe); live sessions keep their instance. Models, effort and `enabled` are read at each session start.
- **Fake mode**: the demo script (`demo.ts`) hits every human touch point once: one clarify question, a 3-task plan
  (T2 after T1), a tool approval (T3's coder), a major review finding on T2 fixed in the next round, the PR gate. The
  PR host is `FakePrHost({ push: false })`: nothing is pushed, GitHub is never called.

### 8.4 The implementation lead (`orchestrator/lead.ts`)

With `settings.lead.enabled` (default on) every run gets a **lead** once its plan is approved: one `coordinate`
session (role `lead`, the run's planner engine, `settings.roles.lead`) that holds the approved plan as its ledger
and coordinates the coders. The planner still plans (it reads the repo; a lead cannot); the lead takes over at
approval.

- **One attempt for the run's life.** The lead process stays alive and idle between turns. The lead loop wakes it
  with one message per batch of news: queued messages (a coder's `ask_lead`), board changes (task status changes
  since the last wake, with the report summary or error), and the human's answer to an amendment. A wake is sent only
  after the previous turn ended; the lead ends each turn when it is done and never blocks in `wait_for_reply`.
- **Dispatch waits for the lead.** Tasks are not dispatched until the lead attempt exists, so every coder (and
  resolver) is opened with `parentAttemptId` set and its prompt names `ask_lead`. If the lead process dies, the loop
  resumes its engine session as a new attempt and re-parents the children of the old one; `ask_lead` sends to the
  caller's *current* parent (`to: "lead"`). After `MAX_LEAD_FAILURES` (3) consecutive failures without a completed
  turn the lead is given up (`RunMeta.leadDisabled`) and the run goes on without one.
- **The whole plan**: coders get it as `.legion/plan.md` in their worktree (the approved markdown with every
  contract, then every task's spec; the folder ignores itself, so it is never committed), written before each
  coder session and refreshed after each applied amendment; the lead reads it with `read_plan({section?})`.
- **Lead tools** (role `lead`): `plan_status` (the board), `read_plan`, `add_task(node)`, `amend_task(node_id, patch)` and
  `cancel_task(node_id, reason)` (the last two for tasks still blocked or queued). Each change is a new plan version
  (source `agent`, markdown gets an "Amendment" section) validated with `validatePlan`. **Policy** (`core/lead.ts`):
  a new node applies at once when its risk is not `high` and every write touch stays inside a directory the approved
  plan already writes to; a changed node only when it does not become high risk or gain such a write (rewording a
  high-risk task applies at once); otherwise the version waits as a `plan_signoff` inbox item (`RunMeta.amendment`,
  its payload's `amendment` says what changed and why it needs the human), and
  `runs.approvePlan` / `runs.requestPlanRevision` on that version apply or reject it (the lead hears the answer on
  its next wake). Only one amendment may wait at a time. Applying inserts tasks for the new nodes; the scheduler
  picks them up on the next tick.
- Recovery: the lead attempt is `interrupted → failed` like other run-level attempts; the executing run's first
  tick restarts the loop, which resumes the session.

### 8.5 Research agents (`orchestrator/research.ts`)

Coordinators (the lead; the assistant later) can spawn research with the `spawn_research({title, brief, mode})`
MCP tool. Research agents read and never write, so they can never make a decision that conflicts with a coder's.

- **Roles**: `researcher` = read-only + web (`PermissionProfile.web`: Claude pre-approves `WebSearch`/`WebFetch`,
  Codex sets `web_search = "live"`); `research_lead` = coordinate + web, a coordinator that splits a broad brief over
  researchers (`spawn_research` single only) and synthesises. Engines and models: `settings.roles.researcher` /
  `research_lead`. Both run in the integration worktree with an untrusted config (§6) and the run's attachments.
- **Tree and caps** (`core/research.ts`): a research agent is a child of the caller (parent ↔ child messaging as
  usual). A lead may have 3 research agents running, a research lead 4; a research lead cannot spawn a team, so the
  tree is at most lead → research lead → researchers.
- **Reports**: every research agent ends its turn with a `ResearchReport` (structured output, `schemas/research.ts`:
  summary, findings `{claim, evidence, sources}`, open questions, confidence). The driver renders it to markdown
  (`formatResearchReport`, bounded to 12k characters) and posts it to the parent as a `report` message, then closes
  the agent; a failure posts a `status` message so the parent never waits on a dead child. The lead reads reports on
  its next wake; a research lead blocks in `wait_for_reply` for each of its researchers.

### 8.6 The assistant (`orchestrator/assistant.ts`)

The human's conversation partner: a `coordinate` session (role `assistant`, `settings.roles.assistant`,
`settings.assistant.enabled`) that talks to the human and to agents and nothing else. A conversation is a run:
`runs.chat({repoPath, baseRef, prompt, engine, model, attachmentIds})` creates a run in status **`chatting`** whose
first message is the prompt and opens the assistant (engine = the run's planner engine). The human keeps talking
through `sessions.send` on the assistant attempt: its process stays alive and idle between turns.

- **Tools** (role `assistant`): `start_implementation({title, brief, clarify})` moves the run to `clarifying` or
  `planning` with the brief as the issue text (the usual flow follows: clarify questions and plan sign-off in the
  inbox, then the lead, whose parent is the assistant); `run_status` (status, plan, every task, what waits for the
  human, PR); plus the coordinator tools (`list_agents`, `send_message`, `wait_for_reply`, `spawn_research`,
  research cap 3). A conversation that never starts work stays `chatting` until archived or cancelled.
- **Steering the planner**: planner attempts of a run with an assistant are its children (reviewers likewise sit
  under the lead). Neither has mailbox tools. A message to a working agent that is not waiting for it (a planner via
  `to: "planner"`, a coder, a reviewer) is passed into its running turn as a queued user message, like a human
  steer; the Claude adapter reports a message the turn could not take in together with the turn it starts. With
  no turn running, it is prepended to the agent's next prompt.
- **Wakes**: like the lead loop, one message per batch of news: queued messages (the lead's questions and reports,
  research reports) and conversation changes (run status transitions, new inbox items waiting for the human, and
  what the human decided on resolved ones: clarify answers, plan approval or requested changes). The
  store's `run.updated` and `inbox.updated` events wake it. The lead sends decisions that are the human's to its
  parent (kind `question`) instead of `request_human_input` when it has one.
- **Failures**: resumed as a new attempt with its children re-parented; after `MAX_ASSISTANT_FAILURES` (3) without
  a completed turn it is given up (`RunMeta.assistantDisabled`), and a run still `chatting` fails.

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
  step reruns. Approval and agent-question items are dismissed (their sessions are gone). `pending` merges are settled
  (`settlePendingMerges`, also run before the merge queue merges anything): only the newest pending row is rolled
  back (`resetIntegration(preSha)`), and only when integration's HEAD is its squash commit (the `postSha` recorded
  right after the squash, or a commit whose parent is `preSha`) and no later merge completed; every pending row ends
  `reverted`, never resetting over later merges. The task is merged again; an empty re-merge after such a row is
  still verified. A merge row stays `pending` until integration is back at a known state: a failed post-merge
  verify resets integration first and then writes `verify_failed` → `reverted`; an exception after the squash
  resets integration and closes the row before escalating. `git worktree list` is reconciled
  with the DB: missing worktrees are restored from their branch, else the task is re-queued without charging the
  attempt; unknown worktrees under Legion's directory are only logged. Conflict merges left in progress are aborted.
  Planner and finalize jobs restart; dispatch resumes. Before every integration merge record the pre-merge SHA.
- Worktree hygiene: what provisioning leaves untracked (copy/symlink targets, setup output) is recorded
  (`task:<id>.provisioned`, `run:<id>.integrationKeep`), never committed (`commitAll`/`finishMerge` exclude it)
  and kept when cleaning. Everything else Legion's own commands leave behind is discarded with
  `reset --hard HEAD` + `clean -fd` (never `-x`: ignored dependencies and caches stay for the next verify): in
  the integration worktree after setup, after a passing post-merge verify, after the final verify and before
  every squash merge (Legion owns that tree, so its dirt can only be Legion's); in a task worktree right after
  verify (the agent's work is already committed, so the rest is verify output: stamps, coverage, formatter
  rewrites). Setup output a later verify needs must therefore be untracked by setup itself or gitignored.
- Per-repo config `legion.json` (optional): `{ setup?: string[], verify?: string[], copy?: string[],
  symlink?: string[], highRiskGlobs?: string[], installCommand?: string,
  lockfileCommand?: string }`.
- App data: `~/Library/Application Support/Legion/legion.db` and `attachments/` (override with `LEGION_HOME` for
  tests).

### 5.1 Projects (`engine/projects/`, migration 004)

A project is a checkout the user works in: the rail's top level. `projects.add({path})` accepts any folder inside a
git checkout and stores the real top-level path (idempotent, stamps `lastOpenedAt`); `runs.create` adds the run's
project when needed and sets `run.projectId` (migration 004 backfilled one project per distinct `repo_path` of
existing runs). `projects.remove` only forgets the row (runs keep `projectId: null`; nothing on disk changes).
Changes are `project.updated {project, removed}` events. `projects.status` (branch, dirty, ahead/behind) feeds the
rail; `projects.info` the project home (remotes, gh, README, languages by bytes, size, last commit, commit count).

Browsing is **read-only and confined to the project root**. Visible files = `git ls-files --cached --others
--exclude-standard` minus deleted ones (cached ~5 s per root; the tree, `files.find` and the stats share it), so
ignored files (`.env`, `node_modules`, ...) never show. Every path is repo-relative and checked lexically (no absolute
paths, `..`, backslashes, NUL, or a `.git` segment) and again after `realpath` (must stay inside the root's real path
and outside `.git`): symlinks are listed as `symlink` and never followed out. `files.read` only serves files of the
index (text with BOM / UTF-8 / Latin-1 detection, cut at a line end after `maxBytes` (default 1 MiB) with
`truncated`; NUL in the first 8000 bytes = `binary`; png/jpg/gif/webp/svg/ico/avif/bmp ≤ 8 MiB as base64, larger
`too_large`). `files.search` = `git grep -n -I --column -z --untracked --full-name [-i] -F|-E -e <q> --` (argv only,
bad patterns → `bad_request`, long lines clipped around the match). `git.log` / `git.show` (`--end-of-options`,
revisions without `-`, whitespace or `..`) return `Commit`s with decorations and a commit's diff against its first
parent (root commits against the empty tree) in the `diff.get` shape; `diff.get` also takes `{kind: 'commit',
projectId, sha}`. `prs.list` = `gh pr list --json …` with `available: false` + a reason when gh is missing, signed
out or there is no GitHub remote.

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

- Concept: projects are the top level; workspace = run; strip of columns = tasks (plus plan/DAG/PR tiles); tile = a
  view; layout modes Strip / Focus / Overview / Pipeline; urgency borders; overlays: composer (⌘N), inbox (⌘I),
  palette (⌘K), add a project (⌘⇧N), go to file (⌘P); waybar-style status bar. See `docs/research/tiling-ux.md`.
- Rail: projects (name, branch, uncommitted-changes dot, active runs / needs-you), each expandable to its runs.
  Workspace numbers (⌘1–9) follow the rail: runs grouped by project (pinned first, then in the order added).
  Runs whose project was removed are grouped by repository. Archived runs stay hidden unless asked for.
- Project home: with an active project and no active run (`uiStore.activeProjectId`, `activeRunId: null`), the
  project's own workspace is on screen: a layout tree stored under `project:<id>` (always Strip). Default columns:
  Overview (README rendered with repo-relative links/images, facts, languages, New run / Go to file / Search /
  Terminal / Finder), Activity (runs, open PRs, git history), Files (lazy tree, filter, keyboard). Files, commits and
  search hits open in a *preview* column right of their source (`layout/project.ts`, reused per kind; ⌘⏎/⌘-click =
  a new column): the code viewer (Shiki in the diff worker, virtualized, image and Markdown previews, binary/size
  guards), the diff tile for commits, the search tile (⌘⇧F). Selecting lines in the code viewer → "Start a run about
  this…" (⌘⏎) opens the composer with the project and a `path:lines` reference. Adding a project opens its home,
  never the composer; ⌘N preselects the project on screen (`app/composer-seed.ts`); ⌘⇧H returns to the home. The
  empty state leads with adding a project (and lists checkouts found on this Mac).
- Coordination (§8.4-8.6): the composer's prompt starts a conversation with the assistant (`runs.chat`) unless
  "Plan directly" is ticked (`runs.create`). A run with an assistant gets a first `assistant` column holding its
  session tile (the transcript is the conversation, the steer bar the reply box; focus lands there while
  `chatting`). A run with an assistant or a lead also gets an `agents` column (stacked `agents` tile = the attempt
  tree by `parentAttemptId` with status and queued-message counts, click opens the agent's session; `messages` tile
  = every agent-to-agent message), open while executing. Settings → Runs → Coordination switches both off.
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
  drive native dialogs), `LEGION_E2E_PICK_FILES=<path>:<path>…` the attach-files dialog; `LEGION_SELFTEST=1` makes the engine spawn a PTY and query node:sqlite after start and log
  `selftest ok …` (`pnpm test:packaged` uses it on the packaged app).

- `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass before you report done. Add tests for logic you write.
- Never run real `claude`/`codex` sessions in the default test suite. Live tests live under
  `*.live.test.ts`, run only with `LEGION_LIVE=1`, use the cheapest model (`haiku` / Codex low effort) and tiny prompts.
- Never push, never open PRs, never touch remotes, never modify `~/.claude` or `~/.codex`.
- Keep comments sparse and useful. No placeholder TODO stubs in code you report as done.
