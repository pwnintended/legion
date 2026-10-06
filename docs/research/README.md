# Legion research

Research done on 2026-10-06 to design Legion. Each report notes which claims were checked against live sources or the installed CLIs and which come from background knowledge.

| Report | Covers |
|---|---|
| [claude-code.md](claude-code.md) | Driving Claude Code headlessly: Agent SDK vs `claude -p` stream-json, permissions, plan mode, structured output, sessions, MCP, auth/ToS |
| [codex.md](codex.md) | Driving Codex: `app-server` JSON-RPC vs `exec --json` vs SDK, sandbox/approvals, output schemas, threads, review, Claude↔Codex concept mapping |
| [orchestration.md](orchestration.md) | Plan → DAG decomposition, task schema, scheduling, worktrees, integration/merge strategy, review loops, PR creation, state model |
| [landscape.md](landscape.md) | Competitors (Conductor, Superset, Emdash, Codex app, Cursor 3, Agent HQ, Kiro, …), user sentiment, UX principles, gaps |
| [electron-stack.md](electron-stack.md) | Electron/TS stack: build, process model, IPC, SQLite, terminals, UI, DAG, diff, git/GitHub, testing |
| [tiling-ux.md](tiling-ux.md) | Tiling-WM paradigms, visual language, concept mapping, layout libraries |

## Decisions made after the research

- **Claude Code is driven by spawning the `claude` CLI** (`-p --input-format stream-json --output-format stream-json`), not the Agent SDK that `claude-code.md` recommends. Approvals go through `--permission-prompt-tool` on Legion's MCP server.
- **Codex is driven via `codex app-server`**, as `codex.md` recommends.
- **Claude auth uses the user's own logged-in `claude` binary.**
- **The UI is a niri-style scrollable tiling strip**, as `tiling-ux.md` recommends. Mockup: https://claude.ai/artifact/A818rw2Q72GGGFwcfVkbkT
