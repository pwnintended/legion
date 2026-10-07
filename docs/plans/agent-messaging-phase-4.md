# Agent messaging, phase 4: the assistant

The user-facing agent. It talks with the human and with other agents and nothing else: no file, shell or web
tools. It answers from what it knows, spawns research for facts, and turns a request into a run by handing a brief
to the planner; from then on it sits above the run's lead, relays the lead's questions to the human and the
human's decisions back, and reports progress.

## Model: a conversation is a run that may become an implementation

A new run status, `chatting`, precedes `draft`. `runs.chat({repoPath, baseRef, prompt, engine, model,
attachmentIds})` creates a run in `chatting` whose first message is the prompt, and opens its assistant. The human
keeps talking to the assistant through `sessions.send` on the assistant attempt (its process stays alive and idle
between turns, like the lead). `start_implementation({title, brief, clarify})` moves the run to `clarifying` or
`planning` with the brief as the issue text; the usual flow follows (clarify questions and plan sign-off in the
inbox, then the lead). The assistant stays for the run's life; the lead is its child.

Why a run and not a separate entity: every attempt, message, inbox item and event is run-scoped, and the UI
already knows how to show a run. A conversation that never starts an implementation is a run that stays
`chatting` until archived or cancelled.

## Mechanics

- Role `assistant` (coordinate, `COORDINATOR_ROLES`, research cap 3), engine = the run's planner engine,
  `settings.roles.assistant`, `settings.assistant.enabled`.
- Loop (`orchestrator/assistant.ts`): same shape as the lead loop. Wakes on queued messages (the lead's questions
  and reports, research reports) and on conversation changes (run status transitions, new inbox items that wait
  for the human). Resumes after a crash as a new attempt and re-parents its children; gives up after three
  failures (a `chatting` run then fails).
- Tools (role `assistant`): `start_implementation`, `run_status` (status, plan, board, what waits for the human),
  plus the coordinator tools (`list_agents`, `send_message`, `wait_for_reply`, `spawn_research`).
- The lead's parent is the assistant when there is one; the lead prompt then sends the human's decisions through
  the assistant (`send_message` kind `question` to its parent) rather than `request_human_input`.

## Out of scope

The composer and conversation tile (phase 5).
