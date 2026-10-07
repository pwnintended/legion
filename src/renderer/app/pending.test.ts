import type { Task } from '@shared/domain';
import type { ProcedureName } from '@shared/rpc';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvePlan, requestRevision } from '../tiles/plan/actions';
import { approveMerge } from '../tiles/review/index';
import { pendingResolution, trackResolution } from '../tiles/session/actions';
import { applyEvents, applyRunList, applySnapshot, initialData } from './data';
import { createDemoWorld, snapshotOf } from './demo/fixtures';
import { itemResolved, singleFlight, whenData } from './pending';
import { dataStore } from './store';
import { connectStore, type EngineClient } from './sync';

/** Records calls; every call resolves (the confirming event is what the tests deliver by hand). */
const calls: string[] = [];
const client: EngineClient = {
  getState: () => ({ status: 'connecting', generation: 0 }),
  seq: 0,
  onStatus: () => () => {},
  onEvents: () => () => {},
  onReset: () => () => {},
  call: (async (method: ProcedureName) => {
    calls.push(method);
    return {};
  }) as EngineClient['call'],
};
const sync = connectStore(client);
afterAll(() => sync.stop());

const tick = () => new Promise((r) => setTimeout(r, 0));
const RUN = 'run_i18nextract1';

function loadRun(): void {
  const world = createDemoWorld(1_000_000_000);
  const snapshot = snapshotOf(world, RUN, 100);
  if (!snapshot) throw new Error('fixture run missing');
  let state = applyRunList(initialData(), [{ run: snapshot.run, taskCounts: {}, openInbox: 0, costUsd: 0 }], 100);
  state = applySnapshot(state, snapshot);
  dataStore.setState(state, true);
}

beforeEach(() => {
  calls.length = 0;
  loadRun();
});

describe('whenData / singleFlight', () => {
  it('resolves when the store confirms, or false after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const confirmed = whenData((s) => s.seq >= 101, 1000);
      dataStore.setState({ seq: 101 });
      await expect(confirmed).resolves.toBe(true);
      const late = whenData((s) => s.seq >= 999, 1000);
      vi.advanceTimersByTime(1000);
      await expect(late).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops calls while one is in flight', async () => {
    const once = singleFlight();
    let runs = 0;
    const first = once(async () => {
      runs++;
      await tick();
    });
    await expect(once(async () => void runs++)).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    await expect(once(async () => void runs++)).resolves.toBe(true);
    expect(runs).toBe(2);
  });
});

describe('actions stay pending until the engine confirms them', () => {
  it('an inbox resolution: a second press after the RPC returned is ignored until inbox.updated', async () => {
    const item = Object.values(dataStore.getState().inbox).find((i) => i.resolvedAt === null);
    if (!item) throw new Error('fixture item missing');
    let sent = 0;
    const resolve = () => trackResolution(item.id, 'accept', async () => void sent++);
    const first = resolve();
    await tick();
    // The RPC has returned, the event has not arrived: still pending, a held key does nothing.
    expect(pendingResolution(item.id)).toMatchObject({ state: 'pending' });
    await resolve();
    expect(sent).toBe(1);
    dataStore.setState((s) => ({ inbox: { ...s.inbox, [item.id]: { ...item, resolvedAt: 5 } } }));
    await first;
    expect(pendingResolution(item.id)).toBeUndefined();
    expect(itemResolved(item.id)(dataStore.getState())).toBe(true);
  });

  it('plan approval and revision requests', async () => {
    const first = approvePlan(RUN);
    await tick();
    expect(await approvePlan(RUN)).toBe(false);
    await requestRevision(RUN, 'smaller tasks please');
    expect(calls.filter((c) => c.startsWith('runs.'))).toEqual(['runs.approvePlan']);
    // run.updated: the run leaves sign-off.
    const run = dataStore.getState().runs[RUN];
    if (!run) throw new Error('fixture run missing');
    dataStore.setState((s) => ({ runs: { ...s.runs, [RUN]: { ...run, status: 'executing' } } }));
    await expect(first).resolves.toBe(true);
  });

  it('approve & merge from a review', async () => {
    const task = {
      id: 'task_x',
      runId: RUN,
      nodeId: 'T9',
      status: 'awaiting_human',
    } as Task;
    dataStore.setState((s) => applyEvents(s, [{ seq: 500, ts: 1, type: 'task.updated', task, from: null }]));
    const first = approveMerge(task.id);
    await tick();
    await approveMerge(task.id);
    expect(calls).toEqual(['tasks.approveMerge']);
    dataStore.setState((s) =>
      applyEvents(s, [{ seq: 501, ts: 2, type: 'task.updated', task: { ...task, status: 'merging' }, from: null }]),
    );
    await first;
    await approveMerge(task.id);
    expect(calls).toEqual(['tasks.approveMerge', 'tasks.approveMerge']);
  });
});
