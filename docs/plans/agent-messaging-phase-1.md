# Agent messaging, phase 1: hierarchy, mailbox and the `coordinate` permission mode

Phase 1 of the orchestration proposal (report: "Legion agent orchestration: SOTA survey and proposal"). It adds the
plumbing every later phase (lead, research profile, assistant) builds on, without changing how today's runs behave:
no existing role gets a parent, so no existing agent sees a new tool.

## Goal

Agents can be arranged in a tree (one parent per attempt), may message only along the edges of that tree, and the
engine can start a session that is allowed to do nothing but talk (`coordinate`).

## Scope

In:

1. `attempts.parent_attempt_id` and `Attempt.parentAttemptId`: the hierarchy edge.
2. A `messages` table and `AgentMessage` domain type: `kind` (brief, question, answer, report, status), markdown
   `body`, `replyTo`, `deliveredAt`.
3. A third `PermissionProfile.mode`, `coordinate`: no file, shell, web or sub-agent tools; only the Legion MCP server.
   Claude: `dontAsk` + an explicit denied-tool list. Codex: read-only sandbox (its tool list is not configurable, so
   this is best effort until a Codex coordinator exists).
4. MCP tools, registered only for attempts that have a parent or whose role is a coordinator:
   - `list_agents()` → the caller's parent and children (ids, roles, task node ids, status).
   - `send_message({to, kind, body, reply_to?})` → mailbox insert; refused unless `to` is the caller's parent or child.
   - `wait_for_reply({message_id?, timeout_seconds?})` → blocks until a reply to that message (or any inbound
     message) arrives; `null` on timeout.
   - `ask_lead({question})` (parent only) → `send_message(question)` + `wait_for_reply` in one blocking call.
5. Delivery: a message resolves a blocked `wait_for_reply`/`ask_lead` on the recipient immediately; otherwise it stays
   queued and is prepended to the prompt the next time the orchestrator resumes that recipient's engine session.
   Nothing is ever injected into a running turn (that would hand the task driver a turn it did not ask for).
6. `messages.list({runId})` RPC and a `message.created` server event, so the UI can show threads in phase 5.
7. Pure helpers in `orchestrator/core/messaging.ts` (edge check, prompt rendering) with tests; store, adapter, MCP
   and orchestrator-level tests.

Out (later phases): the lead and assistant roles, spawning tools, `add_task` and friends, research profile and web
tools, the org and thread tiles, Codex tool restriction.

## Design

### Hierarchy

`OpenSessionParams.parentAttemptId` (default null) is stored on the attempt row and copied into the MCP binding.
The edge check is pure: `canMessage(from, to)` is true when `to.parentAttemptId === from.id` or
`from.parentAttemptId === to.id`, and both attempts belong to the same run. There is no sibling or skip-level
messaging; the error text tells the agent to go through its lead.

### Mailbox

`Store.insertMessage` appends a `message.created` event in the same transaction. `Store.listMessages(runId)` for the
RPC, `Store.queuedMessagesFor(attemptId)` plus `Store.markDelivered(ids)` for delivery.

Delivery in the orchestrator:

- `messageWaiters: Map<attemptId, Waiter[]>`, one waiter per blocked `wait_for_reply` / `ask_lead`. A waiter matches
  a message when its `replyTo` filter is null or equals the message's `replyTo`.
- `insertMessage` → if a waiter on the recipient matches, resolve it and mark the message delivered; else leave it
  queued.
- `openSession` with `resumeSessionId` (fix rounds, hand-backs, recovery) drains queued messages addressed to the
  attempts that share that engine session and prepends them to the prompt (`renderMessages`), marking them delivered.
- A recipient whose session ends rejects its waiters (same as inbox waiters today); engine shutdown rejects all.

### Permission mode

```ts
mode: 'read_only' | 'workspace_write' | 'coordinate'
```

`permissionProfileFor` keeps the role table; no role maps to `coordinate` yet. Claude denies
`Read, Glob, Grep, LS, Bash, BashOutput, KillShell, WebFetch, WebSearch, Task, Agent, NotebookRead, TodoWrite, Skill,
ToolSearch` on top of the read-only list. Codex gets `sandbox: read-only`, `approvalPolicy: never`.

### MCP

`McpBinding` gains `parentAttemptId`. `buildServer` registers the messaging tools when
`binding.parentAttemptId !== null || COORDINATOR_ROLES.has(binding.role)`; `ask_lead` only with a parent.
`McpHost` gains `listAgents`, `sendMessage`, `awaitMessage`. Tool names are added to `CLAUDE_TOOL_NAMES`.

## Files

| Area | Files |
| --- | --- |
| Contracts | `src/shared/domain.ts`, `src/shared/engine.ts`, `src/shared/events.ts`, `src/shared/rpc.ts` |
| Persistence | `src/engine/db/migrations/005_messages.ts`, `migrations/index.ts`, `src/engine/db/store.ts` |
| Adapters | `src/engine/adapters/claude/args.ts`, `src/engine/adapters/codex/config.ts` |
| MCP | `src/engine/mcp/server.ts`, `src/engine/mcp/config.ts`, `src/engine/mcp/README.md` |
| Orchestrator | `src/engine/orchestrator/core/messaging.ts`, `core/index.ts`, `orchestrator.ts`, `handlers.ts` |
| Docs | `docs/architecture.md` §5, §6, §7, §10 |
| Tests | `store.test.ts`, `args.test.ts`, `config.test.ts`, `mcp/server.test.ts`, `core/messaging.test.ts`, `orchestrator/messaging.test.ts` |

## Steps

1. Contracts: schemas, mode, event, RPC.
2. Migration and store methods, with store tests.
3. Adapter mapping for `coordinate`, with tests.
4. Core messaging helpers, with tests.
5. MCP binding, host interface and tools, with server tests.
6. Orchestrator: parent on open, waiters, delivery on resume, host implementation, RPC handler, with an
   orchestrator-level test (fake engines: a child asks its parent, the parent waits, answers, the child unblocks;
   a queued message is delivered on resume).
7. Docs, then `pnpm typecheck && pnpm lint && pnpm test`.

## Acceptance

- Existing suites unchanged and green; no existing role sees new tools.
- A coder opened with a parent can `ask_lead`; the parent's `wait_for_reply` returns the question; its
  `send_message(kind: answer, reply_to)` unblocks the coder with the answer text.
- `send_message` to a non-adjacent attempt is refused with a message naming the lead.
- A message to an idle attempt is delivered as a prefixed block in its next resumed prompt, exactly once.
- `coordinate` on Claude yields `dontAsk`, only `mcp__legion` allowed, and the full denied list.
