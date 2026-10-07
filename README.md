# Legion

Legion is a macOS desktop app that takes an issue all the way to a draft pull request by orchestrating the
coding agents you already use: **Claude Code** and **Codex**, driven through their own CLIs with your own
logins. A planner asks clarifying questions and drafts a plan plus a task DAG for your sign-off; coders then
work in parallel, each in its own git worktree; every task is reviewed by the *other* engine, fixed in
rounds, verified and squash-merged into one integration branch; a final holistic review precedes a single
draft PR.

Legion starts from your **projects**: add a repository and you land on its home (README, history, open pull
requests, a file tree, a code viewer, `git grep` search, ⌘P to jump to a file) before you ever write a prompt.
When you know what should change, start a run there (⌘N), or select lines in a file and "Start a run about
this…".

A run is a conversation with an assistant. You describe the change, it hands it to the planner, and while the
agents work it tells you what matters: the lead reports milestones to it, and agents show you screenshots and
documents right in the conversation. You stay in charge at a few gates, each a card in that conversation: plan
approval, tool approvals and questions the agents raise, high-risk merges, and the PR itself (⌘U jumps to the next
one). The agents themselves are one key away (⌘E): a scrollable tiling workspace per run with live transcripts,
diffs, review packs and terminals, where you can steer an agent or take its session over in a terminal at any
time.

## Requirements

- macOS (arm64 or x64), Node ≥ 24, pnpm 11
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
keeps the data (DB, worktrees) out of `~/Library/Application Support/Legion`.

## Test

```sh
pnpm typecheck && pnpm lint && pnpm test   # unit + integration (plain Node, scripted fake engines)
pnpm test:e2e                              # builds, then Playwright against the Electron app
pnpm test:live                             # real claude/codex sessions (cheapest models; costs a little)
pnpm test:packaged                         # packages, then launches Legion.app (native modules, sqlite)
```

`tests/e2e/full-run.spec.ts` drives a whole run through the UI in fake mode and writes screenshots of every
stage to `test-results/full-run/`; `tests/e2e/project-home.spec.ts` does the same for adding a project and
browsing it (`test-results/project-home/`). The renderer also runs on fixture data with `?demo=1` (or
`localStorage['legion.demo'] = '1'`), projects included.

## Package

```sh
pnpm package    # dist/mac-<arch>/Legion.app (unsigned)
```

## `legion.json`

Optional, at the repository root; every key is optional.

| Key | |
|---|---|
| `setup` | Commands run in every new worktree (e.g. `pnpm install --frozen-lockfile`). |
| `verify` | Commands every task must pass, on top of each task's own verify commands; also the final verify on the integration branch. |
| `copy` / `symlink` | Untracked files to bring into worktrees (globs, e.g. `.env*`). |
| `highRiskGlobs` | Paths whose tasks wait for your approval before merging (e.g. `migrations/**`). |
| `installCommand` | Re-run after lockfile merges (lockfiles are never hand-merged). |

```json
{ "setup": ["pnpm install --frozen-lockfile"], "verify": ["pnpm test"], "copy": [".env.local"],
  "highRiskGlobs": ["migrations/**"], "installCommand": "pnpm install" }
```

## Architecture

Electron main (thin) · engine in a `utilityProcess` (orchestrator, adapters, git, node:sqlite, MCP server,
PTYs) · React renderer, connected by a typed RPC over MessagePort. Start with
[`docs/architecture.md`](docs/architecture.md) (the contract), then `src/engine/orchestrator/README.md`
(lifecycle service), `src/engine/orchestrator/core/README.md` (pure decision logic) and the adapter READMEs
under `src/engine/adapters/`. Background research is in `docs/research/`.
