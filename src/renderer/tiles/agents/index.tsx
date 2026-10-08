/**
 * Agents tile: the run's attempts as a tree (architecture §7): an attempt sits under the attempt it reports
 * to (`parentAttemptId`), so the assistant is above the lead, coders and researchers under their spawner. Each
 * row shows role, task node, engine, status, how many times its session ran and how many messages still wait for
 * the agent; clicking opens the agent's session tile.
 */
import type { AgentMessage, Attempt } from '@shared/domain';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { attemptsOfRun, messagesOfRun } from '../../app/data';
import { useData } from '../../app/hooks';
import { dataStore } from '../../app/store';
import { Dot } from '../../chrome/ui';
import { displayEngine } from '../../layout/describe';
import type { TileProps } from '../../layout/types';
import { ApprovalsControl } from '../../overlays/Settings';
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
  session: 'session',
};

const STATUS_COLOR: Record<Attempt['status'], string> = {
  pending: 'var(--overlay0)',
  running: 'var(--blue)',
  succeeded: 'var(--green)',
  failed: 'var(--red)',
  interrupted: 'var(--peach)',
  cancelled: 'var(--overlay0)',
};

export interface AgentNode {
  /** The latest attempt of the agent (its status; clicking opens it). */
  attempt: Attempt;
  /** Attempts that ran this agent's engine session (fix rounds and resumes continue one conversation). */
  runs: number;
  nodeId: string | null;
  queued: number;
  children: AgentNode[];
}

/**
 * The run's agents as a tree (pure). Attempts of one engine session (same role, task and session id) are one
 * agent: a fix round or a resume continues the same conversation, it is not a new agent. Children of any of
 * its attempts hang under it.
 */
export function buildAgentTree(
  attempts: readonly Attempt[],
  messages: readonly Pick<AgentMessage, 'toAttemptId' | 'deliveredAt'>[],
  nodeIdOf: (taskId: string) => string | null,
): AgentNode[] {
  const queued = new Map<string, number>();
  for (const m of messages) {
    if (m.deliveredAt === null) queued.set(m.toAttemptId, (queued.get(m.toAttemptId) ?? 0) + 1);
  }
  const groups = new Map<string, AgentNode>();
  const groupOf = new Map<string, AgentNode>();
  const ordered = [...attempts].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const attempt of ordered) {
    const key = attempt.sessionId ? `${attempt.role}|${attempt.taskId ?? ''}|${attempt.sessionId}` : attempt.id;
    let node = groups.get(key);
    if (node) {
      node.attempt = attempt;
      node.runs += 1;
    } else {
      node = {
        attempt,
        runs: 1,
        nodeId: attempt.taskId ? nodeIdOf(attempt.taskId) : null,
        queued: 0,
        children: [],
      };
      groups.set(key, node);
    }
    node.queued += queued.get(attempt.id) ?? 0;
    groupOf.set(attempt.id, node);
  }
  // An agent's parent: that of its first attempt whose parent is another agent.
  const parentOf = new Map<AgentNode, AgentNode>();
  for (const attempt of ordered) {
    const node = groupOf.get(attempt.id) as AgentNode;
    const parent = attempt.parentAttemptId ? groupOf.get(attempt.parentAttemptId) : undefined;
    if (parent && parent !== node && !parentOf.has(node)) parentOf.set(node, parent);
  }
  const roots: AgentNode[] = [];
  for (const node of groups.values()) {
    const parent = parentOf.get(node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function agentTree(runId: string): AgentNode[] {
  const state = dataStore.getState();
  return buildAgentTree(
    attemptsOfRun(state.attempts, runId),
    messagesOfRun(state.messages, runId),
    (taskId) => state.tasks[taskId]?.nodeId ?? null,
  );
}

function Row({ node, depth, runId, tileId }: { node: AgentNode; depth: number; runId: string; tileId: string }) {
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
        {node.runs > 1 ? (
          <span
            className="ag-runs"
            title="Runs of the same session: fix rounds and resumes keep the agent's conversation"
          >
            {node.runs} runs
          </span>
        ) : null}
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
      <div className="ag-head">
        <span className="ag-head-label" id={`${tileId}-approvals`} title="Applies to every run">
          Permission prompts · all runs
        </span>
        <ApprovalsControl labelledBy={`${tileId}-approvals`} />
      </div>
      {roots.map((node) => (
        <Row key={node.attempt.id} node={node} depth={0} runId={runId} tileId={tileId} />
      ))}
    </div>
  );
}
