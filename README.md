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
- `/workflows`, `/run <name> [json]`, `/runs`, `/steps <run>`, `/log <run> <step>`, `/resume <run>`,
  `/cancel <run>`, `/validate <name>`.
- `/claude [profile]` and `/codex [profile]` show or switch the account used for new agents.
- `/takeover <run> <step>` opens that agent's session in its own CLI (`claude --resume …` / `codex resume …`)
  so you can steer it by hand. Legion's UI comes back when you exit.

Runs execute in the background of the session. Quitting cancels them, and `legion resume <id>` (or `/resume`)
continues them later.

## Configuration

`~/.config/legion/config.toml`, overlaid by the project's `.legion/config.toml` and `.legion/config.local.toml`.
Every key is optional.

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

[workflows]
approvals = "ask"                        # agents' tool approvals: ask (you) | auto (the engine's auto mode)
maxAgents = 4                            # agent sessions alive at once per run
```

A profile spawns `command` directly with `env` applied, with no shell per agent. That is why
`CLAUDE_CONFIG_DIR` goes in `env` rather than in a shell alias. Workflows only ever say `engine: 'claude'` or
`'codex'`, and the session decides which profile that means. Without any profiles, `claude` and `codex` run as
the plain binaries.

A run records the profile it started on. Claude keeps sessions under `CLAUDE_CONFIG_DIR`, so if you resume a
run on another profile, interrupted Claude steps restart instead of continuing their old session. Finished steps
are still replayed from the journal.

Codex runs with a Legion-owned `CODEX_HOME` (`~/.legion/codex-home/<profile>`). It links only your `auth.json`,
so your Codex config, hooks and `AGENTS.md` do not leak into runs.

## Workflows

Resolution order, first match by name wins:

1. `.legion/workflows/<name>.ts` in the project (commit them)
2. `~/.config/legion/workflows/<name>.ts`
3. builtin: [`feature`](builtin/workflows/feature.ts), [`implement`](builtin/workflows/implement.ts), and
   [`review`](builtin/workflows/review.ts)

| Builtin | What it does |
|---|---|
| `feature` | Clarify, plan (you approve or ask for changes), then implement the plan's tasks in parallel worktrees in dependency order. Each task gets a review from the other engine and fix rounds, then is squash-merged into an integration branch (an agent resolves conflicts). A final review of the whole, then a draft PR (or a local merge). |
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
  assistant/            the conversational agent, its MCP tools (workflows/runs), its system prompt
  engine/               AgentEngine adapters: claude (stream-json), codex (app-server), fake
  workflow/             runtime (step memoization), journal, loader (+ `legion` import hook), validator,
                        run manager, git operations
  sdk/                  what workflow files import as `legion`
  git/                  worktrees, squash merges, conflicts, PRs (ported from Legion's desktop app)
  tui/                  Ink UI: store (state), controller (commands), app (components)
builtin/workflows/      feature, implement, review (+ an end-to-end test on a real repo)
```

Per project, Legion writes only under `.legion/`. It creates a `.legion/.gitignore` that ignores `runs/`,
`session/` and `*.local.*`, so the only thing to commit is `workflows/` (and `config.toml` if you want one).
Worktrees live outside the repository in `~/.legion/worktrees/`. Branches are named `legion/<run-id>/<name>`.

## Develop

```sh
pnpm dev                       # run from source (tsx)
LEGION_FAKE_ENGINES=1 pnpm dev # scripted agents everywhere: no CLIs, no tokens
pnpm typecheck && pnpm lint && pnpm test
pnpm test:live                 # real claude/codex sessions, cheapest models (costs a little)
pnpm test:live src/engine/codex # just one adapter
```
