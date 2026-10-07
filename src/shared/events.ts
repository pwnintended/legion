/**
 * Event streams.
 *
 * - `AgentEvent`: what every engine adapter emits, normalized (architecture §6). Adapters map Claude
 *   stream-json / Codex app-server notifications onto these; nothing engine-specific leaks past them.
 * - `ServerEvent`: what the engine pushes to the renderer. Every ServerEvent is a row in the append-only
 *   `events` table, so `seq` is global and monotonic and the renderer can resume with
 *   `subscribe({sinceSeq})` after a reload. Entity events carry the full updated row, so applying them
 *   is idempotent: a client keeps an entity unless the event's seq is newer than what it has.
 */
import { z } from 'zod';
import {
  AgentMessageSchema,
  AttemptSchema,
  AttemptStatusSchema,
  EngineKindSchema,
  InboxItemSchema,
  MergeSchema,
  PlanSchema,
  ProjectSchema,
  ReviewSchema,
  RunSchema,
  RunStatusSchema,
  SettingsSchema,
  TaskSchema,
  TaskStatusSchema,
  TimestampSchema,
  VerificationSchema,
} from './domain';
import { IdSchema } from './ids';

// ---------------------------------------------------------------------------------------------
// AgentEvent
// ---------------------------------------------------------------------------------------------

export const ToolKindSchema = z.enum(['read', 'edit', 'command', 'mcp', 'other']);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const TodoItemSchema = z.object({
  text: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_started'),
    sessionId: z.string(),
    model: z.string().nullable(),
    version: z.string().nullable(),
  }),
  /** Streaming assistant text. Adapters should coalesce deltas (~50 ms) before emitting. */
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  /** Final assistant text of one message. */
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  /**
   * What the model is producing before it shows up as an event of its own: thinking, the final structured
   * output, or a tool call's input. Emitted when the block starts and then every few thousand characters, so
   * a long silent stretch (a big plan being written) reads as progress, not a hang.
   */
  z.object({
    type: z.literal('activity'),
    activity: z.enum(['thinking', 'output', 'tool_input']),
    /** The tool whose input is being written (`tool_input`). */
    tool: z.string().nullable(),
    /** Characters streamed for this block so far. */
    chars: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    kind: ToolKindSchema,
  }),
  z.object({
    type: z.literal('tool_result'),
    id: z.string(),
    ok: z.boolean(),
    output: z.string().nullable(),
  }),
  z.object({
    type: z.literal('file_change'),
    path: z.string(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('todo'), items: z.array(TodoItemSchema) }),
  z.object({
    type: z.literal('approval_request'),
    requestId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    reason: z.string().nullable(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** Cumulative for the session when the engine reports it (Claude); null otherwise. */
    costUsd: z.number().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal('rate_limit'),
    engine: EngineKindSchema,
    /** e.g. "5h", "weekly", or the engine's own limit id. */
    window: z.string(),
    usedPct: z.number(),
    resetsAt: TimestampSchema.nullable(),
  }),
  z.object({
    type: z.literal('turn_complete'),
    /** Parsed structured output when the session was started with `outputSchema` (not yet zod-validated). */
    structuredOutput: z.unknown().nullable(),
    isError: z.boolean(),
    reason: z.string().nullable(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), retryable: z.boolean() }),
  /** Always the last event of a session's stream. */
  z.object({ type: z.literal('exited'), code: z.number().int().nullable() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

// ---------------------------------------------------------------------------------------------
// ServerEvent
// ---------------------------------------------------------------------------------------------

export const ServerEventBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.updated'), run: RunSchema, from: RunStatusSchema.nullable() }),
  z.object({ type: z.literal('plan.updated'), plan: PlanSchema }),
  z.object({ type: z.literal('task.updated'), task: TaskSchema, from: TaskStatusSchema.nullable() }),
  z.object({
    type: z.literal('attempt.updated'),
    attempt: AttemptSchema,
    from: AttemptStatusSchema.nullable(),
  }),
  z.object({ type: z.literal('review.created'), review: ReviewSchema }),
  z.object({ type: z.literal('inbox.updated'), item: InboxItemSchema }),
  z.object({ type: z.literal('verification.created'), verification: VerificationSchema }),
  z.object({ type: z.literal('merge.updated'), merge: MergeSchema }),
  /** A message between two attempts was queued or delivered (`deliveredAt` set). */
  z.object({ type: z.literal('message.updated'), message: AgentMessageSchema }),
  z.object({
    type: z.literal('agent.event'),
    runId: IdSchema,
    taskId: IdSchema.nullable(),
    attemptId: IdSchema,
    event: AgentEventSchema,
  }),
  z.object({ type: z.literal('settings.updated'), settings: SettingsSchema }),
  /** A project was added, opened, renamed or pinned; `removed` = it left the list (the checkout is untouched). */
  z.object({ type: z.literal('project.updated'), project: ProjectSchema, removed: z.boolean() }),
]);
export type ServerEventBody = z.infer<typeof ServerEventBodySchema>;
export type ServerEventType = ServerEventBody['type'];

export const ServerEventEnvelopeSchema = z.object({
  seq: z.number().int().positive(),
  ts: TimestampSchema,
});

export const ServerEventSchema = ServerEventBodySchema.and(ServerEventEnvelopeSchema);
export type ServerEvent = ServerEventBody & z.infer<typeof ServerEventEnvelopeSchema>;
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

/** Run/task/attempt references for a body, used to index the event log. */
export function eventRefs(body: ServerEventBody): {
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
} {
  switch (body.type) {
    case 'run.updated':
      return { runId: body.run.id, taskId: null, attemptId: null };
    case 'plan.updated':
      return { runId: body.plan.runId, taskId: null, attemptId: null };
    case 'task.updated':
      return { runId: body.task.runId, taskId: body.task.id, attemptId: null };
    case 'attempt.updated':
      return { runId: body.attempt.runId, taskId: body.attempt.taskId, attemptId: body.attempt.id };
    case 'review.created':
      return { runId: body.review.runId, taskId: body.review.taskId, attemptId: body.review.attemptId };
    case 'inbox.updated':
      return { runId: body.item.runId, taskId: body.item.taskId, attemptId: body.item.attemptId };
    case 'verification.created':
      return {
        runId: body.verification.runId,
        taskId: body.verification.taskId,
        attemptId: body.verification.attemptId,
      };
    case 'merge.updated':
      return { runId: body.merge.runId, taskId: body.merge.taskId, attemptId: null };
    case 'message.updated':
      return { runId: body.message.runId, taskId: null, attemptId: null };
    case 'agent.event':
      return { runId: body.runId, taskId: body.taskId, attemptId: body.attemptId };
    case 'settings.updated':
    case 'project.updated':
      return { runId: null, taskId: null, attemptId: null };
  }
}
