# Legion

Legion is a desktop app for macOS, Linux and Windows that takes an issue all the way to a draft pull request by orchestrating the
coding agents you already use: **Claude Code** and **Codex**, driven through their own CLIs with your own
logins. A planner asks clarifying questions and drafts a plan plus a task DAG for your sign-off; coders then
work in parallel, each in its own git worktree; every task is reviewed by the *other* engine, fixed in
rounds, verified and squash-merged into one integration branch; a final holistic review precedes a single
draft PR.

Legion starts from your **projects**: add a repository and you land on its home (README, history, open pull
requests, a file tree, a code viewer, `git grep` search, ⌘P to jump to a file) before you ever write a prompt.
When you know what should change, start a run there (⌘⇧N), or select lines in a file and "Start a run about
this…".

A run is a conversation with an assistant. You describe the change, it hands it to the planner, and while the
agents work it tells you what matters: the lead reports milestones to it, and agents show you screenshots and
documents right in the conversation. You stay in charge at a few gates, each a card in that conversation: plan
approval, tool approvals and questions the agents raise, high-risk merges, and the PR itself (⌘U jumps to the next
one). The agents themselves are one key away (⌘E): a scrollable tiling workspace per run with live transcripts,
diffs, review packs and terminals, where you can steer an agent or take its session over in a terminal at any
time.

Shortcuts here are written the macOS way; on Linux and Windows ⌘ is Ctrl (the app shows each OS its own).

## Requirements

- macOS, Linux or Windows (arm64 or x64), Node ≥ 24, pnpm 11. On Linux, `pnpm install` compiles node-pty: it
  needs `python3`, `make` and a C++ compiler. Windows support is new and not yet verified on a Windows machine
  ([docs/windows-testing.md](docs/windows-testing.md)).
- Windows: [Git for Windows](https://gitforwindows.org/). Claude Code needs its Git Bash, and Legion runs
  `legion.json` commands in it, so they are written once for every OS.
- `claude` (Claude Code) and/or `codex` installed and logged in (`claude` / `codex login`). With only one of
  them, reviews run on the same engine with a different model (`settings.engines.<kind>.fallbackReviewModel`).
- `gh` logged in, for the PR step (GitHub only)
- git ≥ 2.38 (`git merge-tree --write-tree`)

## Develop

```sh
pnpm install
pnpm dev                          # electron-vite dev server + app
LEGION_FAKE_ENGINES=1 pnpm dev    # fake mode: scripted agents, no CLIs, no push, no GitHub
```

**Fake mode** (`LEGION_FAKE_ENGINES=1`) serves every engine with a scripted agent and a PR host that never
pushes or calls GitHub (the PR link is `https://github.invalid/...`). Point it at any git repo: one run goes
through a scripted assistant that hands the request to the planner, one clarify question, a 3-task plan with a
dependency, one tool approval, one review with a major finding fixed in the next round, a screenshot and a
document presented by coders, the lead's status update on every merge, and the PR gate. `LEGION_HOME=<dir>`
keeps the data (DB, worktrees) out of `~/Library/Application Support/Legion` (`~/.config/Legion` on Linux,
`%APPDATA%\Legion` on Windows).

## Test

```sh
pnpm typecheck && pnpm lint && pnpm test   # unit + integration (plain Node, scripted fake engines)
pnpm test:e2e                              # builds, then Playwright against the Electron app
pnpm test:live                             # real claude/codex sessions (cheapest models; costs a little)
pnpm test:packaged                         # packages, then launches the packaged app (native modules, sqlite)
pnpm test:linux [unit|e2e|packaged|all]    # the same checks on Linux, in Docker (works from a Mac)
```

`tests/e2e/full-run.spec.ts` drives a whole run through the UI in fake mode and writes screenshots of every
stage to `test-results/full-run/`; `tests/e2e/project-home.spec.ts` does the same for adding a project and
browsing it (`test-results/project-home/`). The renderer also runs on fixture data with `?demo=1` (or
`localStorage['legion.demo'] = '1'`), projects included.

## Package

```sh
pnpm package    # this OS, unpacked: dist/mac[-arm64]/Legion.app (unsigned), dist/linux[-arm64]-unpacked/legion,
                #   dist/win[-arm64]-unpacked/Legion.exe
pnpm dist       # this OS's distributables: the same .app on macOS, an AppImage on Linux, an NSIS installer on Windows
```

## `legion.json`

Optional, at the repository root; every key is optional.

| Key | |
|---|---|
| `setup` | Commands run in every new worktree (e.g. `pnpm install --frozen-lockfile`). |
| `verify` | Commands every task must pass, on top of each task's own verify commands; each becomes a named gate (`pnpm test` → `test`). Also the final verify on the integration branch. |
| `gates` | Named gates run before review and merge; see below. |
| `gates.detect` | Auto-detect `test` / `typecheck` / `lint` from package.json scripts with the detected package manager (pnpm/npm/yarn/bun). Default `true`. |
| `gates.commands` | `{name: command}` (blocking), `{name: {run, blocking: false}}` (warn only), or `{name: false}` to suppress a detected or `verify` gate of that name. A configured name replaces the detected gate of that name; a `verify` entry with the same name but a different command still runs (as `name-2`), so remove it or suppress the name. Each command runs once. `scope` and `secrets` are taken by the built-in gates. |
| `gates.scope` | Changed files vs the task's `touches`: `"block"` (default) or `"warn"`. |
| `gates.secrets` | Secret scan of the task diff (and again of what is merged, conflict resolution included): `"block"` (default), `"warn"` or `"off"`, or `{mode, allow: [globs]}`. A line containing `legion:allow-secret` is skipped. |
| `copy` / `symlink` | Untracked files to bring into worktrees (globs, e.g. `.env*`). |
| `highRiskGlobs` | Paths whose tasks wait for your approval before merging (e.g. `migrations/**`). |
| `installCommand` | Re-run after lockfile merges (lockfiles are never hand-merged). |

```json
{ "setup": ["pnpm install --frozen-lockfile"], "verify": ["pnpm test"], "copy": [".env.local"],
  "highRiskGlobs": ["migrations/**"], "installCommand": "pnpm install",
  "gates": { "commands": { "e2e": { "run": "pnpm e2e", "blocking": false }, "lint": false },
             "scope": "block", "secrets": { "mode": "block", "allow": ["fixtures/**"] } } }
```

The same `gates` keys (and `verify`) can be edited per project in **Settings → Gates**, which writes them back to
`legion.json`.

## Architecture

Electron main (thin) · engine in a `utilityProcess` (orchestrator, adapters, git, node:sqlite, MCP server,
PTYs) · React renderer, connected by a typed RPC over MessagePort. Start with
[`docs/architecture.md`](docs/architecture.md) (the contract), then `src/engine/orchestrator/README.md`
(lifecycle service), `src/engine/orchestrator/core/README.md` (pure decision logic) and the adapter READMEs
under `src/engine/adapters/`. Background research is in `docs/research/`.
