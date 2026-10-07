# Agent messaging, phase 3: research as a spawnable profile

Both coordinators (the lead now, the assistant in phase 4) can spawn research: a single researcher for a focused
question, or a research lead that fans a brief out to several researchers and synthesises their reports. Research
agents read the repository and the web and never write, so they can never make a conflicting decision.

## Mechanics

- **Roles** `researcher` (read-only + web) and `research_lead` (coordinate + web, in `COORDINATOR_ROLES`).
  `PermissionProfile.web` turns the web tools on: Claude pre-approves `WebSearch` and `WebFetch` (and keeps them out
  of the coordinate deny list); Codex sets `web_search = "live"`.
- **`spawn_research({title, brief, mode})`** (MCP, coordinators only): opens the agent as a child of the caller and
  returns its attempt id at once. `mode: team` opens a research lead; a research lead may only spawn `single`, so the
  tree is at most lead → research lead → researchers. Caps per parent: lead 3, research lead 4 running research agents.
- **Output.** Every research agent ends its turn with a `ResearchReport` (structured output: summary, findings with
  evidence and sources, open questions, confidence). The driver (`orchestrator/research.ts`) renders it to markdown
  and posts it as a `report` message to the parent, then closes the agent. A failure posts a `status` message.
- **Receiving reports.** The lead gets them on its next wake. A research lead blocks in `wait_for_reply` until its
  researchers reported, then writes the final report.
- Researchers run in the integration worktree (untrusted config, like reviewers), with the run's attachments.

## Out of scope

The assistant (phase 4), UI (phase 5), persistent research memory.
