import { DEFAULT_SETTINGS, type TaskNode, type TaskStatus } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { planDispatch, previewEscalation, type SchedulerInput, type SchedulerTask } from './scheduler';
import { makeNode } from './testing';

const settings = { concurrency: DEFAULT_SETTINGS.concurrency, roles: DEFAULT_SETTINGS.roles };
const onCodex = (concurrency = DEFAULT_SETTINGS.concurrency) => ({
  concurrency,
  roles: { ...DEFAULT_SETTINGS.roles, coder: { ...DEFAULT_SETTINGS.roles.coder, engine: 'codex' as const } },
});

function input(
  nodes: TaskNode[],
  statuses: Record<string, TaskStatus> = {},
  extra: Partial<SchedulerInput> = {},
): SchedulerInput {
  const tasks: SchedulerTask[] = nodes.map((n) => ({ nodeId: n.id, status: statuses[n.id] ?? 'blocked' }));
  return { nodes, tasks, settings, paused: false, now: 1_000, ...extra };
}

// T1 → T2 → T4, T1 → T3, T5 independent (L), T6 independent (S, high risk).
const nodes = [
  makeNode('T1'),
  makeNode('T2', ['T1']),
  makeNode('T3', ['T1']),
  makeNode('T4', ['T2']),
  makeNode('T5', [], { size: 'L' }),
  makeNode('T6', [], { size: 'S', risk: 'high' }),
  makeNode('T7', [], { size: 'S' }),
];

describe('planDispatch: readiness and priority', () => {
  it('enqueues roots and dispatches by longest remaining path, fan-out, risk, id', () => {
    const plan = planDispatch(input(nodes));
    expect(plan.enqueue).toEqual(['T1', 'T5', 'T6', 'T7']);
    // T1: 2+2+2 = 6, T5: 4, T6: 1 (high risk), T7: 1.
    expect(plan.dispatch.map((d) => d.nodeId)).toEqual(['T1', 'T5', 'T6']);
    expect(plan.waiting).toEqual([{ nodeId: 'T7', engine: 'claude', reason: 'global_cap', until: null }]);
    expect(plan.inFlight).toEqual({ total: 3, byEngine: { claude: 3, codex: 0, fake: 0 } });
    expect(plan.run).toEqual({ state: 'active' });
  });

  it('breaks remaining-path ties by fan-out', () => {
    const tie = [
      makeNode('T1'),
      makeNode('T2'),
      makeNode('T3', ['T2']),
      makeNode('T4', ['T2']),
      makeNode('T5', ['T1']),
    ];
    const plan = planDispatch(
      input(tie, {}, { settings: { ...settings, concurrency: { ...settings.concurrency, global: 1 } } }),
    );
    expect(plan.dispatch.map((d) => d.nodeId)).toEqual(['T2']);
  });

  it('requires dependencies to be merged (or skipped), not just approved', () => {
    const approved = planDispatch(input(nodes, { T1: 'approved', T5: 'merged', T6: 'merged', T7: 'merged' }));
    expect(approved.enqueue).toEqual([]);
    expect(approved.dispatch).toEqual([]);
    const merged = planDispatch(input(nodes, { T1: 'merged', T5: 'merged', T6: 'merged', T7: 'skipped' }));
    expect(merged.enqueue).toEqual(['T2', 'T3']);
    expect(merged.dispatch.map((d) => d.nodeId)).toEqual(['T2', 'T3']);
    const skipped = planDispatch(
      input(nodes, { T1: 'skipped', T2: 'skipped', T5: 'merged', T6: 'merged', T7: 'merged' }),
    );
    expect(skipped.enqueue).toEqual(['T3', 'T4']);
  });

  it('moves queued tasks with unsatisfied deps back to blocked', () => {
    const plan = planDispatch(input(nodes, { T2: 'queued' }));
    expect(plan.block).toEqual(['T2']);
    expect(plan.dispatch.map((d) => d.nodeId)).not.toContain('T2');
  });

  it('dispatches already queued tasks on the coder role engine', () => {
    const tasks: SchedulerTask[] = [{ nodeId: 'T1', status: 'queued' }];
    const plan = planDispatch({ ...input([makeNode('T1')], {}, { settings: onCodex() }), tasks });
    expect(plan.enqueue).toEqual([]);
    expect(plan.dispatch).toEqual([{ nodeId: 'T1', engine: 'codex' }]);
  });
});

describe('planDispatch: capacity', () => {
  it('counts slots held by this run and by other runs', () => {
    const plan = planDispatch(
      input(nodes, { T1: 'running', T5: 'reviewing', T6: 'merging' }, { otherRunsInFlight: { codex: 0, claude: 0 } }),
    );
    expect(plan.inFlight.total).toBe(3);
    expect(plan.dispatch.map((d) => d.nodeId)).toEqual(['T7']);
    const busy = planDispatch(input(nodes, { T1: 'running' }, { otherRunsInFlight: { codex: 2 } }));
    expect(busy.dispatch).toEqual([]);
    expect(busy.waiting.map((w) => w.reason)).toEqual(['global_cap', 'global_cap', 'global_cap']);
  });

  it('applies the per-engine cap of the coder engine', () => {
    const three = [makeNode('T1', [], { size: 'L' }), makeNode('T2', [], { size: 'M' }), makeNode('T3')];
    const capped = { ...settings, concurrency: { global: 3, perEngine: { claude: 1, codex: 3, fake: 0 } } };
    const plan = planDispatch(input(three, {}, { settings: capped }));
    expect(plan.dispatch).toEqual([{ nodeId: 'T1', engine: 'claude' }]);
    expect(plan.waiting.map((w) => [w.nodeId, w.engine, w.reason])).toEqual([
      ['T2', 'claude', 'engine_cap'],
      ['T3', 'claude', 'engine_cap'],
    ]);
    const onCodexToo = planDispatch(input(three, {}, { settings: onCodex(capped.concurrency) }));
    expect(onCodexToo.dispatch.map((d) => d.engine)).toEqual(['codex', 'codex', 'codex']);
  });

  it('waits for the rate-limit reset of the coder engine and reports when to wake up', () => {
    const plan = planDispatch(
      input(
        [makeNode('T1')],
        {},
        {
          rateLimits: [
            { engine: 'claude', resetsAt: 5_000 },
            { engine: 'codex', resetsAt: 500 },
          ],
        },
      ),
    );
    expect(plan.dispatch).toEqual([]);
    expect(plan.waiting).toEqual([{ nodeId: 'T1', engine: 'claude', reason: 'rate_limited', until: 5_000 }]);
    expect(plan.nextWakeAt).toBe(5_000);

    const allLimited = planDispatch(
      input([makeNode('T1')], {}, { rateLimits: [{ engine: 'claude', resetsAt: null }] }),
    );
    expect(allLimited.run).toEqual({ state: 'waiting', reason: 'rate_limited', until: null });
  });

  it('dispatches nothing while paused', () => {
    const plan = planDispatch(input(nodes, {}, { paused: true }));
    expect(plan.enqueue).toEqual(['T1', 'T5', 'T6', 'T7']);
    expect(plan.dispatch).toEqual([]);
    expect(new Set(plan.waiting.map((w) => w.reason))).toEqual(new Set(['paused']));
    expect(plan.run).toEqual({ state: 'waiting', reason: 'paused', until: null });
  });
});

describe('planDispatch: failures and completion', () => {
  it('reports nodes blocked by a failed ancestor and needs a human when nothing else can move', () => {
    const plan = planDispatch(input(nodes, { T1: 'failed', T5: 'merged', T6: 'awaiting_human', T7: 'merged' }));
    expect(plan.blockedByFailure).toEqual([
      { nodeId: 'T2', causes: ['T1'] },
      { nodeId: 'T3', causes: ['T1'] },
      { nodeId: 'T4', causes: ['T1'] },
    ]);
    expect(plan.run).toEqual({
      state: 'needs_human',
      awaitingHuman: ['T6'],
      failed: ['T1'],
      cancelled: [],
      blockedByFailure: ['T2', 'T3', 'T4'],
    });
  });

  it('keeps going while unrelated work is active', () => {
    const plan = planDispatch(input(nodes, { T1: 'failed', T5: 'running', T6: 'merged', T7: 'merged' }));
    expect(plan.run).toEqual({ state: 'active' });
  });

  it('is complete when every task is terminal', () => {
    const statuses = Object.fromEntries(nodes.map((n) => [n.id, 'merged' as TaskStatus]));
    expect(planDispatch(input(nodes, { ...statuses, T4: 'skipped', T7: 'cancelled' })).run).toEqual({
      state: 'complete',
      merged: ['T1', 'T2', 'T3', 'T5', 'T6'],
      skipped: ['T4'],
      cancelled: ['T7'],
    });
  });

  it('previews what retrying or skipping a failed node unblocks', () => {
    const state = input(nodes, { T1: 'failed', T5: 'merged', T6: 'merged', T7: 'merged' });
    expect(previewEscalation(state, 'T1', 'retry')).toEqual({ unblocked: ['T2', 'T3', 'T4'], newlyReady: [] });
    expect(previewEscalation(state, 'T1', 'skip')).toEqual({ unblocked: ['T2', 'T3', 'T4'], newlyReady: ['T2', 'T3'] });
  });
});
