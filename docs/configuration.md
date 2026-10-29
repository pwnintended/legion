# Configuration

How Legion is configured: which files it reads, accounts (profiles), approvals, worktrees, models, and MCP servers.
`/config` in a session changes most of this from a menu; this page is the reference.

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
engine = "claude"                        # which engine you talk to (in mixed mode)
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

## Models: tiers and providers

Nothing names a model directly. The assistant runs on the `assistant` tier, every lead on `lead` (a role can pick
another), and every workflow agent step on `hard`, `medium` (the default) or `easy`. `[models]` says which model and
effort each tier means on each engine, and which provider everything runs on:

```toml
[models]
provider = "mixed"               # claude | codex | mixed  (/provider claude|openai|mixed switches it)

[models.claude.hard]             # the defaults: opus for assistant, lead and hard (hard at high effort),
model  = "opus"                  # sonnet for medium, haiku for easy
effort = "high"

[models.codex.hard]              # Codex: its CLI's model unless you set one; efforts high, high, high, medium, low
model  = "…"                     # a model from Codex's list (the /workflows model picker shows it)
effort = "xhigh"
```

`/config` sets these: the provider, and each tier's model and effort per engine (←→ cycles through the engine's
models, Enter types one). A tier table overrides its defaults field by field: setting `model` alone keeps the tier's
effort. With
`provider = "claude"` or `"codex"`, everything runs on that engine, including steps whose code names the other one.
With `mixed`, each runs on the engine its settings or code choose (Claude when nothing says).

A workflow step's tier comes from the `/workflows` menu, which writes these, or from the code
(`agent(key, { tier: 'hard' })`):

```toml
[workflow.feature]               # every agent step of `feature` whose code and step setting name no tier
tier = "easy"

[workflow.feature.agent.plan]    # the `plan` step
tier = "hard"

[workflow.feature.agent.review]  # in mixed mode, run the `review` steps on Codex whatever the code says
engine = "codex"

[workflow."*"]                   # every workflow
tier = "medium"
```

The tier is the step setting's, then the code's, then the workflow's, then `"*"`'s, else `medium`. A step can still
pin a `model` and `effort` (in the step setting or in code), over its tier's: they are names for one engine, so
they apply only while the step runs on it, and the tier's apply on the other. `[assistant] model` and a role's
`model` work the same way.

Your own CLI settings do not apply to agents: Claude agents load only project settings, and Codex
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

## MCP servers and limits

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

Leads and roles are in [Team leads](team.md); remote mode is in [Remote mode](remote.md).
