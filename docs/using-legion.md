# Using Legion

Everything about the session itself: the screen, the keys, the cards that ask for your answer, and every command.
New here? The [README](../README.md) is the friendlier start.

## Starting a session

```sh
legion                         # start a session in this directory
legion "run review on my branch"   # … with a first message
legion -c                      # continue the last conversation here
legion --claude claude-2       # use another Claude account for this session
legion --remote                # run workflow steps on Upstash Boxes (--local: on this machine)

legion workflows               # list workflows (project, user, builtin)
legion run feature --input '{"task":"Add a --json flag to status"}'   # headless run
legion resume <run-id>         # pick a stopped run up again
legion validate <workflow>     # type-check + dry-run
legion eject feature           # copy a builtin into .legion/workflows to edit it
```

## In the session

- Type to talk to the assistant. Ask it to *create*, *change* or *run* workflows. On an empty prompt, **Tab** fills
  in one of the starters from the welcome card.
- Legion fills the terminal window (the alternate screen, like vim or less) and redraws in place when it is
  resized; your shell's screen comes back when it exits. **PgUp/PgDn** or the **mouse wheel** scroll the
  conversation; it follows new output again when you scroll back to the end or send something. Since Legion
  reports the mouse, hold Shift (Option in iTerm2) to select text.
- **Esc** interrupts the assistant. **Ctrl+C** twice exits. **?** on an empty prompt shows every shortcut.
- The tool calls between two replies fold into one line (`Read ×3 · Bash · 2 files +14 −3`); **Ctrl+O** shows
  each call, and folds them again. Slash commands match loosely: `/wf` finds `/workflows`, `/account` finds
  `/claude` and `/codex`.
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
  agent steps, which a dry run finds along with their engines. There you set the **tier** (`hard`, `medium`,
  `easy`) for all of the workflow's agents, or for a single step, and, rarely needed, a step's own engine, model and
  effort. ←→ moves between columns, Enter opens a picker, ⌫ resets the cell and Esc saves. The model picker lists what each engine offers: Codex's own list (from `codex app-server`)
  and Claude's aliases and current model IDs, plus anything in `[claude] models = [...]` or
  `[codex] models = [...]`. *other…* lets you type any other name. Moving a step to the other engine drops a model
  that engine doesn't have. `r` runs the workflow (the prompt is pre-filled when the workflow needs input), `v` validates it, `e`
  ejects a builtin so you can edit it, and `o` opens a project workflow in `$EDITOR`. *All workflows* at the top
  sets defaults for every workflow.
- `/provider claude|openai|mixed` moves the assistant, every lead and every workflow agent onto one provider (when
  the other is out of limits), or back to `mixed`. It saves to `.legion/config.local.toml`, so it lasts on this
  machine until you switch back. `/provider` alone shows what each tier means on each engine.
- `/run <name> [json]`, `/runs`, `/steps <run>`, `/log <run> <step>`, `/resume <run>`,
  `/cancel <run>`, `/validate <name>`.
- `/config` opens the settings menu. ↑↓ picks a setting, ←→ changes it, Enter types a value (model, maxAgents),
  Esc saves and closes, `d` discards. The first row picks the file to save to: `project`, `local` (this
  machine only) or `user` (every project). Each setting shows the file it comes from, and warns when a later
  file overrides the one you are saving to. Changes are written into the TOML in place, keeping your comments,
  and apply right away. *Open the file in $EDITOR* is
  there for anything else. `/config show`, `/config edit [user|project|local]` and `/config reload` also work.
- `/login <claude|codex> [name]` logs in a new account. `/accounts` lists accounts with login status, cooldowns and last use; `/accounts reset [kind[/name]]` clears cooldowns.
- `/remote [on|off|default]` shows or switches remote mode (Upstash Boxes) for this session, from the next step on.
- `/takeover <run> <step>` opens that agent's session in its own CLI (`claude --resume …` / `codex resume …`)
  so you can steer it by hand. Legion's UI comes back when you exit.

Runs execute in the background of the session. Quitting cancels them, and `legion resume <id>` (or `/resume`)
continues them later.
