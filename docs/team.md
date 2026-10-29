# Team leads

The assistant you talk to is the orchestrator. For a big area of work it can spawn a **team lead**: a long-lived
agent with its own context, role and plan. A lead runs workflows, answers its own runs' gates and questions, may
spawn sub-leads (an assets lead with fauna, vegetation and building-kit leads under it), and reports to its
parent. Each lead hears only from its own children, so the orchestrator's context stays about the whole project.

Leads report with a kind: `progress`, `done`, `blocked`, `question`, `review` (something a human should judge,
with the files or images to look at) or `coordinate` (it needs something from another team). Reports, messages,
finished runs and waiting gates go into the parent's inbox and arrive as one bundled `[Legion]` message when it is
free. The orchestrator brings `review`s and user-only questions to you and passes your answer back.

Who answers a run's gates, questions and tool approvals depends on who started it:

- The orchestrator's runs ask you, unless `[team] gates = "decide"`: then the orchestrator answers and brings
  you only what it cannot settle.
- A lead's runs follow its role's `gates`: `decide` (the default) means the lead answers. `tell` means the lead
  answers and its parent hears every answer. `ask` means you answer, and the lead is told what its run waits on.

## Branches and worktrees

Every lead works in **its own git worktree on its own branch**, `legion/lead/<name>`, under
`~/.legion/worktrees/<repo>-<hash>/leads/<name>`. It never writes in your checkout or another lead's. A lead
under the orchestrator branches off the branch you have checked out, and a sub-lead branches off its parent's.

- A lead commits its work on its branch. Workflow runs it starts begin from that branch's last commit, work in its
  worktree, and merge back into it (`tasks` and `feature` take `base` to aim elsewhere).
- When a lead reports done, its parent merges the branch up with `merge_lead`. For the orchestrator's leads that
  means into the branch you have checked out, so the work shows up in your checkout. Uncommitted leftovers are
  committed first. A conflict is handed back to the lead to resolve on its own branch.
- `run_workflow` warns the caller when its checkout has uncommitted files, because the run's worktrees won't have
  them.
- Agents are told never to make worktrees or branches themselves. A role with `workspace: shared` works in your
  checkout instead (for leads that only coordinate). Leads created before this change keep working in your
  checkout.
- `/team` shows each lead's branch and worktree.

In the session:

- **The team panel** under the prompt shows every lead that is not stopped, as a tree. Each line has the lead's
  progress through its plan, the item it is on, its runs and what waits for its answer. Leads' runs show as one
  line each.
- `/lead <name>` switches the prompt to a lead. You talk to it directly, its replies stream in, and its runs'
  gates and questions join your queue, so you can answer them in its place (it is told you did). `/lead` alone
  goes back to the orchestrator.
- When the orchestrator wants you to look at something (a lead's review, a screenshot, a page), it uses `present`:
  every item appears in the conversation as a clickable link (file or URL).
- `/team` prints the tree with plans and last reports. `/stop <lead>` stops a lead, its sub-leads and their runs.

Leads and the orchestrator can also steer runs. `message_agent` sends a running agent a correction mid-turn.
`retry_run` stops and resumes a run with notes for the next attempt. With `rewind`, it redoes a finished step
and everything after it, e.g. a critique round with new instructions.

State is kept in `.legion/team/team.json` (gitignored). After a restart, a lead resumes its session on the next
message it gets.

## Roles

A role is a Markdown file: YAML frontmatter for how the lead runs, the body for its standing instructions.
Resolution, first match by name wins: `.legion/roles/<name>.md`, `~/.config/legion/roles/<name>.md`, builtin
(`team-lead`, `engineering-lead`, `art-director`, `world-designer`).

```markdown
---
description: "Fauna for one planet: concept, model, critique, export"
engine: claude            # claude | codex, in mixed mode (a single provider wins)
tier: lead                # its model and effort: [models.<engine>.lead] (default); model/effort pin one
workflows: [asset-critique, concept-sheet]   # which workflows it may run, or "*"
spawns: []                # which roles it may spawn as sub-leads, or "*"
approvals: auto           # its own tool approvals: auto, or ask (you answer them)
gates: decide             # its runs' gates: decide (the lead) | tell (lead, parent hears) | ask (you)
maxRuns: 4                # runs it may have active at once
workspace: branch         # branch (its own worktree and branch) | shared (your checkout)
---
You make the creatures for …
```

MCP servers for leads and the `[team]` limits are in [Configuration](configuration.md#mcp-servers-and-limits).
