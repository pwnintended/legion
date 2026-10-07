import type { AgentMessage } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import {
  canMessage,
  type MessagePeer,
  messageEdge,
  messageLine,
  messageRefusal,
  peerLabel,
  renderMessages,
} from './messaging';

const peer = (id: string, parentAttemptId: string | null, runId = 'run_1'): MessagePeer => ({
  id,
  runId,
  role: 'coder',
  taskId: null,
  status: 'running',
  parentAttemptId,
});

const lead = peer('att_lead', null);
const a = peer('att_a', 'att_lead');
const b = peer('att_b', 'att_lead');
const grandchild = peer('att_g', 'att_a');

describe('messageEdge / canMessage', () => {
  it('allows parent ↔ child only', () => {
    expect(messageEdge(lead, a)).toBe('child');
    expect(messageEdge(a, lead)).toBe('parent');
    expect(canMessage(a, b)).toBe(false); // siblings
    expect(canMessage(lead, grandchild)).toBe(false); // skip level
    expect(canMessage(grandchild, lead)).toBe(false);
    expect(canMessage(a, a)).toBe(false);
  });

  it('never crosses runs', () => {
    const foreignChild = peer('att_x', 'att_lead', 'run_2');
    expect(canMessage(lead, foreignChild)).toBe(false);
  });

  it('explains a refusal in terms the agent can act on', () => {
    expect(messageRefusal(a, b)).toContain('ask your lead (att_lead)');
    expect(messageRefusal(lead, grandchild)).toContain('not one of your agents');
    expect(messageRefusal(a, null)).toContain('list_agents');
    expect(messageRefusal(a, a)).toBe('you cannot message yourself');
  });
});

describe('renderMessages', () => {
  const message = (over: Partial<AgentMessage>): AgentMessage => ({
    id: 'msg_1',
    runId: 'run_1',
    fromAttemptId: 'att_lead',
    toAttemptId: 'att_a',
    kind: 'brief',
    body: 'Do the thing.',
    replyTo: null,
    createdAt: 1,
    deliveredAt: null,
    ...over,
  });

  it('is null for nothing and one block per message otherwise, naming ids to reply to', () => {
    expect(renderMessages([])).toBeNull();
    const text = renderMessages([
      messageLine(message({}), 'planner (att_lead)'),
      messageLine(
        message({ id: 'msg_2', kind: 'answer', replyTo: 'msg_0', body: '  sqlite \n' }),
        'planner (att_lead)',
      ),
    ]);
    expect(text).toContain('## Messages from other agents (2)');
    expect(text).toContain('### Brief from planner (att_lead) · id msg_1\n\nDo the thing.');
    expect(text).toContain('### Answer from planner (att_lead) · id msg_2 · replies to msg_0\n\nsqlite');
    expect(text).toContain('`send_message`');
  });

  it('labels peers by role and task node', () => {
    expect(peerLabel({ id: 'att_1', role: 'coder' }, 'T3')).toBe('coder of T3 (att_1)');
    expect(peerLabel({ id: 'att_2', role: 'planner' }, null)).toBe('planner (att_2)');
  });
});
