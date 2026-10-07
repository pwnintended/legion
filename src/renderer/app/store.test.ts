import type { Run } from '@shared/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../layout/tree';
import { applyEvents, applyRunList, applyRunRow, applySnapshot, initialData } from './data';
import { createDemoWorld, snapshotOf } from './demo/fixtures';
import { actions, dataStore, initialUi, syncActiveLayout, uiStore } from './store';

const RUN = 'run_authv2demo01';

function loadDemoRun(): void {
  const world = createDemoWorld(1_000_000_000);
  const snapshot = snapshotOf(world, RUN, 100);
  if (!snapshot) throw new Error('fixture run missing');
  let state = applyRunList(initialData(), [{ run: snapshot.run, taskCounts: {}, openInbox: 0, costUsd: 0 }], 100);
  state = applySnapshot(state, snapshot);
  dataStore.setState(state, true);
}

describe('syncActiveLayout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    uiStore.setState(initialUi(), true);
    dataStore.setState(initialData(), true);
  });

  it('rebuilds a layout the ops cannot handle instead of throwing on the data path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    uiStore.setState({ activeRunId: RUN });
    loadDemoRun();
    const good = uiStore.getState().layouts[RUN];
    expect(good?.strip.columns.length).toBeGreaterThan(0);

    // An older/corrupt layout: columns without `pinned` made syncWithRun throw on every data event.
    const broken = JSON.parse(JSON.stringify(good)) as Workspace;
    for (const column of broken.strip.columns) delete (column as Partial<typeof column>).pinned;
    uiStore.setState({ layouts: { [RUN]: broken } });

    expect(() => syncActiveLayout()).not.toThrow();
    const rebuilt = uiStore.getState().layouts[RUN];
    expect(rebuilt?.strip.columns.every((c) => c.pinned !== undefined)).toBe(true);

    // Data events keep flowing to subscribers.
    const seen: number[] = [];
    const off = dataStore.subscribe((s) => seen.push(s.seq));
    dataStore.setState({ seq: 101 });
    off();
    expect(seen).toEqual([101]);
  });
});

describe('activating a just-created run', () => {
  afterEach(() => {
    uiStore.setState(initialUi(), true);
    dataStore.setState(initialData(), true);
  });

  const created = { ...(createDemoWorld(1_000_000_000).runs[0] as Run), id: 'run_new', status: 'clarifying' as const };

  it('stays on the new run when another data event lands before its run.updated', () => {
    loadDemoRun();
    actions.setActiveRun(RUN);
    // What the composer does with the `runs.create` result.
    dataStore.setState((s) => applyRunRow(s, created, s.seq), true);
    actions.setActiveRun(created.id);
    dataStore.setState({ seq: 150 });
    expect(uiStore.getState().activeRunId).toBe('run_new');
    // Its run.updated arrives later and applies on top.
    dataStore.setState(
      (s) =>
        applyEvents(s, [{ seq: 151, ts: 1, type: 'run.updated', run: { ...created, status: 'planning' }, from: null }]),
      true,
    );
    expect(dataStore.getState().runs.run_new?.status).toBe('planning');
  });

  it('(without adopting the row first, the run would be replaced by the first run of the list)', () => {
    loadDemoRun();
    actions.setActiveRun(created.id);
    dataStore.setState({ seq: 150 });
    expect(uiStore.getState().activeRunId).toBe(RUN);
  });
});
