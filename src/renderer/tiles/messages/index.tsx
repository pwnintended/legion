/**
 * Messages tile: every agent-to-agent message of the run (architecture §7), oldest first: who wrote to whom,
 * the kind, the body, and whether it reached the recipient's context yet.
 */
import type { AgentMessage, Attempt } from '@shared/domain';
import { useShallow } from 'zustand/react/shallow';
import { messagesOfRun } from '../../app/data';
import { useData } from '../../app/hooks';
import { dataStore } from '../../app/store';
import { Chip } from '../../chrome/ui';
import { formatClock, type Tone } from '../../layout/describe';
import type { TileProps } from '../../layout/types';
import { Markdown } from '../plan/kit';
import './messages.css';

const KIND_TONE: Record<AgentMessage['kind'], Tone> = {
  brief: 'accent',
  question: 'warn',
  answer: 'ok',
  report: 'run',
  status: 'idle',
};

function who(attempt: Attempt | undefined, id: string): string {
  if (!attempt) return id;
  const state = dataStore.getState();
  const nodeId = attempt.taskId ? state.tasks[attempt.taskId]?.nodeId : null;
  return nodeId ? `${attempt.role} of ${nodeId}` : attempt.role;
}

export default function MessagesTile({ runId, tileId }: TileProps<'messages'>) {
  const messages = useData(useShallow((s) => messagesOfRun(s.messages, runId)));
  const attempts = useData((s) => s.attempts);
  if (messages.length === 0) return <div className="mg-empty">No messages between agents yet.</div>;
  return (
    <div className="mg" data-messages-tile={tileId}>
      {messages.map((m) => (
        <div key={m.id} className="mg-item" data-kind={m.kind}>
          <div className="mg-head">
            <Chip tone={KIND_TONE[m.kind]}>{m.kind}</Chip>
            <span className="mg-who">{who(attempts[m.fromAttemptId], m.fromAttemptId)}</span>
            <span>→</span>
            <span className="mg-who">{who(attempts[m.toAttemptId], m.toAttemptId)}</span>
            <span>{formatClock(m.createdAt)}</span>
            <span>{m.deliveredAt === null ? 'queued' : 'delivered'}</span>
            {m.replyTo ? <span title={m.replyTo}>reply</span> : null}
          </div>
          <Markdown className="mg-body">{m.body}</Markdown>
        </div>
      ))}
    </div>
  );
}
