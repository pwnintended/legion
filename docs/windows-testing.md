# Testing Legion on Windows

Windows support was written and unit-tested on macOS (the Windows code takes `path.win32` and a fake filesystem),
but has never run on Windows. This is the checklist for its first run. Each manual check names the code it
exercises, so a failure points at one file. Note what you see (screenshots, the console output of `pnpm dev`) for
every check that fails.

## Setup

- Windows 11 (x64, or arm64 if that's what you have).
- [Git for Windows](https://gitforwindows.org/) with its defaults, Node 24 (`winget install OpenJS.NodeJS`), then
  `npm install -g pnpm@11`.
- `claude` and `codex` logged in, both installed the usual way. If you can, try one npm install (`npm i -g
  @openai/codex`, which is a `.cmd` shim) and one native install (Claude Code's installer, which gives `claude.exe`).
- `gh auth login`, for the PR step.
- Clone, then `pnpm install`. node-pty ships Windows prebuilds, so no Visual Studio should be needed. If the
  install compiles anything, note it.

In PowerShell, environment variables go before the command like this:
`$env:LEGION_FAKE_ENGINES = '1'; pnpm dev`.

## Automated checks

Run each and keep the output.

| Command | Expect |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | only the known `.impeccable/*.json` formatting errors. Errors on every file mean the checkout has CRLF line endings (`.gitattributes` should prevent that) |
| `pnpm test` | all pass. The Windows-specific suites are `src/engine/platform/windows.test.ts`, `src/engine/util/links.test.ts`, `src/main/platform/platform.test.ts`, `src/shared/paths.test.ts` |
| `pnpm test:e2e` | all pass (Playwright drives Electron) |
| `pnpm test:packaged` | passes: builds `dist\win-unpacked\Legion.exe` and runs its self-test (node-pty spawns `cmd /c echo`, node:sqlite opens) |
| `pnpm dist` | builds an NSIS installer in `dist\`. Install it, then launch Legion from the Start menu |

## Manual checks

Use `pnpm dev`, first in fake mode (`$env:LEGION_FAKE_ENGINES = '1'`) and then with the real CLIs.

### Window and shell (`src/main/platform/windows.ts`)

- [ ] The minimise, maximise and close buttons sit at the right end of Legion's title bar, the same height as the
  bar, with nothing hidden under them. The title bar still drags the window.
- [ ] Settings → Appearance → Latte (light): the buttons turn light too.
- [ ] Closing the window quits Legion.
- [ ] Something that needs you (a plan to approve, in fake mode) puts a red dot on the taskbar button, and the dot
  goes away once it's handled.
- [ ] With the window unfocused, a notification shows. The installed app (from `pnpm dist`) needs checking too:
  without the Start menu shortcut, Windows may drop notifications from `pnpm dev`.

### Finding and running the CLIs (`src/engine/platform/windows.ts`: `findExecutable`, `launch`)

- [ ] Onboarding / Settings show both engines installed, with their paths and versions. Note whether the path ends
  in `.exe` or `.cmd`.
- [ ] A real run starts, and a Codex agent and a Claude agent both answer. Planner and reviewer prompts are
  multi-line arguments, which a `.cmd` shim can only take through `node <script>`.
- [ ] Settings → engine binary path: `C:\…\claude.exe` and `~\…` are accepted. A folder or a `/…` path is refused.

### Stopping agents (`kill`: `taskkill /T /F`)

- [ ] Interrupting an agent mid-turn stops it. Afterwards no stray `node.exe`, `codex.exe` or `claude.exe` is
  left in Task Manager.
- [ ] After pausing and archiving a run, its worktree folders can be deleted. An orphaned process would lock them.

### Terminals (`interactiveShell`, node-pty / ConPTY)

- [ ] A terminal tile opens PowerShell 7 if it's installed, Windows PowerShell otherwise.
- [ ] In the terminal, Ctrl+C interrupts, Ctrl+Shift+C copies a selection and Ctrl+Shift+V pastes.
- [ ] Ctrl+Alt+H / Ctrl+Alt+L move focus out of the terminal.
- [ ] "Take over" an agent: its session resumes in the terminal (`claude --resume` / `codex resume`).

### `legion.json` commands (`scriptShell`: Git Bash)

- [ ] Add a `legion.json` with `"setup": ["echo $HOME > setup.txt"]` and `"verify": ["test -f setup.txt"]`. A run's
  task worktrees get `setup.txt`, and verify passes. `$HOME` expanding shows Git Bash ran it, not cmd.exe.
- [ ] With `"symlink": [".env"]` and `"copy": [".env.local"]`, the files appear in the worktree. Without Developer
  Mode, `.env` should be a copy, not an error.

### Paths and skills (`src/shared/paths.ts`, `src/engine/util/links.ts`)

- [ ] Add a project by pasting `C:\…`, by `~\src\…`, with Browse…, and by dropping a folder from File Explorer.
  The title bar and the project picker show the path as `~\…`.
- [ ] A repository nested deep enough that worktree paths pass 260 characters (e.g. one with `node_modules`):
  provisioning and merges work (git gets `core.longpaths` from Legion's environment).
- [ ] Allow a user skill for a role in Settings. The agent sees it (it's linked in through a junction).
- [ ] Codex without Developer Mode: runs still work. Legion then uses your own `%USERPROFILE%\.codex` because it
  can't symlink `auth.json`, and the `pnpm dev` console says so once (`codex: [legion] can't link auth.json …`).

### Keyboard (`src/renderer/app/keys.ts`)

- [ ] Shortcut hints read `Ctrl+…` (the resize chords read `Ctrl+Win+…`).
- [ ] With a keyboard layout that uses AltGr (German, Polish), typing `@`, `{` or `ę` in the composer types the
  character and triggers no command.

## Known gaps (don't report these)

- Read-only Codex agents (planner, reviewers) ask for approval of their shell commands, because Legion doesn't yet
  unwrap Codex's PowerShell wrapper to match its allowlist.
- No app icon on any OS yet, and the installer isn't code-signed, so SmartScreen warns on first launch.
