import type { Attempt } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { buildAgentTree } from './index';

let clock = 0;
function attempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  clock += 1;
  return {
    id,
    runId: 'run_1',
    taskId: null,
    role: 'coder',
    engine: 'claude',
    model: null,
    effort: null,
    sessionId: null,
    parentAttemptId: null,
    status: 'succeeded',
    startedAt: clock,
    endedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    error: null,
    ...overrides,
  } as Attempt;
}

describe('buildAgentTree', () => {
  it('shows the runs of one engine session as one agent, under its lead', () => {
    const attempts = [
      attempt('lead', { role: 'lead', sessionId: 'sL', status: 'running' }),
      attempt('c1', { taskId: 't1', sessionId: 's1', parentAttemptId: 'lead' }),
      attempt('rev', { role: 'reviewer', taskId: 't1', sessionId: 'sR', parentAttemptId: 'lead' }),
      attempt('c2', { taskId: 't1', sessionId: 's1', parentAttemptId: 'lead', status: 'running' }),
    ];
    const tree = buildAgentTree(attempts, [{ toAttemptId: 'c1', deliveredAt: null }], () => 'T1');
    expect(tree).toHaveLength(1);
    const lead = tree[0];
    expect(lead?.children.map((n) => [n.attempt.id, n.attempt.role, n.runs, n.queued])).toEqual([
      ['c2', 'coder', 2, 1],
      ['rev', 'reviewer', 1, 0],
    ]);
  });

  it('keeps a resumed lead one agent and its children under it', () => {
    const attempts = [
      attempt('lead1', { role: 'lead', sessionId: 'sL', status: 'failed' }),
      attempt('c1', { taskId: 't1', sessionId: 's1', parentAttemptId: 'lead1' }),
      attempt('lead2', { role: 'lead', sessionId: 'sL', status: 'running' }),
      attempt('c2', { taskId: 't2', sessionId: 's2', parentAttemptId: 'lead2' }),
      attempt('fresh', { taskId: 't3' }),
    ];
    const tree = buildAgentTree(attempts, [], (taskId) => taskId.toUpperCase());
    expect(tree.map((n) => [n.attempt.id, n.runs])).toEqual([
      ['lead2', 2],
      ['fresh', 1],
    ]);
    expect(tree[0]?.children.map((n) => n.nodeId)).toEqual(['T1', 'T2']);
  });
});
