# Legion architecture

Legion is a desktop app for macOS, Linux and Windows (Electron + TypeScript) that takes an issue through
**clarify → plan → task DAG → parallel coding agents → cross-engine review → integration branch → draft PR**,
driving both **Claude Code** and **Codex** through their own CLIs. The UI is a niri-style scrollable tiling
workspace. Background research lives in `docs/research/`; the visual reference is the mockup at
https://claude.ai/artifact/A818rw2Q72GGGFwcfVkbkT (Catppuccin Mocha, Geist / Geist Mono).

This document is the contract every contributor (human or agent) builds against. If code and this
document disagree, fix one of them in the same change.

## 1. Product decisions (v1)

| Topic | Decision |
|---|---|
| Platform | macOS and Linux (arm64 + x64), tested in CI-style runs (`pnpm test:linux`). Windows (x64 + arm64) is implemented but not yet verified on a Windows machine (`docs/windows-testing.md`). OS-specific behaviour goes behind the platform interfaces (§3 "Platforms"). |
| Claude Code | Spawn the user's installed `claude` CLI: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`. No Agent SDK. Auth = the user's own login (never touch tokens). |
| Codex | Spawn `codex app-server` (JSON-RPC 2.0 over stdio). Types generated with `codex app-server generate-ts --experimental` and committed. Auth = the user's own `codex login`. |
| Approvals | In-band for both engines, surfaced as `approval_request` events → inbox → `session.respond()`. Claude: `--permission-prompt-tool stdio` → `can_use_tool` control requests on stdout, answered with a `control_response` on stdin. Codex: `item/*/requestApproval` server requests. |
| Engine per role | Planner: user choice per run (default Claude). Coder: always the coder role in settings (engine and model). Plans carry only an effort per task; the planner and the lead never choose an engine or a model, and there is no per-task override. Reviewer: always the *other* engine than the task's coder (fallback: same engine, different model). |
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
  passes it, and the login shell itself as `SHELL`, to the engine via `env`. GUI-launched apps (Finder/Dock, a
  Linux `.desktop` launcher) do not inherit them.
- Port wiring: the engine posts `ready` on `parentPort`; only then does main create a `MessageChannelMain` per
  renderer (`connect` to the engine, `legion:engine-port` to the renderer). The preload forwards the port to the
  page with `window.postMessage` (ports can't cross contextBridge). The renderer asks for a port on every load;
  main re-wires every renderer after an engine restart (exponential backoff, counter reset after 60 s healthy).
- `LEGION_HOME` overrides the data dir (`<appData>/Legion`: `~/Library/Application Support/Legion` on macOS,
  `~/.config/Legion` on Linux); when set, Chromium's profile
  goes to `$LEGION_HOME/chromium` so isolated instances don't share the single-instance lock.
- macOS: the window uses `vibrancy: 'under-window'` with an opaque `#11111b` background (no white flash). Vibrancy
  only shows through if the window background is made transparent; that is a design decision for chrome/.
- The engine must not import `electron` except behind `process.parentPort` checks, so it can run in plain
  Node (tests, headless runs). `node:sqlite` is used precisely so the DB works in both.
- Engine state survives renderer reloads. On engine start it reconciles the DB with reality (§9).

### Platforms

Every process asks one interface what to do differently per OS instead of branching on `process.platform`; each
interface has one implementation per OS, picked once at startup. `shared/platform.ts` (pure) names the OS
(`Os = 'mac' | 'linux' | 'windows'`, `osOf(process.platform)`) and holds what two processes must agree on: the
title bar (`titleBarFor(os)`: macOS insets the traffic lights into Legion's title bar, elsewhere the native window
controls are drawn over its end with Window Controls Overlay, and the renderer keeps clear of them through the
`titlebar-area-*` CSS env variables).

| Process | Interface | Covers | Implementations |
|---|---|---|---|
| main | `MainPlatform` (`main/platform/`) | startup identity (Windows app id), BrowserWindow chrome, recolouring overlay controls on theme change, the child environment (login-shell `PATH` + `SHELL`; on Windows one `PATH` key and git long paths), the icon badge (taskbar overlay dot on Windows), quit on last window | `mac.ts`, `linux.ts`, `windows.ts` |
| engine | `EnginePlatform` (`engine/platform/`) | the interactive shell a terminal tile opens, finding executables (PATHEXT on Windows), launching them without a shell (an npm `.cmd` shim runs as `node <script>`), stopping process trees, the shell `legion.json` commands run in (Git Bash on Windows), the self-test's echo | `posix.ts` (macOS + Linux), `windows.ts` |
| renderer | `app/platform.ts` + `app/keys.ts` | `OS`/`IS_MAC`, the title bar spec, how UI copy names the file manager and writes paths; chord matching and labels | constants per `Os` |

Keyboard: bindings are written once (`Mod+K`); `Mod` is ⌘ on macOS and Ctrl elsewhere, a binding's own `Ctrl` is
⌃ on macOS and Ctrl elsewhere, and `Mod+Ctrl` becomes Ctrl+Super off macOS. Off macOS Ctrl is also what shells and
vim run on, so a focused terminal (or an element marked `data-ctrl-keys`, the vim editor) keeps bare Ctrl+<letter>
(`yieldsToControlKeys`); the terminal copies and pastes with Ctrl+Shift+C/V. UI copy never spells a chord out:
`<Kbd chord="Mod+Enter" />`, `formatChord`, `formatModifiers`.

Paths: the engine uses `node:path` and compares paths after `realpath` (git prints `C:/…`, Node `C:\…`); the
renderer, which has no `node:path`, uses `shared/paths.ts` (`isAbsolutePath`, `normalizePath`, `abbreviateHome`, …
per `Os`). Links go through `engine/util/links.ts`: directories become junctions on Windows (no privilege needed),
files a symlink or, where Windows refuses one, a copy; Codex's `auth.json` falls back to the user's own
`CODEX_HOME` instead, since a copied login would split on token refresh. Off macOS, AltGr (Ctrl+Alt on Windows)
never triggers a command.

Adding an OS: implement `MainPlatform` and `EnginePlatform`, map the `Os` in each `IMPLEMENTATIONS` table, add an
`electron-builder.yml` section and a `packagedLayout()` case in `tests/e2e/packaged.spec.ts`. Write the
implementation against injected filesystem access and that OS's `node:path` flavour (as `windows.ts` does with
`path.win32`) so its tests run on every host. `scripts/linux/check.sh [unit|e2e|packaged|all]` runs the Linux
checks in Docker from any host.

Known Windows gaps: Codex wraps commands in PowerShell, which `util/shell.ts` doesn't unwrap, so a read-only Codex
agent's shell commands fail the allowlist and ask for approval instead (safe, noisy); arguments can't hold newlines
through the `cmd.exe` fallback (only for `.cmd` files that aren't npm/pnpm shims); a command killed on timeout under
Git Bash or `shell: true` leaves its grandchildren running (as on POSIX).

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
           status: chatting → | session → | draft → clarifying → planning → awaiting_approval → executing → integrating
                   → finalizing → pr_ready → done | failed | cancelled   (+ paused flag; chatting = a
                   conversation with the assistant, §8.6, that may become work or end as done/cancelled; session = a direct
                   session, §8.8, that ends as done/failed/cancelled)
Plan       id, runId, version, markdown, dag (PlanDag = {nodes, annotations}), source (agent|user), feedback?,
           createdAt, approvedAt?
TaskNode   (inside PlanDag) id "T1".., title, goal, kind (contracts|feature|test|refactor|docs|integration),
           dependsOn[], acceptanceCriteria[{id,text}], touches[{glob, mode: create|modify|read}],
           size S|M|L, verify{commands[]}, contextHints{files[],notes}, agent{engine, model?, effort?}, risk low|med|high
Task       runtime row per node: runId, nodeId, status, branch, worktreePath, startSha, attemptCount, fixRounds,
           mergedSha?, engine/model/effortOverride?, progress?, report? {summary, commitMessage}, error?
           status: blocked → queued → provisioning → running → verifying → reviewing → fixing
                   → approved → awaiting_human → merging → merged | failed | skipped | cancelled
Attempt    id, taskId?, runId, role (planner|coder|reviewer|resolver|finalizer|lead|researcher|research_lead|assistant|session), engine, model,
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
Presentation id, runId, taskId?, attemptId, title, caption?, attachments[]  — what an agent showed the human
           (`present`, §8.7; migration 006)
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
| planner, reviewer, finalizer | `--permission-mode default --permission-prompt-tool stdio`, `--allowedTools mcp__legion`, `--disallowedTools` edit tools + AskUserQuestion/Enter/ExitPlanMode. Reads inside cwd/`--add-dir` and commands the CLI classifies as read-only (`ls`, `git diff`, …) need no rule. What the CLI would ask about is answered by Legion, never a human (`adapters/claude/read-only-policy.ts`): Read/Grep/Glob on any path (`cat` already reads anywhere), `<tool> --version`-style probes, `command -v`, plain reads (`cd`, `find` without `-exec`/`-delete`, `sed -n 'N,Mp'`, …) and read-only `git` (also `-C <dir>`), alone or chained with `;` `&&` `\|\|` `\|`, with `~/`, `2>/dev/null`/`2>&1` and, for programs no file name can turn into a writer, `*`/`?` globs; anything else is denied with a message. The same rules are appended to the system prompt (`READ_ONLY_GUIDE`) so the agent does not learn them by being denied. Not `dontAsk`: it calls nobody and denies every command off the CLI's fixed read-only set (not configurable), so one unlisted part (`… ; npm -v`) fails a whole chain. | `sandbox: read-only`, `approvalPolicy: never` |
| researcher | as above plus `--allowedTools WebSearch,WebFetch` (`PermissionProfile.web`) | as above plus `web_search = "live"` |
| coder, resolver, session | `--permission-mode acceptEdits` (edits inside the working dirs), `--allowedTools` = `Bash(<cmd>)`/`Bash(<cmd> *)` per verify command + `mcp__legion`; everything else → `--permission-prompt-tool stdio` → `approval_request` (or `--permission-prompts none` when `askHuman` is false). `settings.permissions.approvals = auto` (default): switched to auto mode over the control protocol (kept in `acceptEdits` when the model has none) | `sandbox: workspace-write` (cwd = worktree), `approvalPolicy: on-request` → requestApproval → inbox; `auto`: `approvalsReviewer: auto_review` |
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
'{"autoMemoryEnabled":false}'` (otherwise the agent may write `~/.claude/projects/<cwd>/memory/`). The exception
is a direct session (⌘⇧N) without a skill allowlist (`SessionOptions.userSettings`): it is the human's own, so
Claude runs like plain `claude` (`--setting-sources user,project,local`, the user's MCP servers, no flag settings). Variables of a
*parent* Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) are stripped from the child env. Codex runs with a
Legion-owned `CODEX_HOME` (`<dataDir>/codex-home`) containing only a **symlink** to the user's `auth.json`
(codex writes it in place, so token refreshes reach the user's file; `app-server` has no `--ignore-user-config`)
plus `-c features.hooks=false` etc. Codex threads live in that home, so resume/takeover must use it.
Details: `src/engine/adapters/codex/README.md`.

Agent access (MCP servers and skills). Isolation means a session has no MCP servers or skills of the user's by
default. `settings.mcpServers` is a registry (name → `http` URL + headers, or `stdio` command + args + env; the name
becomes the tool prefix, `legion` is reserved) and `settings.access[projectId][role] = { mcp: string[], skills:
string[] | null }` says what a role gets in that project (`skills: null` = the CLI's default set; `[]` = none). Both
go through `settings.set` (`null` removes a server or clears a role; removing a server or a project drops its
grants). The orchestrator resolves the grant when it opens a session (`engine/access/resolve.ts` →
`SessionOptions.extraMcp` / `.skills`); `coordinate` roles never get any, and running sessions are not changed.
- Claude: the servers join `--mcp-config` (still `--strict-mcp-config`) and are pre-approved as `mcp__<name>`. A skill
  allowlist sets `disableBundledSkills`, turns off by name (`skillOverrides`) the repo's `.claude/skills` that are not
  listed, and exposes the user's listed skills through a per-session plugin (`--plugin-dir`, symlinks; they appear as
  `legion-skills:<name>`). Skill calls need no permission rule. Verified against claude 2.1.292.
- Codex: the servers join the thread's `mcp_servers` (`default_tools_approval_mode: approve`). A skill allowlist disables
  by name (`-c skills.config=[{name,enabled=false}]` on the session's own app-server) every repo (`.agents/skills`),
  user and system skill that is not listed, and registers the listed user skills as an extra root
  (`skills/extraRoots/set`). Verified against codex-cli 0.160.0.
- Discovery: `skills.list` (user: `~/.claude/skills`, `~/.agents/skills`; repo: `.claude/skills`, `.agents/skills`)
  and `mcpServers.discover` (`~/.claude.json`, the project's `.mcp.json`) feed Settings → Access. A granted server is
  approved up front, so it can use all of its tools (there is no per-tool allowlist).

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
- `start_implementation({title, brief, clarify})`, `run_status()`, `read_plan({section?})`, `revise_plan({changes})`
  (assistant only, §8.6)

Every agent also has `present({title, caption?, files?, markdown?})` (§8.7): files and/or a markdown document to
show the human in the run's conversation. Coordinators have no files, so their schema offers `markdown` only.

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
   - Verify: run the task's **gates** (§8.0) — every command gate (no fail-fast), then the built-in scope and
     secret-scan gates on the task diff; blocking failures enter the fix loop.
   - Review (other engine, fresh session, read-only): input = node spec, issue, `git diff <diff base>..HEAD` (§8.1 Diffs),
     verify results, scope report → `Review`. Approve iff all criteria met and no blocker/major.
   - Fix loop: send blocker/major findings back to the coder session (resume), re-verify, re-review.
     Max 2 fix rounds, then escalate to inbox.
   - High-risk nodes, and tasks whose diff touches agent/CI/hook config or package scripts (§6) →
     `awaiting_human` after approval.
   - Merge queue (serialized): `git merge-tree --write-tree` forecast; clean → squash-merge into integration
     worktree, commit `T<n>: <title>`, run post-merge verify (command gates, §8.0); blocking failure → reset integration to the pre-merge SHA,
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
   `discard: true` (implies `force`; also on an archived run, from the report dialog or the sidebar) removes
   everything kept, the integration branch included; nothing on the remote is touched.

### 8.0 Gates (`orchestrator/core/gates.ts`, `git/detect.ts`, `core/secrets.ts`, `core/scope.ts`)

A gate is a named check with a structured result. Kinds (`GateKind`): `command` (a shell command), `scope` and
`secrets` (built-ins; their row's `command` is `legion:scope` / `legion:secrets`). Each result is a
`verifications` row with, besides `command`/`exitCode`/`outputTail`/`durationMs`, the gate fields `gate` (name),
`kind`, `status` (`pass` | `fail` | `skipped`), `summary` (one line) and `blocking`. Migration `008_gates` added
them plus `verification_outputs` (full output, capped at 1 MB, excluded from snapshots), served lazily by
`verifications.output`. Legacy rows (gate fields null) are classified from their command.

**Resolution** (`resolveGates({config, detected, taskCommands})`), in order. A command (trimmed) runs once, under
the first source that names it; colliding names, and the built-in names `scope` and `secrets`
(`BUILTIN_GATE_NAMES`), get `-2`, `-3`, ...:
1. legion.json `gates.commands` (source `config`); a string is blocking, `{run, blocking}` may be non-blocking, and
   `false` suppresses that name (for `verify` entries and detected gates);
2. legacy `verify` entries (source `verify`), named by `gateNameFor(command)` (`pnpm test` → `test`); one whose
   command differs from a same-named configured gate still runs, suffixed (`test-2`);
3. detected gates whose name isn't defined or suppressed above (source `detected`, only when `gates.detect` is on);
4. the task's own `verify.commands` (source `task`).

**Detection** (`detectProjectGates(dir)`) runs a `DETECTORS` registry of `ProjectDetector = {id, detect(dir)}`;
only `node` exists: `test`, `typecheck` (`typecheck` / `type-check`) and `lint` scripts of package.json, run with
`detectPackageManager` (`packageManager` field, else the lockfile, else npm). New ecosystems add a detector.
`orchestrator.repoInput()` is synchronous and resolves without detection, so the planner sees only config and
`verify` gates; detected gates are resolved at verify time (`resolveTaskGates`).

**Settings** (`resolveGateSettings`): `detect` (default `true`), `scope` (`block` default | `warn`), `secrets`
(`block` default | `warn` | `off`, plus `allow` globs).
- **Secret scan** (`scanSecrets(diff, {allow})`): built-in rules over the added lines of the task diff, no external
  tool; findings report file, line and rule with the value masked (it is never stored). Skipped: lockfiles,
  `allow` globs, placeholders / env references, and lines containing `legion:allow-secret`.
- **Scope** (`scopeGateResult(report, mode)`): changed files vs declared `touches`; `warn` keeps the old
  informational behaviour, `block` (default) fails the gate. Lockfiles stay allowed when an install command
  exists. Since scope blocks by default, tests that deliberately write outside their touches set
  `gates.scope: 'warn'`.

**Flow.** Task verify runs `runGates` over the resolved command gates, then scope and secrets, then the unchanged
sensitive-change check; `decideAfterVerify(task, gatesPassed(results))` — only failed **blocking** gates fail it,
non-blocking failures are warnings. The failed blocking `GateResult`s go into `fix.failedVerify` and so into the
coder's fix brief. Post-merge verify runs the install (if any), then the task's command gates plus scope and
secrets over the squash (`preSha..mergedSha`, via `builtinGates`), so edits a conflict resolver made after task
verify are gated too; only blocking failures reset / revert the merge (`verify_failed`). Final verify runs the
repo-level command gates, falling back to the merged nodes' verify commands when none resolve, and escalates with
the failing gate names. The review pack and the merge-gate card show `gateCounts` as "N/N green"; the PR body has
a Gate column.

**Editing in the app.** legion.json is the single source of truth; there is no app-local store.
`projects.gates({projectId})` returns `ProjectGates` (the file's `gates` and `verify`, the detected gates and
package manager, the resolved gates with their source, the effective settings and a `revision` = sha256 of the
file text, null when absent). `projects.setGates({projectId, revision, gates, verify?})` (`engine/projects/gates.ts`)
rejects a stale revision (`conflict`), invalid names, command gates named `scope` / `secrets`, blank or duplicate
entries (including `verify`), replaces only
`gates` (and `verify` when given; `gates: null` removes the key) while keeping the other keys, key order, indent
and trailing newline, and writes atomically. **Settings → Gates** (`renderer/overlays/Gates.tsx`, logic in
`gates-model.ts`) is the per-project editor over these two calls: detection toggle, command gates with a blocking
flag and source badges (a `verify` entry can be moved into `gates.commands`), scope mode and secret-scan mode and
allowlist. legion.json is a sensitive path for agents, so a coder can't silently relax gates.

**Role prompts.** Every session's system prompt is layered in `Orchestrator.openSession`
(`core/prompts/layers.ts` `composeSystemPrompt`): the role's built-in prompt, or the human's replacement
(`settings.roles.<role>.prompt.replace`, global only, used for every variant of the role), then their additions for
every project (`prompt.append`) under "## Additional instructions", then the repository's (legion.json
`prompts.<role>`, read at every start) under "## Additional instructions for this repository". The first message
(issue, plan, board) stays Legion's. `projects.prompts` / `projects.setPrompts({projectId, revision, prompts})`
(`engine/projects/prompts.ts`, sharing `legion-file.ts` with gates) read and change that key with the same revision
check and format-preserving write. **Settings → Agents** (`renderer/overlays/AgentsSettings.tsx`, project layer in
`prompts-model.ts`) shows the layers as a route per role, with the built-in text from `core/prompts/builtin.ts`.

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
  human, PR); `read_plan({section?})`, the latest plan version headed with where it stands (a draft waiting for
  sign-off, being revised, approved, or a change the lead proposed); `revise_plan({changes})`, the human's changes
  into the plan until it is signed off: while the planner clarifies or drafts it is a `brief` to the planner (see
  below), and while a plan waits for sign-off it is a requested revision like the human's (`requestPlanRevision`;
  the resolution carries `by: "assistant"`, the receipt says so, and the assistant is not told its own change
  back). After approval it is refused (the lead takes briefs). Plus the coordinator tools (`list_agents`,
  `send_message`, `wait_for_reply`, `spawn_research`, research cap 3). A conversation that never starts work stays
  `chatting` until archived or cancelled.
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
- **Status updates**: the lead, when it has the assistant as its parent, sends it a `status` message at milestones
  (a task merged, a review sent work back, a task stuck or failed, a plan change, the last merge): one per wake at
  most, a one-line headline and two lines of context (`core/prompts/lead.ts`). They wake the assistant like any
  message; its prompt tells it to relay what matters in a sentence or two, fold several into one message, and stay
  quiet about routine progress. The UI folds those messages under the reply they led to (§11).
- **The record of the conversation**: the human's messages are recorded in the assistant's transcript as
  `user_message` agent events (the first prompt by `openSession({humanMessage})`, later ones by `sessions.send`,
  which records them for every session). Legion's own wake prompts are never recorded as one, so the transcript
  alone tells the human's words from Legion's.

### 8.8 Direct sessions (`orchestrator/session-run.ts`)

⌘⇧N skips the whole flow: `runs.session({repoPath, prompt, engine, model, attachmentIds})` creates a run in status
**`session`** (base ref = the checked-out branch) and opens one agent (role `session`, `settings.roles.session`,
`workspace_write` like a coder) with `cwd` = the project's checkout itself: no worktree, no plan, no review, no
integration branch. With `worktree: true` ("Work in a new worktree", ⌘⇧W in the composer) the run gets its
integration branch and worktree instead, cut from `baseRef` (the composer's base branch picker), provisioned like a
run's (copy/symlink/setup), and `cwd` = that worktree: the checkout is left alone, and `runs.archive` keeps the
worktree while it has uncommitted edits and the branch while it has work found nowhere else. Its system prompt only
says where it works and that committing is the human's (the `ALWAYS_DENIED` git rules still apply). The human talks to it with `sessions.send`; approvals go to the inbox like a
coder's. The process lives only while the agent works: when its turn ends the loop stops it (the attempt succeeds),
and the human's next `sessions.send` (to any of the run's session attempts) resumes the engine session
(`RunMeta.sessionSessionId`) with that message as a new attempt. A turn cut off by a crash or an engine restart
(`RunMeta.sessionTurnOpen`) is resumed at once with a "continue" prompt; a session that was waiting for the human is
not woken. `MAX_SESSION_FAILURES` (3) failures in a row fail the run. `runs.cancel` stops it;
`runs.archive` ends it as `done` without `force` (nothing in it can be lost: the edits are already in the checkout,
or kept in its worktree). Takeover resumes it in a terminal where it works. The UI shows it as a conversation (§11) with the agent's tool
calls between its words and no progress strip; the full run composer stays on the palette ("New run with a plan…")
and on the new-conversation tile.

### 8.7 Presentations (`orchestrator/present.ts`)

`present` puts something in front of the human: screenshots, a rendered report, a document. Files are resolved
against the agent's working directory and must lie inside it or the system temp dir (symlinks resolved; coders are
told to save screenshots to the temp dir so nothing lands in the commit). Each file, and the markdown document
(`<title>.md`), is copied into the attachment store and claimed by the run, so a presentation outlives the worktree
(and `runs.archive({discard})`). One `presentations` row per call, a `presentation.created` event, and
`RunSnapshot.presentations`. Files that cannot be read are skipped with an error naming them; with nothing left the
call fails. The assistant hears of a presentation on its next wake (who showed what, and the caption) so it can
refer to it, but the presentation reaches the human as the agent made it, not paraphrased.

## 9. Git & filesystem conventions

- Worktrees: `<data dir>/worktrees/<repoHash>/<runId>/<taskId>/` and `.../_integration/`.
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
- App data: `<data dir>/legion.db` and `attachments/` (the data dir is `<appData>/Legion`, §3; override with
  `LEGION_HOME` for tests).

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

- Concept: projects are the top level; a run is a **conversation** (chat view, the default) whose agents work
  offstage in the **agents view** (⌘E toggles; the title bar's Chat | Agents switch). The agents view is the tiling
  workspace: strip of columns = tasks (plus plan/DAG/PR tiles); tile = a view; layout modes Strip / Focus /
  Overview / Pipeline (switching to one shows the agents). Overlays: session composer (⌘⇧N, §8.8), run composer
  (palette, "Branch and engine…"), palette (⌘K), add a project (⌘O), go to file (⌘P). The status bar carries usage only (run spend, rate limits; the key mode in the agents view).
  See `docs/research/tiling-ux.md`.
- Conversation (`renderer/chat/`): `thread.ts` folds the assistant attempts' transcripts (`user_message` = the
  human; final `message`s replace their streamed deltas), the agents' messages to the assistant (under the reply
  they led to, or as a quiet line when it said nothing), every inbox item of the run (open: a decision card answered
  in place, with the same resolutions as the tiles; answered: a one-line receipt), presentations (images shown,
  markdown read inline, other files as chips; all open in the shared preview), and a few events (PR opened, run
  stopped/failed; merges only when no assistant narrates). A run without an assistant still gets its request,
  decisions and events. Above it a progress strip (plan › execute n/m › integrate › PR, one dot per task: hover =
  what its agent does, click = its tile in the agents view); below it the needs-you bar and the reply box
  (`sessions.send` to the live assistant; ⌘⏎ interrupts). There is no inbox overlay: ⌘U (or ⌘I) shows the next open
  decision as its card, the run on screen first; the title bar counts them across runs.
- Rail: projects (name, branch, uncommitted-changes dot, active runs / needs-you), each expandable to its runs.
  Workspace numbers (⌘1–9) follow the rail: runs grouped by project (pinned first, then in the order added).
  Runs whose project was removed are grouped by repository. Archived runs stay hidden unless asked for.
- Project page: with an active project and no active run (`uiStore.activeProjectId`, `activeRunId: null`), the chat
  view shows a new conversation (a prompt that starts `runs.chat`, or `runs.create` with the assistant off; branch and
  engine in the full composer) and the project's earlier conversations.
- Code view (`renderer/code/`, ⌘⇧E): the project's workspaces, kept per project in localStorage
  (`legion.code.<projectId>`), for checking on files and running commands while agents work. Code belongs to the
  project: its first workspace is the main checkout with a shell in it; the user makes more, on the project or on
  one of its checkouts (`projects.checkouts`: the git worktrees, Legion's matched to their run and task). A
  worktree workspace is read-only while the task's agent works there, until taken over (`sessions.takeover`, the
  agent's session handed over in a terminal). Takeovers and worktree shells asked for elsewhere land in the
  workspace on that worktree. Inside a workspace the layout is the user's, i3-style (`code/tree.ts`, pure and
  tested): containers split side by side or above each other in remembered shares, or show one child under tabs
  or a stack; open beside, move, resize, re-layout, fullscreen. Tiles are terminals and viewers (files and diffs as
  tabs; the next file opened replaces the unpinned preview tab). `files.*` take a `checkout` (refused unless it is
  one of the project's worktrees). The side panel (⌘B) holds a run's Changes (each task's diff, the whole run's),
  Files, Search (`git grep`, ⌘⇧F) and Activity (runs, open PRs, git history); open files and directories are read
  again every few seconds while on screen. Files open in an editor (CodeMirror 6, `tiles/code/editor/`): buffers
  that outlive the editor on screen, ⌘S through `files.write` (refused with `conflict` when the file's version,
  modification time and size, moved on since it was read), `files.stat` every two seconds to reload an untouched
  buffer or flag a conflict under unsaved edits, read-only in a worktree workspace while its agent works there,
  vim keys as a preference. Images, rendered Markdown, binary and size guards as before. A task's diff is
  reviewed in place (`tiles/diff/review.ts`): comments drafted on hunks go to the task's agent as one message
  (`sessions.send` into the live coder session, else `tasks.requestChanges`); `tasks.revertHunk` applies a hunk in
  reverse in the task's worktree (`conflict` when it no longer matches) and commits it on the task branch unless
  the coder is at work; Approve & merge is `tasks.approveMerge`.
  Selecting lines in the code viewer → "Start a run about this…" (⌘⏎) opens the composer with the project and a
  `path:lines` reference. Adding a project opens its home,
  never the composer; ⌘⇧N preselects the project on screen (`app/composer-seed.ts`); ⌘⇧H returns to the home. The
  empty state leads with adding a project (and lists checkouts found on this Mac).
- Coordination (§8.4-8.6): the composer's prompt starts a conversation with the assistant (`runs.chat`); with the
  assistant switched off (Settings → Runs → Coordination) it goes to the planner (`runs.create`). A run with an
  assistant or a lead gets an `agents` column in the agents view (stacked `agents` tile = the attempt tree by
  `parentAttemptId` with status and queued-message counts, click opens the agent's session; `messages` tile = every
  agent-to-agent message), open while executing.
- A run's layout tree (`renderer/layout/`) is a pure TS tree (Workspace → Strip → Column → Tile) with ops and
  full unit tests; it is the model behind the route map (the focused tile is the station pane). The run's DAG
  drives insertion. The Code view does not use it (see above).
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
