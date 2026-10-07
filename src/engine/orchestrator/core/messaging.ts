/**
 * Agent-to-agent messaging rules (pure). Attempts form a tree through `parentAttemptId`; a message may only
 * travel along one edge of that tree, parent ↔ child. Queued messages are rendered into the recipient's next
 * prompt as one block, so the agent sees who said what and can reply by id.
 */
import type { AgentMessage, Attempt, MessageKind } from '@shared/domain';

export type MessagePeer = Pick<Attempt, 'id' | 'runId' | 'role' | 'taskId' | 'status'> & {
  parentAttemptId?: string | null | undefined;
};

export type MessageEdge = 'parent' | 'child';

/** Which way `to` sits from `from`, or null when they are not adjacent in the hierarchy. */
export function messageEdge(from: MessagePeer, to: MessagePeer): MessageEdge | null {
  if (from.id === to.id || from.runId !== to.runId) return null;
  if (to.parentAttemptId === from.id) return 'child';
  if (from.parentAttemptId === to.id) return 'parent';
  return null;
}

export const canMessage = (from: MessagePeer, to: MessagePeer): boolean => messageEdge(from, to) !== null;

/** Why a send was refused, worded for the agent that tried. */
export function messageRefusal(from: MessagePeer, to: MessagePeer | null): string {
  if (!to || to.runId !== from.runId) return `unknown agent; call list_agents to see who you can message`;
  if (to.id === from.id) return 'you cannot message yourself';
  return from.parentAttemptId
    ? `${to.id} is not your lead or one of your agents: ask your lead (${from.parentAttemptId}) to relay it`
    : `${to.id} is not one of your agents; you can only message your own agents (see list_agents)`;
}

export interface MessageLine {
  readonly id: string;
  readonly from: string;
  readonly kind: MessageKind;
  readonly replyTo: string | null;
  readonly body: string;
}

export const KIND_LABEL: { readonly [K in MessageKind]: string } = {
  brief: 'Brief',
  question: 'Question',
  answer: 'Answer',
  report: 'Report',
  status: 'Status',
};

/** A peer as the agent names it: role plus task node, e.g. `coder of T3` or `lead`. */
export function peerLabel(peer: Pick<Attempt, 'id' | 'role'>, nodeId: string | null): string {
  return nodeId ? `${peer.role} of ${nodeId} (${peer.id})` : `${peer.role} (${peer.id})`;
}

/**
 * Render messages for a prompt. Empty input → null (nothing to prepend). Each message carries its id so the
 * recipient can answer it with `send_message(reply_to)`.
 */
export function renderMessages(messages: readonly MessageLine[]): string | null {
  if (messages.length === 0) return null;
  const blocks = messages.map((m) => {
    const head = `### ${KIND_LABEL[m.kind]} from ${m.from} · id ${m.id}${m.replyTo ? ` · replies to ${m.replyTo}` : ''}`;
    return `${head}\n\n${m.body.trim()}`;
  });
  return [
    `## Messages from other agents (${messages.length})`,
    'These arrived while you were not running. Act on them as part of your work; answer a question with `send_message` (kind `answer`, `reply_to` = its id).',
    ...blocks,
  ].join('\n\n');
}

/** Line form of a stored message, labelling the sender. */
export function messageLine(message: AgentMessage, from: string): MessageLine {
  return { id: message.id, from, kind: message.kind, replyTo: message.replyTo, body: message.body };
}
