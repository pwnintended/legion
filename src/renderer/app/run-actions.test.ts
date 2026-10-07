import type { Run } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { answerConfirm, confirmStore } from './confirm';
import { applyRunList, initialData } from './data';
import { archiveReportOf, archiveRunInteractively } from './run-actions';
import { dataStore } from './store';
import { connectStore, type EngineClient } from './sync';

const run = { id: 'run_a', title: 'Dark mode', status: 'pr_ready', createdAt: 1, updatedAt: 1 } as Run;
const calls: unknown[] = [];
let kept: unknown[] = [];
const client: EngineClient = {
  getState: () => ({ status: 'connecting', generation: 0 }),
  seq: 0,
  onStatus: () => () => {},
  onEvents: () => () => {},
  onReset: () => () => {},
  call: (async (method: string, input: { runId: string; force?: boolean }) => {
    if (method !== 'runs.archive') throw new RpcError('not_found', 'not in this test');
    calls.push({ method, input });
    // Like the engine: an active run is refused unless forced.
    if (!input.force) throw new RpcError('failed_precondition', 'run is pr_ready');
    return { ...run, status: 'cancelled', archived: true, archiveReport: { kept, problems: ['git gc failed'] } };
  }) as EngineClient['call'],
};
const sync = connectStore(client);
const quiet = console.error;
console.error = () => {};
afterAll(() => {
  console.error = quiet;
});
afterAll(() => sync.stop());
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  kept = [{ kind: 'branch', name: 'legion/dark/integration', reason: 'its pull request is not merged' }];
  dataStore.setState(applyRunList(initialData(), [{ run, taskCounts: {}, openInbox: 0, costUsd: 0 }], 0), true);
});

describe('archiving a run that is still active', () => {
  it('asks before cancelling it, and does nothing when declined', async () => {
    const result = archiveRunInteractively(run);
    await tick();
    const request = confirmStore.getState().request;
    expect(request?.confirmLabel).toBe('Cancel run and archive');
    expect(request?.body.join(' ')).toMatch(/cancels the run first/);
    expect(request?.body.join(' ')).toMatch(/uncommitted changes/);
    answerConfirm(false);
    await expect(result).resolves.toBe(false);
    expect(calls).toEqual([{ method: 'runs.archive', input: { runId: 'run_a' } }]);
    expect(dataStore.getState().runs.run_a?.status).toBe('pr_ready');
  });

  it('cancels and archives with force on confirm, then shows what was kept and what failed', async () => {
    const result = archiveRunInteractively(run);
    await tick();
    answerConfirm(true);
    await expect(result).resolves.toBe(true);
    expect(calls).toEqual([
      { method: 'runs.archive', input: { runId: 'run_a' } },
      { method: 'runs.archive', input: { runId: 'run_a', force: true } },
    ]);
    expect(dataStore.getState().runs.run_a).toMatchObject({ status: 'cancelled', archived: true });
    expect(dataStore.getState().runs.run_a).not.toHaveProperty('archiveReport');
    const report = confirmStore.getState().request;
    expect(report?.title).toBe('Archived “Dark mode”');
    expect(report?.cancelLabel).toBeNull();
    expect(report?.items).toEqual([
      'kept branch legion/dark/integration: its pull request is not merged',
      'problem: git gc failed',
    ]);
    answerConfirm(true);
  });

  it('reads the report defensively', () => {
    expect(archiveReportOf({ id: 'run_a' })).toEqual({ kept: [], problems: [] });
    expect(archiveReportOf({ archiveReport: { kept: [{ name: 1 }], problems: 'x' } })).toEqual({
      kept: [],
      problems: [],
    });
  });
});
