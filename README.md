# Legion

A single-session terminal agent for **multi-agent coding workflows**. Run `legion` in a repository and you
talk to an assistant, like Claude Code or Codex. It also writes, changes and runs *workflows*: TypeScript
files that orchestrate Claude Code and Codex sessions, human gates, shell commands and git worktrees. A typical
workflow goes plan → parallel implementation in worktrees → cross-engine review/fix rounds → merge → draft PR.

Legion drives the **stock `claude` and `codex` CLIs** you already have installed and logged in. It uses no
SDKs and no API keys, and it never reads your credentials. You choose which account each kind runs on per
session (profiles), e.g. `claude-1` or `claude-2`.

```
› add a workflow that reviews the current branch with both engines and fixes what they agree on
  ⏺ legion.read_workflow review
  ⏺ Write .legion/workflows/double-check.ts
  ⏺ legion.validate_workflow double-check
Added double-check: … It passes validation (type-check + dry run). Want me to run it?
› yes
◆ double-check started (run 20261026-2131-x7pe)
  ✓ claude reviews
  ⠹ codex reviews · Bash pnpm test   42s
```

## Install

Requirements: Node ≥ 24 (26 recommended), git ≥ 2.38, `claude` and/or `codex` logged in, and `gh` for PRs.

```sh
pnpm install && pnpm build
pnpm link --global      # puts `legion` on your PATH
legion doctor           # checks engines, profiles, config
```

## Use

```sh
legion                         # start a session in this directory
legion "run review on my branch"   # … with a first message
legion -c                      # continue the last conversation here
legion --claude claude-2       # use another Claude account for this session

legion workflows               # list workflows (project, user, builtin)
legion run feature --input '{"task":"Add a --json flag to status"}'   # headless run
legion resume <run-id>         # pick a stopped run up again
legion validate <workflow>     # type-check + dry-run
legion eject feature           # copy a builtin into .legion/workflows to edit it
```

In the session:

- Type to talk to the assistant. Ask it to *create*, *change* or *run* workflows.
- **Esc** interrupts the assistant. **Ctrl+C** twice exits.
- **Gates, questions and tool approvals** appear above the prompt. Gates: `y` approve, `c` request changes
  (then type a note), `x` abort the run. Approvals: `y` once, `s` for the session, `n` deny. Questions: type an
  answer or an option number. **Tab** switches between answering and messaging the assistant.
- **An agent's own questions** (Claude's `AskUserQuestion`, Codex's `request_user_input`), from the assistant, a
  lead or a workflow agent, show as a question card, not as a tool approval. ↑↓ and Enter pick an option, Space
  toggles options of a multi-select question, typing gives your own answer (or option numbers, `1,3`), and Esc
  declines. Several questions are asked one after another and sent together.
- **The chat holds the conversation only.** What you said, the replies, gates, your answers, errors and your runs'
  results. Under the prompt you see the active runs, the team and an **activity feed**: lead reports and messages,
  runs starting, workflow logs, leads' runs finishing. The busy line shows the tool the assistant is running.
  `/activity [n]` prints the last n feed lines in full, tool calls included.
- **Shift+Enter** inserts a newline in terminals that speak the kitty keyboard protocol (Ghostty, kitty, WezTerm,
  iTerm2 with CSI u reporting). Elsewhere, end the line with `\` and press Enter, or use Alt+Enter.
- Type `/` for the command menu: ↑↓ picks, Tab completes, Enter runs. `/help` lists everything.
- `/workflows` opens the workflow browser. Enter opens a workflow: its description, its input fields, and its
  agent steps, which a dry run finds along with their engines. There you set the **engine, model and effort** for
  all of an engine's agents, or for a single step. ←→ moves between columns, Enter opens a picker, ⌫ resets the
  cell and Esc saves. The model picker lists what each engine offers: Codex's own list (from `codex app-server`)
  and Claude's aliases and current model IDs, plus anything in `[claude] models = [...]` or
  `[codex] models = [...]`. *other…* lets you type any other name. Moving a step to the other engine drops a model
  that engine doesn't have. `r` runs the workflow (the prompt is pre-filled when the workflow needs input), `v` validates it, `e`
  ejects a builtin so you can edit it, and `o` opens a project workflow in `$EDITOR`. *All workflows* at the top
  sets defaults for every workflow.
- `/run <name> [json]`, `/runs`, `/steps <run>`, `/log <run> <step>`, `/resume <run>`,
  `/cancel <run>`, `/validate <name>`.
- `/config` opens the settings menu. ↑↓ picks a setting, ←→ changes it, Enter types a value (model, maxAgents),
  Esc saves and closes, `d` discards. The first row picks the file to save to: `project`, `local` (this
  machine only) or `user` (every project). Each setting shows the file it comes from, and warns when a later
  file overrides the one you are saving to. Changes are written into the TOML in place, keeping your comments,
  and apply right away. *This session* switches the Claude and Codex profiles. *Open the file in $EDITOR* is
  there for anything else. `/config show`, `/config edit [user|project|local]` and `/config reload` also work.
- `/claude [profile]` and `/codex [profile]` show or switch the account used for new agents.
- `/takeover <run> <step>` opens that agent's session in its own CLI (`claude --resume …` / `codex resume …`)
  so you can steer it by hand. Legion's UI comes back when you exit.

Runs execute in the background of the session. Quitting cancels them, and `legion resume <id>` (or `/resume`)
continues them later.

## Configuration

Layers, later ones win:

1. `~/.config/legion/config.toml`, the user config. Profiles usually go here.
2. Every `.legion/config.toml` from the outermost parent directory down to where you start `legion`. A parent
   folder can hold settings for all the repositories under it.
3. The project's `.legion/config.local.toml`, which is gitignored and holds machine-specific overrides.

If there is no `.legion/config.toml` in the directory, the repository root or any parent, the first session
writes a commented one at the project root. Its values are the settings already in effect, so creating it changes
nothing. Every key is optional.

```toml
[claude]
default = "claude-1"                     # the session's profile unless --claude says otherwise

[claude.profiles.claude-1]
setup   = "claude-share check"           # run once per session, through your shell, before the UI starts
command = "claude"
env     = { CLAUDE_CONFIG_DIR = "~/.claude-1" }

[claude.profiles.claude-2]
setup   = "claude-share check"
command = "claude"
env     = { CLAUDE_CONFIG_DIR = "~/.claude-2" }

[codex.profiles.default]
command = "codex"                        # env = { CODEX_HOME = "…" } for another account

[assistant]
engine = "claude"                        # which engine you talk to
model  = "opus"                          # optional
effort = "high"                          # optional
approvals = "auto"                       # its own tool approvals: auto (allowed) | ask (you)

[workflows]
approvals = "auto"                       # agents' tool approvals: auto (allowed) | ask (you)
maxAgents = 4                            # agent sessions alive at once per run
maxAgentsTotal = 6                       # …and across all runs of this session
resumeOnStart = true                     # resume runs a crash or exit left unfinished

[worktrees]
clone = ["target", "game/.godot"]        # build caches copied into new worktrees (default: found automatically)
setup = []                               # commands run in each new worktree, e.g. "pnpm install --offline"
minFreeGb = 10                           # no new worktrees below this much free disk
```

Things are allowed by default (`approvals = "auto"`): Claude sessions run in Claude's auto mode, whose
classifier answers what would be asked, and Codex sessions run without sandbox or approvals, like
`--dangerously-bypass-approvals-and-sandbox`. With `ask`, Claude edits files freely and asks about the rest,
and Codex runs in its `workspace-write` sandbox and asks for anything outside it; you answer in the UI.
Read-only agents (planners, reviewers) stay read-only either way.

Tool approvals always come to you, never through a lead: a lead answering them costs an LLM turn each while the
agent waits.

**Warm worktrees.** A fresh worktree has none of your checkout's build caches, so every agent would start with a
cold build. Legion copies the ignored cache directories (`target`, `node_modules`, `.venv`, `.godot`, two levels
deep, or the `[worktrees] clone` list) into each new worktree as copy-on-write clones (APFS, or `--reflink` on
Linux): instant, and no extra disk until a build changes them. Then it runs `setup`. A run's worktrees are removed
when it ends (its branches stay), and no worktree is created when less than `minFreeGb` is free.

**Interrupted runs.** Runs still going when Legion exits or crashes are resumed on the next start
(`resumeOnStart`), from their journal: finished steps are not redone. Runs another live Legion session owns are
left alone.

**Agents that go wrong.** An agent that ends its turn without the structured result its step needs is asked once
more for it. A model the engine rejects (unknown, or not available on your account) is logged and the step retries
on the engine's default model.

### Models for workflow agents

The `/workflows` menu writes these for you:

```toml
[workflow.feature.claude]        # every Claude agent of `feature` whose code picks no model
model = "sonnet"

[workflow.feature.agent.plan]    # the `plan` step: over what the workflow's code picks
model  = "opus"
effort = "high"

[workflow.feature.agent.review]  # run the `review` steps on Codex, whatever the code says
engine = "codex"

[workflow."*".codex]             # every workflow
effort = "high"
```

A step's `engine` setting, when there is one, decides the engine; otherwise the code does. A model the code picks
for its own engine is ignored once the step runs on the other one. Model and effort are each decided in this
order, first match wins:

1. the step setting;
2. the workflow code's `agent(key, { model, effort })`;
3. the workflow's engine setting;
4. `"*"`;
5. the CLI's own default.

Without any of these, the user's own CLI settings do not apply: Claude agents load only project settings, and Codex
runs in its own `CODEX_HOME`. The model each step ran with is recorded in the run's journal.

A profile spawns `command` directly with `env` applied, with no shell per agent. That is why
`CLAUDE_CONFIG_DIR` goes in `env` rather than in a shell alias. Workflows only ever say `engine: 'claude'` or
`'codex'`, and the session decides which profile that means. Without any profiles, `claude` and `codex` run as
the plain binaries.

A run records the profile it started on. Claude keeps sessions under `CLAUDE_CONFIG_DIR`, so if you resume a
run on another profile, interrupted Claude steps restart instead of continuing their old session. Finished steps
are still replayed from the journal.

Codex runs with a Legion-owned `CODEX_HOME` (`~/.legion/codex-home/<profile>`). It links only your `auth.json`,
so your Codex config, hooks and `AGENTS.md` do not leak into runs.

## Team leads

The assistant you talk to is the orchestrator. For a big area of work it can spawn a **team lead**: a long-lived
agent with its own context, role and plan. A lead runs workflows, answers its own runs' gates and questions, may
spawn sub-leads (an assets lead with fauna, vegetation and building-kit leads under it), and reports to its
parent. Each lead hears only from its own children, so the orchestrator's context stays about the whole project.

Leads report with a kind: `progress`, `done`, `blocked`, `question`, `review` (something a human should judge,
with the files or images to look at) or `coordinate` (it needs something from another team). Reports, messages,
finished runs and waiting gates go into the parent's inbox and arrive as one bundled `[Legion]` message when it is
free. The orchestrator brings `review`s and user-only questions to you and passes your answer back.

Who answers a run's gates, questions and tool approvals depends on who started it:

- The orchestrator's runs ask you, unless `[team] gates = "decide"`: then the orchestrator answers and brings
  you only what it cannot settle.
- A lead's runs follow its role's `gates`: `decide` (the default) means the lead answers. `tell` means the lead
  answers and its parent hears every answer. `ask` means you answer, and the lead is told what its run waits on.

### Branches and worktrees

Every lead works in **its own git worktree on its own branch**, `legion/lead/<name>`, under
`~/.legion/worktrees/<repo>-<hash>/leads/<name>`. It never writes in your checkout or another lead's. A lead
under the orchestrator branches off the branch you have checked out, and a sub-lead branches off its parent's.

- A lead commits its work on its branch. Workflow runs it starts begin from that branch's last commit, work in its
  worktree, and merge back into it (`tasks` and `feature` take `base` to aim elsewhere).
- When a lead reports done, its parent merges the branch up with `merge_lead`. For the orchestrator's leads that
  means into the branch you have checked out, so the work shows up in your checkout. Uncommitted leftovers are
  committed first. A conflict is handed back to the lead to resolve on its own branch.
- `run_workflow` warns the caller when its checkout has uncommitted files, because the run's worktrees won't have
  them.
- Agents are told never to make worktrees or branches themselves. A role with `workspace: shared` works in your
  checkout instead (for leads that only coordinate). Leads created before this change keep working in your
  checkout.
- `/team` shows each lead's branch and worktree.

In the session:

- **The team panel** under the prompt shows every lead that is not stopped, as a tree. Each line has the lead's
  progress through its plan, the item it is on, its runs and what waits for its answer. Leads' runs show as one
  line each.
- `/lead <name>` switches the prompt to a lead. You talk to it directly, its replies stream in, and its runs'
  gates and questions join your queue, so you can answer them in its place (it is told you did). `/lead` alone
  goes back to the orchestrator.
- When the orchestrator wants you to look at something (a lead's review, a screenshot, a page), it uses `present`:
  images appear inline in terminals that can draw them (kitty graphics in Ghostty and kitty, the iTerm2 protocol
  in iTerm2 and WezTerm), and every item gets a clickable link (file or URL). In tmux, or a terminal without
  image support, you get the links. Non-PNG images and huge PNGs are converted with `sips` on macOS.
  `LEGION_IMAGES=kitty|iterm|off` overrides the detection.
- `/team` prints the tree with plans and last reports. `/stop <lead>` stops a lead, its sub-leads and their runs.

Leads and the orchestrator can also steer runs. `message_agent` sends a running agent a correction mid-turn.
`retry_run` stops and resumes a run with notes for the next attempt. With `rewind`, it redoes a finished step
and everything after it, e.g. a critique round with new instructions.

State is kept in `.legion/team/team.json` (gitignored). After a restart, a lead resumes its session on the next
message it gets.

### Roles

A role is a Markdown file: YAML frontmatter for how the lead runs, the body for its standing instructions.
Resolution, first match by name wins: `.legion/roles/<name>.md`, `~/.config/legion/roles/<name>.md`, builtin
(`team-lead`, `engineering-lead`, `art-director`, `world-designer`).

```markdown
---
description: "Fauna for one planet: concept, model, critique, export"
engine: claude            # claude | codex
model: opus               # optional; effort too
workflows: [asset-critique, concept-sheet]   # which workflows it may run, or "*"
spawns: []                # which roles it may spawn as sub-leads, or "*"
approvals: auto           # its own tool approvals: auto, or ask (you answer them)
gates: decide             # its runs' gates: decide (the lead) | tell (lead, parent hears) | ask (you)
maxRuns: 4                # runs it may have active at once
workspace: branch         # branch (its own worktree and branch) | shared (your checkout)
---
You make the creatures for …
```

### MCP servers and limits

Workflow agents and leads do not load your own CLI's MCP servers. List the ones they should have (Blender, an
image generator, …); every agent and lead gets all of them:

```toml
[mcp.servers.blender]
command = "uvx"
args    = ["blender-mcp"]

[mcp.servers.images]
url     = "http://127.0.0.1:8188/mcp"
headers = { Authorization = "Bearer …" }

[team]
gates    = "ask"         # the orchestrator's own runs: ask (you) | decide (the orchestrator)
maxDepth = 3             # levels of leads under the orchestrator
maxLeads = 12            # lead sessions alive at once; the longest-idle ones are closed (and resume later)
```

## Workflows

Resolution order, first match by name wins:

1. `.legion/workflows/<name>.ts` in the project (commit them)
2. `~/.config/legion/workflows/<name>.ts`
3. builtin: [`feature`](builtin/workflows/feature.ts), [`tasks`](builtin/workflows/tasks.ts),
   [`implement`](builtin/workflows/implement.ts), and [`review`](builtin/workflows/review.ts)

| Builtin | What it does |
|---|---|
| `feature` | Clarify, plan (you approve or ask for changes), then implement the plan's tasks in parallel worktrees in dependency order. Each task gets a review from the other engine and fix rounds, then is squash-merged into an integration branch (an agent resolves conflicts). A final review of the whole, then a draft PR (or a local merge). |
| `tasks` | The second half of `feature`, for a plan you already agreed with the assistant (or a lead): the tasks you give it, each optionally on its own engine, run the same way, through to the PR. `confirm: true` asks before starting. |

`feature`, `tasks` and `implement` keep runs short: one fix round by default (`maxFixRounds`), each task runs its
own scoped `verify` commands, and the repository-wide checks run once on the merged result. A run of one task skips
the final review. When the base branch moved on and conflicts by the time the run merges, an agent merges it into
the integration branch first instead of failing. Leads and the assistant are told to make small changes
themselves instead of starting a workflow.
| `implement` | One focused change in a worktree: code, then cross-engine review and fix rounds, then a gate, then a draft PR or merge. |
| `review` | Both engines review your branch and uncommitted changes independently. Their findings are merged, and an agent can then fix the ones you pick. |

A workflow is a plain TypeScript module (erasable syntax only) that imports from `legion`:

```ts
import { agent, gate, git, loop, workflow, z } from 'legion';

export default workflow(
  { name: 'tidy', description: 'Refactor one module with review', input: z.object({ path: z.string() }) },
  async ({ path }) => {
    const wt = await git.worktree('tidy');
    await agent('code', { engine: 'codex', cwd: wt.path, prompt: `Simplify ${path} without changing behavior.` });
    await loop('review', { max: 3 }, async (round) => {
      const r = await agent('review', {
        engine: 'claude', mode: 'read', untrusted: true, cwd: wt.path,
        output: z.object({ ok: z.boolean(), issues: z.array(z.string()) }),
        prompt: `Review \`git diff ${wt.baseSha}\`.`,
      });
      if (r.ok) return { done: true };
      await agent('fix', { engine: 'codex', cwd: wt.path, resume: round === 1 ? 'code' : `review/${round - 1}/fix`, prompt: r.issues.join('\n') });
    });
    const ok = await gate('ship', { title: 'Open a draft PR?', show: await git.diff(wt) });
    return ok.approved ? git.pr(wt, { title: `Tidy ${path}`, body: 'Refactor, reviewed by Claude.' }) : null;
  },
);
```

The full API is in the assistant's prompt ([`src/assistant/prompt.ts`](src/assistant/prompt.ts)) and in
[`src/workflow/runtime.ts`](src/workflow/runtime.ts). It provides `agent`, `gate`, `ask`, `sh`, `step`,
`loop`, `group`, `parallel` and `log`, plus `git.integration`, `worktree`, `commit`, `merge`, `mergeInto`,
`finishMerge`, `diff`, `changedFiles`, `pr`, `mergeToBase` and `remove`.

**Durability.** Every primitive is a named step, journaled in `.legion/runs/<id>/journal.jsonl`. A resumed run
re-executes the workflow from the top, and finished steps return their recorded result instantly. An agent step
interrupted mid-turn resumes its own session. For this to work:

- Step keys must be unique within a run. `loop` rounds and `group` scope them (`T1/review/2/fix`).
- Code between steps must be deterministic.

**Validation.** `legion validate` (and the assistant, after every edit) does three things:

1. Type-checks the file against the SDK.
2. Loads it.
3. Dry-runs it. Fake agents answer with schema-shaped samples, gates approve, and git and the shell are
   simulated. This catches typos, broken control flow and duplicate keys before a real run spends tokens.

## Layout

```
src/
  cli.tsx               entry: interactive session, headless run/resume, subcommands
  session.ts            config + profiles + engines + run manager + assistant for one directory
  config.ts             TOML config, profiles, per-session setup
  assistant/            the conversational agent, its MCP tools (workflows, runs, team), the system prompts
  team/                 roles, and the team manager: leads, inboxes, plans, persistence
  engine/               AgentEngine adapters: claude (stream-json), codex (app-server), fake
  workflow/             runtime (step memoization), journal, loader (+ `legion` import hook), validator,
                        run manager, git operations
  sdk/                  what workflow files import as `legion`
  git/                  worktrees, squash merges, conflicts, PRs (ported from Legion's desktop app)
  tui/                  Ink UI: store (state), controller (commands), app (components)
builtin/workflows/      feature, tasks (sharing _tasks.ts), implement, review (+ an end-to-end test)
builtin/roles/          team-lead, engineering-lead, art-director, world-designer
```

Per project, Legion writes only under `.legion/`. It creates a `.legion/.gitignore` that ignores `runs/`,
`session/`, `team/` and `*.local.*`, so the only things to commit are `workflows/` and `roles/` (and `config.toml`
if you want one).
Worktrees live outside the repository in `~/.legion/worktrees/`. Branches are named `legion/<run-id>/<name>`.

## Develop

```sh
pnpm dev                       # run from source (tsx)
LEGION_FAKE_ENGINES=1 pnpm dev # scripted agents everywhere: no CLIs, no tokens
pnpm typecheck && pnpm lint && pnpm test
pnpm test:live                 # real claude/codex sessions, cheapest models (costs a little)
pnpm test:live src/engine/codex # just one adapter
```
