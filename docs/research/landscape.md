# Legion research: competitive landscape and UX lessons (as of 2026-10-06)

Caveat: direct HN/Reddit/X threads were not retrievable via the search tool; sentiment below is drawn mostly from blogs, vendor comparison pages (biased) and surveys. Treat vendor "compare" pages as marketing. Pricing details are thin/unverified.

## 1. Product notes

**Conductor (Melty Labs, YC; Mac app)** - https://www.conductor.build/ , https://conductor.build/compare/claude-code , https://www.conductor.build/workflows
- Workspace = git worktree + branch + terminal + diff + checks + PR path. Runs Claude Code and Codex (earlier comparisons say Claude-only; now both). Setup scripts per repo, shared context, checks, PR creation, archive flow. Local-first; cloud monitoring layer for team visibility (multiplayer streaming early access). Strength: minimal setup, clear "one task = one workspace" model, dashboard of workspaces. Weakness: no pre-implementation plan/spec gate or DAG; per-task manual orchestration (defract.dev comparison: https://defract.dev/blog/conductor-vs-superset).

**Vibe Kanban (bloop)** - SHUT DOWN 2026-04-10: company closed because most users were free and no business model; now Apache-2.0 community-maintained, fully local. Pro was $30/user/mo. https://vibekanban.com/blog/shutdown , https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/ . Lesson: kanban-of-agents was loved but monetization of a free orchestration layer is hard; also signals commoditization.

**Superset (superset.sh)** - local-first desktop, worktree per task, many CLIs (Claude Code, Codex, OpenCode, Cursor Agent, Copilot, Gemini, Aider...), persistent terminals, in-app browser, MCP, remote/cloud workspaces, built-in PR mgmt, claims 100+ agents, SOC2 (Aug 2026). Weakness: config complexity, per-task model choice overhead, no design/spec gates. https://superset.sh/compare/superset-vs-sculptor

**Emdash (YC, open source, provider-agnostic)** - 28 CLI agents, side-by-side agents, review in one place, create PR. Worktrees; Linear/GitHub/Jira issue pull-in. https://www.ycombinator.com/companies/emdash , https://emdash.sh/docs

**Sculptor (Imbue)** - containers (not worktrees) for isolation; "pairing mode" syncs a container to the local checkout; rebuilt Sept 2025; still active June 2026. https://imbue.com/ , https://superset.sh/compare/superset-vs-sculptor

**Crystal -> Nimbalyst** - Crystal (Stravu, Electron) evolved into Nimbalyst, a multi-agent workspace (kanban + agents + editor + review); actively released (v0.72+). https://nimbalyst.com/compare/vibe-kanban/ , https://newreleases.io/project/github/nimbalyst/nimbalyst/release/v0.72.8

**Claude Squad** - TUI over tmux + worktrees, multiple agents (Claude, Codex, Aider...). Lightweight, terminal-native; weak review UX. https://bernstein.readthedocs.io/en/latest/compare/bernstein-vs-claude-squad/

**Terragon** - no current info found (likely discontinued/unverified; do not rely).

**Claude Code desktop (redesigned 2026-04-14)** - multi-session sidebar (filter by status/project/env, group by project), worktree per session (.claude/worktrees), drag-and-drop panes (terminal, editor, rebuilt fast diff viewer, preview), side chats (Cmd+;), Verbose/Normal/Summary view modes, auto-archive sessions when PR merges/closes, usage/context meter, plugin parity, SSH. "many things in flight, you in the orchestrator seat". https://claude.com/blog/claude-code-desktop-redesign . Also Claude Code on the web (cloud VMs), and Agent Teams (lead + teammates, shared task list with dependencies auto-unblocking) https://addyosmani.com/blog/claude-code-agent-teams/ , https://www.morphllm.com/claude-code-agent-teams . Agent teams caveat: drift, stuck on permission prompts, tasks marked done prematurely, need check-ins every 10-15 min.

**OpenAI Codex app (macOS Feb 2026, Windows Mar 4 2026) + Codex cloud/CLI** - multi-agent threads per project, built-in worktrees, inline diff review with comments, open in editor, skills, scheduled automations (review queue), included in ChatGPT plans (promo: free/Go, doubled limits). Praised for polished review queue and token efficiency (2-4x leaner than Cursor per morphllm - treat with caution). Parallel but isolated agents, no inter-agent messaging. https://openai.com/index/introducing-the-codex-app/ , https://www.morphllm.com/openai-codex-app

**Cursor 3 (2026-04-02) Agents Window** - agent-first UI; local (worktrees) + cloud agents in one sidebar, including those started from mobile/web/Slack/GitHub/Linear; /in-cloud handoff; /babysit a PR. Complaints: token/credit burn, subagents can't coordinate (no shared task list/messaging), background agents billed separately. https://www.datacamp.com/blog/cursor-3 , https://www.morphllm.com/comparisons/cursor-agent , https://forum.cursor.com/t/has-anyone-else-seen-a-huge-increase-in-agent-token-usage-since-august-1/167952

**GitHub Agent HQ / Copilot coding agent** - mission control: assign, steer, track many agents (Copilot, Claude, Codex, Jules, Cognition, xAI) across GitHub, VS Code, CLI, mobile; Plan Mode asks clarifying questions; agentic code review before human; one-click conflict resolution; Slack/Linear; metrics dashboard; enterprise governance/audit. Cloud (Actions runners) execution; output = PR. https://github.blog/news-insights/company-news/welcome-home-agents/ , https://sdtimes.com/ai/github-unveils-agent-hq-the-next-evolution-of-its-platform-that-focuses-on-agent-based-development/

**Devin (Cognition)** - cloud VM, PR output; $1B raise at $26B (June 2026). **Jules (Google)** - cloud VM, plan shown for approval, PR. **Factory Droids** - enterprise async agents. **Amp, Warp** - not researched in depth. Pattern for cloud async agents: well-scoped tasks >15 min where mid-edit steering isn't needed. https://techsy.io/blog/background-coding-agents-compared , https://ssojet.com/blog/best-cloud-coding-agents

**Plan/spec-first tools**
- Kiro (AWS): requirements -> design -> tasks, hooks. GitHub Spec Kit (~71K stars, 20+ agents): constitution/specify/plan/tasks/implement. Traycer: Phases/Plan/Review/Epic modes, hands plans to Claude Code/Cursor/etc. https://docs.traycer.ai/tasks . Taskmaster AI (PRD -> tasks with dependencies, MCP), Backlog.md (markdown tasks in repo), CCPM (PM via GitHub issues + worktrees) - not deeply verified here.
- Critiques: sequentially-generated artifacts go stale when one is edited; spec drifts from code after weeks; no verification loop against the running app; unit tests passing != feature working. https://www.morphllm.com/spec-driven-development , https://codemyspec.com/blog/spec-kit-vs-kiro , https://ssojet.com/blog/best-spec-driven-development-tools
- Both Conductor and Superset noted by a comparison as lacking pre-implementation design gates and structured lifecycle management.

## 2. Feature matrix (approximate; verify before citing)

| Product | Isolation | Agents | Plan/spec step | Task DAG | Built-in review | Auto-review agent | PR/merge | Surface |
|---|---|---|---|---|---|---|---|---|
| Conductor | worktree | Claude, Codex | no | no | diff + checks | no | PR flow | Mac app |
| Superset | worktree | many CLIs | no | queue only | diff, PR | no | PR mgmt | desktop |
| Emdash | worktree | 28 CLIs | no | no | per-agent diff | no | PR | desktop OSS |
| Sculptor | container | Claude | no | no | pairing mode, suggestions | yes (code suggestions) | merge | desktop |
| Nimbalyst | worktree | Claude/Codex | kanban/docs | no | yes | no | PR | desktop |
| Claude Squad | worktree+tmux | many | no | no | weak | no | commit/push | TUI |
| Claude Code desktop | worktree | Claude | plan mode | Agent Teams (lead + task list) | rebuilt diff viewer | /review | PR watch, auto-archive | desktop+web |
| Codex app | worktree | Codex | no | no | inline comments | /review | PR | desktop+cloud |
| Cursor 3 | worktree/cloud | Cursor (+models) | plan mode | no (subagents isolated) | yes | Bugbot | PR, /babysit | IDE |
| Agent HQ | cloud | Copilot, Claude, Codex, Jules... | Plan Mode | no | agentic review | yes | PR, conflict res. | web/VSC |
| Kiro/Spec Kit/Traycer | n/a | various | YES | task lists, loosely | limited | Traycer review | n/a | IDE/CLI |
| Legion (target) | worktree per DAG node | Claude + Codex | plan from issue | explicit DAG | per-task agent review + human | yes, cross-model | integration merge + PR | Electron |

## 3. Sentiment (themes with sources)

LOVED
- One task = one isolated workspace; sidebar/status at a glance; parallel throughput for independent work (Conductor, Codex app, Claude Code desktop).
- Polished review queue/inline diff comments (Codex app); fast diff viewer; auto-archive on merge.
- Terminal-native flexibility and persistence (tmux style), keeping the agent's own CLI.
- Plan-first catching misunderstandings before code (Jules plan approval, Plan Mode asking clarifying questions).
- Cross-device/cloud handoff (Cursor 3, Agent HQ, Claude on web).

HATED / PAIN
- Context switching and losing track of what each agent is doing (mindstudio: https://www.mindstudio.ai/blog/ai-command-center-managing-multiple-claude-code-agents).
- Review bottleneck grows linearly with agent count; 96% distrust AI code but only 48% always verify; 38% say reviewing AI code takes more effort than human code; PRs merged without review +31%; incidents/PR +243% (Sonar, Faros via https://www.theregister.com/2026/01/09/devs_ai_code/ , https://codex.danielvaughan.com/2026/06/07/agentic-fatigue-verification-gap-codex-cli-sustainable-ai-assisted-development/).
- Agentic fatigue: cognitive debt, compressed decision density, "batch your reviews", cap retries at 3-4 attempts then re-decompose.
- Merge conflicts when tasks overlap in shared files (config, types, entry points); the fix is task decomposition with file-scope discipline, not tooling alone (https://adamtornhill.substack.com/p/why-merge-conflicts-became-the-new , https://www.verdent.ai/guides/review-merge-conflicts-parallel-ai-agents , https://superset.sh/blog/parallel-coding-agents-guide).
- Worktree setup: per-worktree node_modules install, .env copying, dev-server port collisions, shared DB/migrations clobbering (https://www.mindstudio.ai/blog/git-worktrees-parallel-ai-coding-agents).
- Agents blocked on permission prompts unseen in background; tasks marked done prematurely; drift in long-running teams (https://www.mintlify.com/shanraisshan/claude-code-best-practice/workflows/agent-teams).
- Token/credit cost opacity and burn (Cursor forum thread above).
- Spec-driven: heavy ceremony, stale artifacts, spec/code drift, no runtime verification.
- Business fragility: Vibe Kanban died; orchestrator-only UI is commoditized (differentiation must be workflow depth).

## 4. UX principles Legion should adopt (15)
1. One inbox for attention: a single "needs you" queue (approvals, plan sign-off, review, conflicts) ranked by unblock value; everything else stays quiet.
2. Status at a glance: DAG/graph view as the home screen with live node states (queued, running, blocked-on-you, reviewing, done, failed); one-line live summary per agent rather than raw transcripts (Summary/Normal/Verbose modes, like Claude desktop).
3. Plan as an editable, reviewable artifact: structured, diffable plan with clarifying questions up front; edit nodes, dependencies, and file scopes inline; approve once, then run unattended.
4. Plan as living state: plan is regenerated/amended from reality (agent reports, conflicts), with visible "plan changed" diffs to prevent drift; plan lives in repo or is exportable.
5. File-scope contracts per task: planner declares expected files/modules; serialize overlapping tasks automatically; warn when an agent strays outside scope.
6. Zero-config worktrees: auto-copy env files, install deps (cache/hardlink), allocate unique ports/DB names, per-repo setup/teardown script learned and remembered.
7. Pre-approved permission profiles per task (scoped allowlist from the plan) so agents rarely block; if blocked, surface in the inbox with one-click approve and notify.
8. Review designed for batching and low fatigue: per-task review pack = summary of intent vs outcome, risk-ranked diff, test/lint evidence, reviewer-agent findings; keyboard-driven approve/request-changes; inline comments that go back to the agent.
9. Evidence over claims: "done" requires machine-verified gates (tests, typecheck, lint, task acceptance criteria, optional runtime/browser check); show the evidence, not the agent's assertion.
10. Cross-model review: Claude reviews Codex work and vice versa; reviewer is a distinct agent with fresh context against the acceptance criteria.
11. Integration branch merging with early conflict detection: merge completed nodes continuously into an integration worktree, run tests on the combined result, and have an agent resolve conflicts with human fallback; show the conflict forecast before launch.
12. One-click PR with generated description derived from plan + per-task summaries + review results; auto-archive on merge; optional babysit CI.
13. Cost and time transparency: estimate per plan, live token spend per node, budgets/caps, retry cap (3-4) then escalate to human re-decomposition.
14. Escape hatches: open any task's worktree in editor/terminal, take over the agent session, side-chat with an agent without polluting it, pause/retry/reassign backend per node.
15. Calm, fast, native feel: keyboard-first command palette, persistent sessions across restarts, notifications only for true attention items, sensible defaults with progressive disclosure; works on repos without setup.

## 5. Pain points Legion must solve to be clearly better
- Issue-to-merged-PR with minimal babysitting (the review gate is the only required human step besides plan approval).
- Review fatigue: reduce what a human must read via structured evidence, reviewer agents and risk ranking.
- Conflicts: prevent by plan-time scoping and sequencing, not just resolve afterwards.
- Visibility: always know what every agent is doing and what is waiting on you.
- Environment friction (env, deps, ports, DB) handled automatically.
- Trustworthy "done" via gates.
- Plan drift and spec ceremony: lightweight plan, auto-updated.
- Cost control.

## 6. Gaps / opportunity
- No product ships the full pipeline issue -> clarifying plan -> explicit DAG -> parallel execution -> per-task agent review -> integration merge -> PR with both Claude and Codex backends. Conductor/Superset/Emdash/Codex app/Cursor are parallel runners without planning; Kiro/Spec Kit/Traycer plan without orchestration/isolation; Claude Agent Teams has a dependency task list but terminal-bound, Claude-only, no integrated review/merge UX; Cursor subagents can't coordinate; Agent HQ is multi-vendor but cloud/GitHub-centric, not a local DAG-driven experience.
- Cross-backend adversarial review (Claude vs Codex) is essentially unoccupied.
- Scope-aware DAG scheduling (file-overlap-based serialization) and integration-branch continuous merging are unaddressed in the desktop tools.
- Runtime verification of acceptance criteria is a gap even in spec tools.
- Local-first, bring-your-own-subscription (Claude Code/Codex CLIs) avoids the cost/business-model trap that killed Vibe Kanban, but plan differentiation on workflow depth rather than orchestration UI.
- Risk: platforms (Claude desktop, Codex app, Cursor 3, Agent HQ) are converging on parallel sessions + review quickly; Legion's moat is the planning/DAG/review/merge pipeline and cross-vendor neutrality.

## Sources (principal)
https://www.conductor.build/ ; https://vibekanban.com/blog/shutdown ; https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/ ; https://superset.sh/compare/superset-vs-sculptor ; https://defract.dev/blog/conductor-vs-superset ; https://claude.com/blog/claude-code-desktop-redesign ; https://openai.com/index/introducing-the-codex-app/ ; https://www.datacamp.com/blog/cursor-3 ; https://github.blog/news-insights/company-news/welcome-home-agents/ ; https://www.morphllm.com/spec-driven-development ; https://codemyspec.com/blog/spec-kit-vs-kiro ; https://docs.traycer.ai/tasks ; https://addyosmani.com/blog/claude-code-agent-teams/ ; https://adamtornhill.substack.com/p/why-merge-conflicts-became-the-new ; https://www.theregister.com/2026/01/09/devs_ai_code/ ; https://codex.danielvaughan.com/2026/06/07/agentic-fatigue-verification-gap-codex-cli-sustainable-ai-assisted-development/ ; https://www.mindstudio.ai/blog/git-worktrees-parallel-ai-coding-agents ; https://www.ycombinator.com/companies/emdash ; https://techsy.io/blog/background-coding-agents-compared
