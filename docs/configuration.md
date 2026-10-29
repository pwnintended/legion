# Configuration

How Legion is configured: which files it reads, accounts, approvals, worktrees, models, and MCP servers.
`/config` in a session changes most of this from a menu; this page is the reference.

Layers, later ones win:

1. `~/.config/legion/config.toml`, the user config. Accounts usually go here.
2. Every `.legion/config.toml` from the outermost parent directory down to where you start `legion`. A parent
   folder can hold settings for all the repositories under it.
3. The project's `.legion/config.local.toml`, which is gitignored and holds machine-specific overrides.

If there is no `.legion/config.toml` in the directory, the repository root or any parent, the first session
writes a commented one at the project root. Its values are the settings already in effect, so creating it changes
nothing. Every key is optional.

```toml
[claude]
command = "claude"                       # binary and extra args of every Claude account
args    = []

[accounts]
cooldownMinutes = 60                     # cooldown when a limit is hit and the CLI gave no reset time

[accounts.claude.work]
dir       = "~/.claude-work"             # CLAUDE_CONFIG_DIR; omitted: the CLI's own login
tokenEnv  = "CLAUDE_WORK_TOKEN"          # optional: env var with a `claude setup-token` token

[accounts.codex.personal]
dir = "~/.codex-personal"                # CODEX_HOME holding auth.json

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

## Accounts

Legion keeps a pool of accounts per engine and picks one for every agent session and workflow step. Workflows only
say `engine: 'claude'` or `'codex'`. Agents spawn `command` directly, with no shell per agent.

**Adding accounts.** `legion login claude work` (or `/login claude work` in a session) creates
`~/.legion/accounts/claude/work` and runs `claude auth login` there, with `CLAUDE_CONFIG_DIR` pointing at it.
`legion login codex` runs `codex login` with `CODEX_HOME` the same way. Without a name you get the next free
`claude-N` / `codex-N`. For a Claude token, use `legion login claude work --token`: it runs `claude setup-token`.
Legion never reads its output; save the token in `~/.legion/accounts/claude/work/oauth-token` (mode 600) yourself.

**Discovery.** Every directory `~/.legion/accounts/{claude,codex}/<name>/` is an account `<name>`, with `dir` set to
that directory. Claude accounts use `<dir>/oauth-token` as the token file when it exists. `[accounts.<kind>.<name>]`
entries in the config override discovered ones field by field, or add accounts elsewhere on disk.

| Key | Meaning |
| --- | --- |
| `dir` | `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Omitted: the CLI's own login (for Codex, `~/.codex` or `$CODEX_HOME`). |
| `tokenEnv` | Claude: name of an env var holding a `claude setup-token` token, passed as `CLAUDE_CODE_OAUTH_TOKEN`. |
| `tokenFile` | Claude: a file whose first line is the token. Alternative to `tokenEnv`. |
| `enabled` | `false` takes the account out of the pool. Default `true`. |
| `remote` | Usable in [remote boxes](remote.md). Default: true for Claude accounts with a token, false for Codex. |
| `env` | Extra environment for the CLI. `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN` here are a config error. |

**No accounts.** With none of a kind, there is one implicit account named `default`: the plain CLI with your own
login, as before. Codex keeps using `~/.legion/codex-home/default`, so old threads still resume.

**The pool.** State lives in `~/.legion/accounts/pool.json`, shared by every Legion process.

- *Round-robin.* Each step takes the next enabled account that is not cooling down.
- *Cooldowns.* When an account hits its usage or rate limit, it rests until the reset time the CLI reported, or for
  `cooldownMinutes`. `legion accounts reset [kind[/name]]` clears cooldowns.
- *Affinity.* A resumed step prefers its old account, since a Claude session lives in one config dir and cannot move.
  The assistant and leads keep one account until it hits a limit.
- *Failover.* The step starts over on the next free account, once per account, up to four times. The prompt tells
  the agent an earlier attempt was stopped by a limit and the worktree may hold partial work.
- *Exhaustion.* When every account is at its limit, the step fails and you are told when the earliest one resets.
  Resume the run then.

`/accounts` (or `legion accounts`) lists each account with its login status, cooldown and last use.

**Migrating from profiles.** `[claude.profiles.*]`, `[codex.profiles.*]`, `default` and `setup` no longer exist.
A config that still has them fails to load with the equivalent `[accounts.*]` entries shown.
`legion accounts migrate` rewrites your user config (keeping a `.bak`). Profile names become account names;
`setup` is dropped.

**Terms of use.** Legion only chooses which config dir or token an unmodified `claude` / `codex` starts with. It has
no proxy and no OAuth client, never sets a base URL, and never reads or refreshes your credentials. Accounts move
between steps, never in the middle of a request.

A run records the account each step used. Claude keeps sessions under `CLAUDE_CONFIG_DIR`, so an interrupted
Claude step resumes its session only on the same account; otherwise it restarts. Finished steps are replayed from
the journal.

Codex runs with a Legion-owned `CODEX_HOME` (`~/.legion/codex-home/<account>`). It links only the account's
`auth.json`, so your Codex config, hooks and `AGENTS.md` do not leak into runs.

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
