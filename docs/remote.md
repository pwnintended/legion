# Remote mode (Upstash Boxes)

Builds and tests of several parallel agents can swamp one machine. In remote mode, every step that works in one of
a run's worktrees (its agents and its `sh` steps) runs in an [Upstash Box](https://upstash.com/docs/box) instead:
one box per worktree, made when a step first needs it and deleted when the run ends. The assistant, leads, and steps
in your own checkout stay on this machine. Turn it on with `[remote] enabled = true`, `legion --remote`, or `/remote on`
in a session (`--local` and `/remote off` turn it off). The switch is read at every step, so flipping it mid-run is
safe.

```toml
# ~/.config/legion/config.toml or .legion/config.local.toml: the key never goes in a committed file
[remote]
apiKey = "box_…"                       # Upstash Console → Box → API keys (UPSTASH_BOX_API_KEY wins over it)

# .legion/config.toml
[remote]
enabled  = true
snapshot = "snap_…"                    # your own image, when the box agent does not make one (below)
clone    = "/workspace/home/repo"      # where that image's warm clone is: it becomes the worktree
prelude  = "source tools/box/env.sh"   # run before every command in a box, in the worktree root
setup    = ["pnpm install --offline"]  # run once in each new box
size     = "medium"                    # small | medium | large: 2, 4 or 8 CPUs
ttlHours = 24                         # Upstash deletes a box after this, even one Legion left behind (max 72)
runtime  = "node"                      # a fresh box's image, without a snapshot
```

- **Your checkout stays the source of truth.** The worktree exists on both sides at the same absolute path, so paths
  in prompts and tool calls mean the same everywhere. Before a step, Legion uploads the commits the box lacks (a git
  bundle, built here) and your uncommitted state (a patch). After it, what changed in the box comes back as a patch.
  The workflow's git steps (commit, merge, diff, PR) run here as always, and the box never needs GitHub access.
  Ignored files are not synced either way, so build caches stay on their side.
- **One account per box step.** Legion picks it from the account pool like a local step, among the accounts that can
  go to a box: a Claude account with a token (`tokenEnv` / `tokenFile` / `<dir>/oauth-token`, from `claude
  setup-token`) is passed as `CLAUDE_CODE_OAUTH_TOKEN`, and a Codex account with `remote = true` passes its
  `auth.json` (`CODEX_AUTH_GZIP_B64`, with `LEGION_CODEX_ACCOUNT`), which seeds `~/.legion/codex-home/<account>` in the
  box once. Codex is opt-in because a box refreshing a copied `auth.json` may log the local copy out. When no account
  qualifies, the step uses the implicit `box` account: the login in the Upstash account's environment variables
  (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; `CODEX_AUTH_GZIP_B64`), which Legion never reads or passes. A
  limit moves the next attempt to another account, as locally. Tokens go only into the box session's environment,
  never into logs or the run journal.
- **The CLIs:** a box without `claude` or `codex` gets it installed with npm on first use. A snapshot that already
  has them starts faster.
- **Boxes never outlive their TTL.** Legion deletes a run's boxes when it ends (done, failed or cancelled). An
  interrupted run keeps them for a resume, and a crash leaves them, but every box is ephemeral: Upstash deletes it
  `ttlHours` after it was made, whatever happens to Legion. Keep it above your longest runs: a run still going
  when its boxes expire fails its next remote step (a resume gets new boxes).
- **The box is the sandbox.** Codex's own sandbox (bubblewrap) cannot run in a box, so Codex runs there without it,
  with the same approvals. Read-only steps (reviews) are read-only by their instructions there, not enforced.
- **Sessions resume within their box, on their account.** A step resumed on another account, or after its box is gone
  (the run ended, or the box expired), starts a new session.
- **MCP servers** on this machine's loopback (`http://127.0.0.1:…`) are out of a box's reach and left out. Stdio
  servers start in the box, so the snapshot needs them.
- **Talking to the assistant and leads** works as it does locally: the CLI's stdio protocol (stream-json for Claude,
  the app-server for Codex) is piped through the box's exec session, so approvals, questions, steering
  (`message_agent`) and results travel the same way. Workflow agents do not get Legion's own MCP tools either way.
- `legion doctor` shows whether remote mode is on and whether a key is set.

## The box image and the box agent

Boxes start from the box image: a snapshot with the project's toolchain, dependencies and a warm build. The box
agent (the builtin `box` workflow) makes and extends it, and the assistant coordinates it:

- **Agents ask, they do not install.** An agent in a box that lacks a tool runs `legion-need '<what>' '<why>'` and
  carries on as far as it can. Legion passes the request to the assistant, which starts the box agent
  (`provision_box`, with any other pending requests and the commands that must pass afterwards), then unblocks the
  agent (`message_agent`) or retries its step. `box_status` shows the image and what is waiting.
- **The box agent** works in a box of its own (whether remote mode is on or not). It updates
  `.legion/box/provision.sh` (an idempotent install script) and `.legion/box/env.sh` (sourced before every command
  in a box), runs them, and warms the build. Legion runs the script once more and the verify commands, saves the
  box as the new image, copies the two files into your checkout (commit them), deletes the previous image, and
  brings running boxes up to date.
- **Which snapshot is current** is per machine and account: `.legion/box/image.local.json` (gitignored). It takes
  precedence over `[remote] snapshot`. Without either, boxes start bare and the assistant is told to make an image.
