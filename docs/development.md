# Developing Legion

## Install from source

Requirements: Node ≥ 24 (26 recommended), git ≥ 2.38, `claude` and/or `codex` logged in, and `gh` for PRs.

```sh
pnpm install && pnpm build
pnpm link --global      # puts `legion` on your PATH
legion doctor           # checks engines, profiles, config
```

## Run and test

```sh
pnpm dev                       # run from source (tsx)
LEGION_FAKE_ENGINES=1 pnpm dev # scripted agents everywhere: no CLIs, no tokens
pnpm typecheck && pnpm lint && pnpm test
pnpm test:live                 # real claude/codex sessions, cheapest models (costs a little)
pnpm test:live src/engine/codex # just one adapter
```

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
  remote/               remote mode: Upstash Boxes, worktree sync, engines and `sh` steps in a box
  tui/                  Ink UI: store (state), controller (commands), app (components)
builtin/workflows/      feature, tasks (sharing _tasks.ts), implement, review (+ an end-to-end test)
builtin/roles/          team-lead, engineering-lead, art-director, world-designer
```

Per project, Legion writes only under `.legion/`. It creates a `.legion/.gitignore` that ignores `runs/`,
`session/`, `team/` and `*.local.*`, so the only things to commit are `workflows/` and `roles/` (and `config.toml`
if you want one).
Worktrees live outside the repository in `~/.legion/worktrees/`. Branches are named `legion/<run-id>/<name>`.

## Subagent events and transcripts

The engines emit `subagent_started`, `subagent_event` and `subagent_done` as `AgentEvent`s. Child output travels
in a `{ type: 'subagent_event', id, event }` envelope so it cannot become the parent's text, structured output
or turn completion. On `subagent_started`, `parent` is the spawning subagent's id, or `null` for the session's
main agent. Claude uses the Task/Agent tool-use id; Codex uses the child thread id.

The UI tracks sub agents under their orchestrator, lead or workflow step. Step events are journaled in
`.legion/runs/<run>/agents/<step>.jsonl`; the transcript view replays that file when its bounded in-memory
history is unavailable. Subagent histories for the orchestrator and leads live only in memory for this session.
