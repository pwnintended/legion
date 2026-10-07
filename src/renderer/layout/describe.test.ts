import type { Attempt, Task } from '@shared/domain';
import type { ServerEvent } from '@shared/events';
import { describe, expect, it } from 'vitest';
import { applyEvents, type DataState, initialData } from '../app/data';
import { describeTile, tileDiffStatKey } from './describe';
import type { LayoutTile } from './tree';

const task = (id: string, nodeId: string, status: Task['status']) =>
  ({ id, runId: 'run_a', nodeId, status, fixRounds: 0, progress: null }) as Task;
const attempt = (id: string, taskId: string) =>
  ({ id, runId: 'run_a', taskId, role: 'coder', engine: 'claude', startedAt: 1, status: 'running' }) as Attempt;
const session = (taskId: string): LayoutTile => ({
  id: `session:${taskId}`,
  kind: 'session',
  params: { taskId, attemptId: null },
  auto: true,
});

let seq = 0;
const edit = (attemptId: string, added: number): ServerEvent => ({
  seq: ++seq,
  ts: seq,
  type: 'agent.event',
  runId: 'run_a',
  taskId: null,
  attemptId,
  event: { type: 'file_change', path: `f${seq}.ts`, added, removed: 1 },
});

function state(): DataState {
  return applyEvents(initialData(), [
    { seq: ++seq, ts: 1, type: 'task.updated', task: task('t1', 'T1', 'merged'), from: null },
    { seq: ++seq, ts: 1, type: 'task.updated', task: task('t2', 'T2', 'running'), from: null },
    { seq: ++seq, ts: 1, type: 'attempt.updated', attempt: attempt('a1', 't1'), from: null },
    { seq: ++seq, ts: 1, type: 'attempt.updated', attempt: attempt('a2', 't2'), from: null },
    edit('a1', 7),
  ]);
}

describe('tileDiffStatKey', () => {
  it("only changes for the tile whose meta shows it, so a running agent's edits don't re-render every tile", () => {
    const before = state();
    const after = applyEvents(before, [edit('a2', 3), edit('a2', 4)]);
    expect(after.diffstats).not.toBe(before.diffstats);
    // T2 is running: its header doesn't show diff stats, its key stays put.
    expect(tileDiffStatKey(after, session('t2'))).toBe(tileDiffStatKey(before, session('t2')));
    // T1 is merged: its note shows +/−, and the key follows it.
    expect(tileDiffStatKey(before, session('t1'))).toBe('7:1:1');
    expect(describeTile(before, 'run_a', session('t1')).note).toBe('merged · +7 −1');
    const more = applyEvents(after, [edit('a1', 2)]);
    expect(tileDiffStatKey(more, session('t1'))).toBe('9:2:2');
    expect(tileDiffStatKey(more, { id: 'pr', kind: 'pr', params: {}, auto: true })).toBe('');
  });
});
