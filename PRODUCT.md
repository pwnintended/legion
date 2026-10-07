# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron desktop app for macOS; the renderer is a React web UI.)

## Users

Developers who already use Claude Code and/or Codex and want to hand an issue to a team of agents and come back to a draft PR. They work on their own repositories, on their own machine, with their own CLI logins. (Inferred from the README and codebase; not yet confirmed in an interview.)

## Product Purpose

Legion takes an issue all the way to a draft pull request. It does this by orchestrating Claude Code and Codex through their own CLIs:

- An assistant talks with the user.
- A planner drafts a plan and a task DAG for sign-off.
- A lead runs execution, with coders working in parallel worktrees.
- Every task is reviewed by the other engine, fixed in rounds, verified and squash-merged into one integration branch.
- A final review precedes a single draft PR.

Success means the user spends their attention on decisions and outcomes, not on watching agents work.

## Positioning

Legion is a local orchestrator for the coding agents the user already pays for and trusts. It uses those agents' own CLIs and logins, cross-engine review is built in, and it ends in one reviewable PR. The user stays in charge at a small number of gates.

## Operating Context

- Projects are local git repositories.
- A run starts from a conversation with the assistant (or with "Plan directly").
- Human gates:
  - clarify questions
  - plan sign-off
  - tool approvals
  - escalations and conflicts
  - high-risk merges (`highRiskGlobs`)
  - the PR
- Runs can be stopped and archived (optionally discarding all local work).
- Optional `legion.json` per repo.

## Capabilities and Constraints

- **Roles:** assistant, planner, lead, coder, reviewer, resolver, finalizer, researcher, research_lead.
  - Coordinators (assistant, lead, research_lead) only talk; they have no tools.
  - Messages flow along parent↔child edges only.
- **Agent tools** (via the Legion MCP server): report_progress, request_human_input, send_message / wait_for_reply / ask_lead, spawn_research, and the lead's plan amendment tools.
- **Attachments:** image, text and file, at most 10 per message. They currently flow from the user to agents only.
- **Fake mode:** `LEGION_FAKE_ENGINES=1`. Demo fixtures: `?demo=1`.
- **Requirements:** macOS only, git ≥ 2.38, `gh` for PRs.

## Brand Commitments

- Name: **Legion**.
- The incumbent dark visual identity is to be kept: violet/peach accents, a sans body with mono metadata, and the component kit in `src/renderer/theme/`. The user confirmed this on 2026-10-07: "restructure, keep the look".

## Evidence on Hand

- Screenshots of every stage: `test-results/` (full-run, layout, session, plan-review, project-home, attachments, composer).
- Architecture: `docs/architecture.md`.
- Agent-messaging plans: `docs/plans/`.
- No customers, testimonials or usage metrics exist. Do not fabricate any.

## Product Principles

1. **The conversation is the product.** The user talks to one assistant. Everything else happens in the background and reaches the user through the assistant or as something to look at or decide.
2. **Attention is the scarce resource.** Surface decisions and outcomes, not activity. Background work stays inspectable but is never in the user's face.
3. **The human holds the gates.** Approvals, sign-offs and the PR are explicit, actionable and never paraphrased away.
4. **Your agents, your machine.** Legion orchestrates the CLIs the user already uses. Nothing leaves their machine except the PR.
