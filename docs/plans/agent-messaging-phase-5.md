# Agent messaging, phase 5: the UI

What the human sees of the hierarchy, and how they talk to the assistant.

- **Composer → assistant.** With `settings.assistant.enabled` the composer's prompt starts a conversation
  (`runs.chat`); a "Plan directly" switch keeps the old path (`runs.create`) for people who want the planner at once.
- **Conversation column.** A run with an assistant gets a first column with the assistant's session tile: the
  transcript is the conversation, the steer bar is the reply box. Focus lands there for `chatting` runs.
- **Agents tile** (`tiles/agents`): the attempt tree (assistant → lead → coders, researchers under their spawner)
  with role, task node, engine, status and the number of messages still queued for each agent; a click opens that
  agent's session tile.
- **Messages tile** (`tiles/messages`): every message of the run, oldest first: who → whom, kind, body, delivered or
  queued. Both tiles share one column, added when the run has a lead or an assistant.
- **Data**: `RunSnapshot.messages`, `message.updated` in the renderer reducer, `messagesOfRun` selector.
- **Settings**: switches for the assistant and the implementation lead in the Runs section.
