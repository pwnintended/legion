/**
 * Agents tile: the run's attempts as a tree (architecture §7): an attempt sits under the attempt it reports
 * to (`parentAttemptId`), so the assistant is above the lead, coders and researchers under their spawner. Each
 * row shows role, task node, engine, status and how many messages still wait for the agent; clicking opens the
 * agent's session tile.
 */
import type { Attempt } from '@shared/domain';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { attemptsOfRun, messagesOfRun } from '../../app/data';
import { useData } from '../../app/hooks';
import { dataStore } from '../../app/store';
import { Dot } from '../../chrome/ui';
import { displayEngine } from '../../layout/describe';
import type { TileProps } from '../../layout/types';
import { openTile } from '../plan/kit';
import './agents.css';

const ROLE_WORD: Record<Attempt['role'], string> = {
  assistant: 'assistant',
  lead: 'lead',
  planner: 'planner',
  coder: 'coder',
  reviewer: 'reviewer',
  resolver: 'resolver',
  finalizer: 'final review',
  researcher: 'researcher',
  research_lead: 'research lead',
};

const STATUS_COLOR: Record<Attempt['status'], string> = {
  pending: 'var(--overlay0)',
  running: 'var(--blue)',
  succeeded: 'var(--green)',
  failed: 'var(--red)',
  interrupted: 'var(--peach)',
  cancelled: 'var(--overlay0)',
};

interface Node {
  attempt: Attempt;
  nodeId: string | null;
  queued: number;
  children: Node[];
}

export function agentTree(runId: string): Node[] {
  const state = dataStore.getState();
  const attempts = attemptsOfRun(state.attempts, runId);
  const queued = new Map<string, number>();
  for (const m of messagesOfRun(state.messages, runId)) {
    if (m.deliveredAt === null) queued.set(m.toAttemptId, (queued.get(m.toAttemptId) ?? 0) + 1);
  }
  const byId = new Map<string, Node>();
  for (const attempt of attempts) {
    byId.set(attempt.id, {
      attempt,
      nodeId: attempt.taskId ? (state.tasks[attempt.taskId]?.nodeId ?? null) : null,
      queued: queued.get(attempt.id) ?? 0,
      children: [],
    });
  }
  const roots: Node[] = [];
  for (const node of byId.values()) {
    const parent = node.attempt.parentAttemptId ? byId.get(node.attempt.parentAttemptId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function Row({ node, depth, runId, tileId }: { node: Node; depth: number; runId: string; tileId: string }) {
  const { attempt } = node;
  const engine = displayEngine(dataStore.getState(), attempt);
  return (
    <>
      <button
        type="button"
        className="ag-row"
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => openTile(runId, 'session', { attemptId: attempt.id, taskId: null }, { besideTileId: tileId })}
        title={`${attempt.id} · ${engine} · ${attempt.status}`}
      >
        <Dot color={STATUS_COLOR[attempt.status]} live={attempt.status === 'running'} />
        <span className="ag-role">{ROLE_WORD[attempt.role]}</span>
        {node.nodeId ? <span className="ag-node">{node.nodeId}</span> : null}
        <span className="ag-node" style={{ color: engine === 'codex' ? 'var(--teal)' : 'var(--mauve)' }}>
          {engine}
        </span>
        {node.queued > 0 ? <span className="ag-queued">{node.queued} queued</span> : null}
        <span className="ag-status">{attempt.status}</span>
      </button>
      {node.children.map((child) => (
        <Row key={child.attempt.id} node={child} depth={depth + 1} runId={runId} tileId={tileId} />
      ))}
    </>
  );
}

export default function AgentsTile({ runId, tileId }: TileProps<'agents'>) {
  const deps = useData(useShallow((s) => [s.attempts, s.messages, s.tasks]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the store slices the tree reads.
  const roots = useMemo(() => agentTree(runId), [runId, deps]);
  if (roots.length === 0) return <div className="ag-empty">No agents yet.</div>;
  return (
    <div className="ag" data-agents-tile={tileId}>
      {roots.map((node) => (
        <Row key={node.attempt.id} node={node} depth={0} runId={runId} tileId={tileId} />
      ))}
    </div>
  );
}
