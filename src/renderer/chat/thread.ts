/**
 * The run's conversation as one ordered thread (pure, unit-tested). It folds together:
 * - the human's messages and the assistant's replies, from the assistant attempts' transcripts (`user_message`
 *   events are the human's; Legion's own wakes are never recorded as one);
 * - messages agents sent the assistant (lead status updates, reports, questions): folded under the reply they
 *   led to as its provenance, or shown as a quiet update when the assistant chose to say nothing;
 * - decisions (inbox items), open as cards, answered as one-line receipts;
 * - what agents presented (`present`);
 * - a few run events (PR opened, run stopped or failed; task merges when no assistant narrates the run).
 * A run without an assistant (planner-first, or the assistant switched off) still gets a thread: its request,
 * its decisions, its presentations and its events.
 */
import type { AttachmentRef } from '@shared/attachments';
import type { AgentMessage, Attempt, InboxItem, Merge, Presentation, Run, Task, TaskNode } from '@shared/domain';
import type { TranscriptEntry } from '@shared/rpc';

export interface PendingMessage {
  id: number;
  text: string;
  attachments: readonly AttachmentRef[];
  status: 'sending' | 'sent' | 'error';
  error: string | null;
  ts: number;
}

export type ThreadItem =
  | {
      kind: 'human';
      key: string;
      ts: number;
      text: string;
      attachments: readonly AttachmentRef[];
      pending: PendingMessage | null;
    }
  | {
      kind: 'assistant';
      key: string;
      ts: number;
      text: string;
      streaming: boolean;
      /** Messages from agents this reply was written from (newest last). */
      sources: readonly AgentMessage[];
      /** The previous item is the same turn's text: render without a new header. */
      continued: boolean;
    }
  /** A message to the assistant it said nothing about (only once its turn is over). */
  | { kind: 'update'; key: string; ts: number; message: AgentMessage }
  | { kind: 'decision'; key: string; ts: number; item: InboxItem }
  | { kind: 'presentation'; key: string; ts: number; presentation: Presentation }
  | { kind: 'event'; key: string; ts: number; tone: 'ok' | 'bad' | 'muted'; text: string; href: string | null }
  | { kind: 'error'; key: string; ts: number; text: string };

export interface ThreadInput {
  run: Run;
  attempts: readonly Attempt[];
  /** Transcript entries per attempt id (only the assistant attempts are read). */
  transcripts: Readonly<Record<string, readonly TranscriptEntry[] | undefined>>;
  messages: readonly AgentMessage[];
  inbox: readonly InboxItem[];
  presentations: readonly Presentation[];
  tasks: readonly Task[];
  nodes: readonly TaskNode[];
  merges: readonly Merge[];
  /** Messages the human sent that the transcript may not show yet (optimistic). */
  pending?: readonly PendingMessage[];
}

/** Kinds an agent sends the assistant that the human hears about through it. */
const RELAYED_KINDS = new Set<AgentMessage['kind']>(['status', 'report', 'question']);

/** How long after sending an optimistic message waits for its recorded twin before it shows on its own. */
const PENDING_MATCH_MS = 60_000;

export function assistantAttempts(attempts: readonly Attempt[]): Attempt[] {
  return attempts.filter((a) => a.role === 'assistant').sort((a, b) => a.startedAt - b.startedAt);
}

/** The assistant attempt a message from the human goes to: the live one, else the latest. */
export function liveAssistant(attempts: readonly Attempt[]): Attempt | null {
  const list = assistantAttempts(attempts);
  return list.find((a) => a.status === 'running') ?? list.at(-1) ?? null;
}

/** The assistant is mid-turn (its transcript has not reached a turn end since its last input). */
export function assistantBusy(entries: readonly TranscriptEntry[] | undefined, attempt: Attempt | null): boolean {
  if (attempt?.status !== 'running' || !entries || entries.length === 0) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const type = (entries[i] as TranscriptEntry).event.type;
    if (type === 'turn_complete' || type === 'exited') return false;
    if (type === 'user_message' || type === 'text_delta' || type === 'message' || type === 'tool_call') return true;
    if (type === 'session_started' || type === 'activity' || type === 'reasoning' || type === 'tool_result')
      return true;
  }
  return false;
}

/** `turn`: the assistant turn a transcript item belongs to (attempt id + count). */
type Draft = ThreadItem & { order: number; turn?: string };

/**
 * Fold one assistant transcript into human / assistant / error items. Streamed deltas build an item that the
 * final `message` then replaces (the most recent unfinished one, as in the session timeline): a tool call between
 * them ends the paragraph for further deltas but not its wait for the final text.
 */
function foldTranscript(attempt: Attempt, entries: readonly TranscriptEntry[], out: Draft[], order: () => number) {
  type Text = Draft & { kind: 'assistant' };
  let current: Text | null = null;
  let open: Text[] = [];
  let turns = 0;
  const endTurn = () => {
    for (const item of open) item.streaming = false;
    open = [];
    current = null;
    turns += 1;
  };
  const text = (seq: number, ts: number, value: string, streaming: boolean): Text => ({
    kind: 'assistant',
    key: `as:${attempt.id}:${seq}`,
    ts,
    text: value,
    streaming,
    sources: [],
    continued: false,
    order: order(),
    turn: `${attempt.id}:${turns}`,
  });
  for (const { seq, ts, event } of entries) {
    switch (event.type) {
      case 'user_message':
        endTurn();
        out.push({
          kind: 'human',
          key: `you:${attempt.id}:${seq}`,
          ts,
          text: event.text,
          attachments: event.attachments,
          pending: null,
          order: order(),
        });
        break;
      case 'text_delta':
        if (current) current.text += event.text;
        else {
          const item = text(seq, ts, event.text, true);
          current = item;
          open.push(item);
          out.push(item);
        }
        break;
      case 'message': {
        const item = open.pop();
        if (item) {
          item.text = event.text;
          item.streaming = false;
          if (item === current) current = null;
        } else if (event.text.trim()) out.push(text(seq, ts, event.text, false));
        break;
      }
      case 'tool_call':
        current = null;
        break;
      case 'turn_complete':
        endTurn();
        if (event.isError && event.reason !== 'interrupted') {
          out.push({
            kind: 'error',
            key: `err:${attempt.id}:${seq}`,
            ts,
            text: event.reason && event.reason !== 'error' ? event.reason : 'The assistant hit an error on that turn.',
            order: order(),
          });
        }
        break;
      default:
        break;
    }
  }
}

function nodeTitle(nodes: readonly TaskNode[], tasks: readonly Task[], taskId: string): string {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return 'A task';
  const node = nodes.find((n) => n.id === task.nodeId);
  return node ? `${task.nodeId} · ${node.title}` : task.nodeId;
}

export function buildThread(input: ThreadInput): ThreadItem[] {
  let counter = 0;
  const order = () => counter++;
  const items: Draft[] = [];
  const assistants = assistantAttempts(input.attempts);
  const assistantIds = new Set(assistants.map((a) => a.id));

  for (const attempt of assistants) {
    const entries = input.transcripts[attempt.id];
    if (entries) foldTranscript(attempt, entries, items, order);
  }

  // Planner-first runs (and runs whose assistant never opened): the request is the human's first message.
  if (assistants.length === 0) {
    items.push({
      kind: 'human',
      key: `you:${input.run.id}:request`,
      ts: input.run.createdAt,
      text: input.run.issueText,
      attachments: input.run.attachments ?? [],
      pending: null,
      order: order(),
    });
  }

  // Optimistic messages the transcript doesn't show yet.
  const recorded = items.filter((i): i is Draft & { kind: 'human' } => i.kind === 'human');
  for (const message of input.pending ?? []) {
    const twin = recorded.find((r) => r.text === message.text && Math.abs(r.ts - message.ts) < PENDING_MATCH_MS);
    if (twin && message.status !== 'error') continue;
    items.push({
      kind: 'human',
      key: `pending:${message.id}`,
      ts: message.ts,
      text: message.text,
      attachments: message.attachments,
      pending: message,
      order: order(),
    });
  }

  for (const item of input.inbox) {
    items.push({ kind: 'decision', key: `inbox:${item.id}`, ts: item.createdAt, item, order: order() });
  }
  for (const presentation of input.presentations) {
    items.push({
      kind: 'presentation',
      key: `presentation:${presentation.id}`,
      ts: presentation.createdAt,
      presentation,
      order: order(),
    });
  }

  // Run events. Merges only narrate runs nobody else narrates.
  if (assistants.length === 0) {
    for (const merge of input.merges) {
      if (merge.status !== 'merged' || merge.endedAt === null) continue;
      items.push({
        kind: 'event',
        key: `merge:${merge.id}`,
        ts: merge.endedAt,
        tone: 'ok',
        text: `${nodeTitle(input.nodes, input.tasks, merge.taskId)} merged`,
        href: null,
        order: order(),
      });
    }
  }
  const pr = input.run.pr ?? null;
  if (pr) {
    const opened = input.inbox.find((i) => i.kind === 'pr_ready' && i.resolvedAt !== null)?.resolvedAt;
    items.push({
      kind: 'event',
      key: `pr:${pr.number}`,
      ts: opened ?? input.run.updatedAt,
      tone: 'ok',
      text: `Draft pull request #${pr.number} opened`,
      href: pr.url,
      order: order(),
    });
  }
  if (input.run.status === 'failed' || input.run.status === 'cancelled') {
    items.push({
      kind: 'event',
      key: `end:${input.run.status}`,
      ts: input.run.updatedAt,
      tone: input.run.status === 'failed' ? 'bad' : 'muted',
      text:
        input.run.status === 'failed'
          ? `The run failed${input.run.error ? `: ${input.run.error}` : ''}`
          : 'The run was stopped',
      href: null,
      order: order(),
    });
  }

  items.sort((a, b) => a.ts - b.ts || a.order - b.order);

  // Agents' messages to the assistant: under the first reply that followed them, else (once the assistant is
  // done with them) on their own.
  const relayed = input.messages.filter((m) => assistantIds.has(m.toAttemptId) && RELAYED_KINDS.has(m.kind));
  const live = liveAssistant(input.attempts);
  const busy = assistantBusy(live ? input.transcripts[live.id] : undefined, live);
  for (const message of relayed) {
    const at = message.deliveredAt ?? message.createdAt;
    const reply = items.find((i): i is Draft & { kind: 'assistant' } => i.kind === 'assistant' && i.ts >= at);
    if (reply) {
      reply.sources = [...reply.sources, message];
      continue;
    }
    if (message.deliveredAt === null || busy) continue;
    items.push({ kind: 'update', key: `update:${message.id}`, ts: at, message, order: order() });
  }
  items.sort((a, b) => a.ts - b.ts || a.order - b.order);

  let previous: Draft | null = null;
  for (const item of items) {
    if (item.kind === 'assistant') item.continued = previous?.kind === 'assistant' && previous.turn === item.turn;
    previous = item;
  }
  return items.map(({ order: _order, turn: _turn, ...item }) => item as ThreadItem);
}

/** Open decisions of the thread, oldest first. */
export function openDecisionItems(thread: readonly ThreadItem[]): Extract<ThreadItem, { kind: 'decision' }>[] {
  return thread.filter(
    (i): i is Extract<ThreadItem, { kind: 'decision' }> => i.kind === 'decision' && i.item.resolvedAt === null,
  );
}
