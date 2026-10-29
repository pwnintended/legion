```
██       ███████   ██████  ██████   █████   ██   ██
██▒      ██▒▒▒▒▒▒ ██▒▒▒▒▒▒  ▒██▒▒▒ ██▒▒▒██  ███  ██▒
██▒      ██▒      ██▒        ██▒   ██▒  ██▒ ████ ██▒
██▒      ██████   ██▒ ███    ██▒   ██▒  ██▒ ██▒████▒
██▒      ██▒▒▒▒▒  ██▒  ██▒   ██▒   ██▒  ██▒ ██▒ ███▒
██▒      ██▒      ██▒  ██▒   ██▒   ██▒  ██▒ ██▒  ██▒
███████  ███████   ██████▒ ██████   █████▒▒ ██▒  ██▒
 ▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒   ▒▒▒▒▒▒  ▒▒▒▒▒▒   ▒▒▒▒▒   ▒▒   ▒▒
```

**A whole team of coding agents, in one terminal.**

You tell Legion what you want built. It gets Claude Code and Codex working together like a small team: they plan
it, build the pieces side by side, review each other's work, fix what they find and hand you a pull request. You
stay in charge the whole way. Legion stops and asks you whenever a decision is yours to make.

```
› add a --json flag to the status command

⏺ That's a job for the feature workflow, starting it now.

╭─ ⏸ Approve the plan? ─────────────────────────────────╮
│ T1 add the --json flag · T2 JSON formatter · T3 tests │
│                                                       │
│ y approve   c request changes   x abort the run       │
╰───────────────────────────────────────────────────────╯

◆ feature  · 2 running · 4m 12s
  ✓ plan                        claude
  ✓ T1 code: add the --json flag codex
  ⠹ T1 review                   claude · Bash pnpm test
  ⠹ T2 code: JSON formatter     codex  · Edit src/format.ts
```

## Why you'll like it

- **It uses what you already have.** Legion runs the `claude` and `codex` apps you're already logged in to. There
  are no API keys to set up, and it never touches your passwords or tokens.
- **Two engines are better than one.** Work one engine does gets reviewed by the other, so mistakes get caught
  before they reach you.
- **Things happen in parallel.** Independent pieces of work are built at the same time, each in its own copy of
  your repository. Your own checkout stays untouched while they work.
- **You decide what matters.** You approve the plan and you're asked before anything ships. You can jump in at any
  point.
- **Nothing gets lost.** Close Legion, or let your laptop die, mid-run. Next time you start it, it carries on
  where it stopped.

## Get started

**1. What you need:** a Mac or Linux machine with [Node.js](https://nodejs.org) 24 or newer, git, and at least one
of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex)
installed and logged in. Both is best. Install the [GitHub CLI](https://cli.github.com) (`gh`) too if you'd like
Legion to open pull requests for you.

**2. Install Legion,** from a copy of this repository:

```sh
pnpm install && pnpm build
pnpm link --global
```

**3. Check everything is ready:**

```sh
legion doctor
```

It tells you whether it found Claude Code and Codex, and whether they're logged in. Then go to any project and
start it:

```sh
cd ~/code/my-project
legion
```

## Your first session

Just type, like you would in a chat. Here are a few things to try:

| Say something like… | What happens |
|---|---|
| *review my branch* | Claude and Codex each review your changes on their own, and you pick which findings get fixed |
| *add dark mode to the settings page* | The full treatment: a plan for you to approve, parallel building, reviews, and a draft PR |
| *fix the flaky login test* | A single focused change, reviewed by the other engine, before you decide whether to keep it |
| *what workflows do I have?* | A tour of what Legion can do in this project |
| *write a workflow that runs the tests, then asks me before deploying* | Legion writes a new routine for you, checks it works, and offers to run it |

On the welcome screen, **Tab** fills in an example for you.

### When Legion needs you

A card appears above the prompt, and it always shows the keys you can press:

- **A checkpoint** ("Approve this plan?"): `y` approves, `c` asks for changes (then type what you'd like
  different), `x` stops the run.
- **A question** from an agent: pick an option with ↑↓ and Enter, or just type your own answer.
- **A permission request** (when you've asked to be consulted): `y` allows it once, `s` for the rest of the
  session, `n` says no.

Want to say something to the assistant instead? Press **Tab** to switch to the chat and back.

### Handy keys

| Key | What it does |
|---|---|
| **Enter** | Send your message (**Shift+Enter** starts a new line) |
| **Esc** | Stop the assistant mid-reply |
| **/** | Show the commands. Type a few letters to find one |
| **?** | Show every shortcut |
| **Ctrl+O** | Show or hide the details of what the agents did |
| **PgUp / PgDn** or the mouse wheel | Scroll back through the conversation |
| **Ctrl+C** twice | Quit |

A few commands you'll use often: `/workflows` to browse what Legion can do, `/runs` to see what's been running,
`/config` for settings, and `/help` for everything else.

## Questions people ask

**Does it cost anything extra?**
Legion adds no costs of its own. The agents run on your own Claude and Codex plans, just as if you were using
those apps yourself. The status bar shows what the session has cost so far.

**Will it mess up my code?**
Agents build in separate copies of your repository (git worktrees), each on its own branch, so your checkout is left
alone while they work. Before anything ships, Legion shows you the changes and asks: a draft pull request, or a
merge into your branch. Out of the box
the agents are allowed to run commands without asking each time. That's what lets them work fast. To be asked
first, set `approvals = "ask"` (see [Configuration](docs/configuration.md)).

**I have two Claude accounts. Can I switch between them?**
Yes. Set them up once as *profiles*, then start with `legion --claude claude-2`, or switch inside a session with
`/claude claude-2`. The [Configuration](docs/configuration.md) page shows how.

**One of my accounts ran out of usage.**
Type `/provider claude` or `/provider openai` to move everything onto the other one. `/provider mixed` switches back.

**My laptop can't keep up with several agents building at once.**
Turn on [remote mode](docs/remote.md), and the heavy lifting runs on cloud machines instead.

**I closed Legion in the middle of something.**
No problem. Run `legion` again in the same folder and unfinished work picks up where it left off. Add `-c` to
continue the same conversation.

**Something isn't working.**
Run `legion doctor` first. It checks the most common problems and tells you what to fix.

## Learn more

The [docs](docs/README.md) cover everything in depth:

- [Using Legion](docs/using-legion.md): every key, card, command and menu
- [Workflows](docs/workflows.md): the built-in workflows, and how to write your own
- [Team leads](docs/team.md): long-running agents that each own a part of a big project
- [Configuration](docs/configuration.md): accounts, models, permissions and more
- [Remote mode](docs/remote.md): running agents on cloud machines
- [Developing Legion](docs/development.md): building from source and finding your way around the code
