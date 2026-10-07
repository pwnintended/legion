import type { TaskStatus } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { criticalPath, depths, topoOrder } from './dag';
import { type RunLayoutInput, syncWithRun } from './sync';
import {
  allocateId,
  type Column,
  collapse,
  focusTile,
  getColumn,
  insertColumn,
  makeColumn,
  moveDir,
  setWidthPreset,
  type Workspace,
} from './tree';

// Mockup DAG: T1 → T2, T3, T4; T5 ← T2, T3; T6 ← T4, T5.
const NODES = [
  { id: 'T1', dependsOn: [] },
  { id: 'T2', dependsOn: ['T1'] },
  { id: 'T3', dependsOn: ['T1'] },
  { id: 'T4', dependsOn: ['T1'] },
  { id: 'T5', dependsOn: ['T2', 'T3'] },
  { id: 'T6', dependsOn: ['T4', 'T5'] },
];

function input(statuses: Partial<Record<string, TaskStatus>>, extra: Partial<RunLayoutInput> = {}): RunLayoutInput {
  return {
    runId: 'run_1',
    status: 'executing',
    nodes: NODES,
    tasks: Object.entries(statuses).map(([nodeId, status]) => ({
      id: `task_${nodeId}`,
      nodeId,
      status: status as TaskStatus,
    })),
    clarifyItemId: null,
    hierarchy: false,
    ...extra,
  };
}

const keys = (w: Workspace) => w.strip.columns.map((c) => c.key);
const col = (w: Workspace, key: string) => w.strip.columns.find((c) => c.key === key) as Column;

describe('dag helpers', () => {
  it('orders topologically with lowest ids first', () => {
    expect(topoOrder(NODES)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    expect(
      topoOrder([
        { id: 'T10', dependsOn: [] },
        { id: 'T2', dependsOn: ['T10'] },
        { id: 'T3', dependsOn: [] },
      ]),
    ).toEqual(['T3', 'T10', 'T2']);
  });

  it('survives cycles and unknown deps', () => {
    expect(
      topoOrder([
        { id: 'T1', dependsOn: ['T2'] },
        { id: 'T2', dependsOn: ['T1'] },
        { id: 'T3', dependsOn: ['T9'] },
      ]),
    ).toEqual(['T3', 'T1', 'T2']);
  });

  it('computes depths and the critical path', () => {
    expect(Object.fromEntries(depths(NODES))).toEqual({ T1: 0, T2: 1, T3: 1, T4: 1, T5: 2, T6: 3 });
    expect(criticalPath(NODES)).toEqual(['T1', 'T2', 'T5', 'T6']);
    expect(criticalPath(NODES, (id) => (id === 'T1' ? 0 : 1))).toEqual(['T2', 'T5', 'T6']);
    expect(criticalPath([])).toEqual([]);
  });
});

describe('syncWithRun', () => {
  it('derives plan, tasks in topological order and the end column', () => {
    const w = syncWithRun(
      null,
      input({ T1: 'merged', T2: 'running', T3: 'running', T4: 'reviewing', T5: 'blocked', T6: 'blocked' }),
    );
    expect(keys(w)).toEqual(['plan', 'task:T1', 'task:T2', 'task:T3', 'task:T4', 'task:T5', 'task:T6', 'end']);
    expect(col(w, 'task:T1').collapsed).toBe(true);
    expect(col(w, 'task:T2').collapsed).toBe(false);
    expect(col(w, 'task:T5').collapsed).toBe(true);
    expect(col(w, 'task:T4').tiles.map((t) => t.kind)).toEqual(['session', 'review']);
    expect(col(w, 'end').tiles.map((t) => t.kind)).toEqual(['integration']);
    expect(col(w, 'end').collapsed).toBe(true);
    // Initial focus goes to the first running task.
    expect(w.focus).toEqual({ column: 'col:task:T2', tile: 'session:T2' });
  });

  it('shows plan (+ clarify) and the DAG before execution', () => {
    let w = syncWithRun(null, input({}, { status: 'clarifying', nodes: [], clarifyItemId: 'inb_1' }));
    expect(keys(w)).toEqual(['plan']);
    expect(col(w, 'plan').tiles.map((t) => t.kind)).toEqual(['clarify', 'plan']);
    w = syncWithRun(w, input({}, { status: 'awaiting_approval' }));
    expect(keys(w)).toEqual(['plan', 'dag']);
    expect(col(w, 'plan').tiles.map((t) => t.kind)).toEqual(['plan']);
    expect(col(w, 'dag').collapsed).toBe(false);
    expect(w.focus?.column).toBe('col:plan');
  });

  it('inserts a new task column right after its first dependency', () => {
    let w = syncWithRun(null, input({ T1: 'running' }));
    expect(keys(w)).toEqual(['plan', 'task:T1', 'end']);
    w = syncWithRun(w, input({ T1: 'merged', T3: 'queued' }));
    expect(keys(w)).toEqual(['plan', 'task:T1', 'task:T3', 'end']);
    // T2 comes before T3 in topo order, both after T1.
    w = syncWithRun(w, input({ T1: 'merged', T2: 'queued', T3: 'queued' }));
    expect(keys(w)).toEqual(['plan', 'task:T1', 'task:T2', 'task:T3', 'end']);
    w = syncWithRun(w, input({ T1: 'merged', T2: 'queued', T3: 'queued', T4: 'queued' }));
    expect(keys(w)).toEqual(['plan', 'task:T1', 'task:T2', 'task:T3', 'task:T4', 'end']);
  });

  it('keeps the user ordering, widths and collapses', () => {
    const statuses = { T1: 'merged', T2: 'running', T3: 'running' } as const;
    let w = syncWithRun(null, input(statuses));
    w = focusTile(w, 'session:T3');
    w = moveDir(w, 'h'); // T3 before T2
    w = setWidthPreset(w, 'col:task:T3', '2/3');
    w = collapse(w, 'col:task:T2');
    w = setWidthPreset(w, 'col:task:T1', '1/2'); // expands a merged task by hand
    const after = syncWithRun(w, input({ ...statuses, T4: 'queued' }));
    expect(keys(after)).toEqual(['plan', 'task:T1', 'task:T3', 'task:T2', 'task:T4', 'end']);
    expect(getColumn(after, 'col:task:T3')?.width).toBe('2/3');
    expect(getColumn(after, 'col:task:T2')?.collapsed).toBe(true);
    expect(getColumn(after, 'col:task:T1')?.collapsed).toBe(false);
    expect(after.focus).toEqual(w.focus);
  });

  it('auto-collapses finished tasks and expands started ones unless pinned', () => {
    let w = syncWithRun(null, input({ T1: 'running', T2: 'blocked' }));
    expect(col(w, 'task:T2').collapsed).toBe(true);
    w = syncWithRun(w, input({ T1: 'merged', T2: 'running' }));
    expect(col(w, 'task:T1').collapsed).toBe(true);
    expect(col(w, 'task:T2').collapsed).toBe(false);
  });

  it('stacks the review tile under the session while reviewing and removes it after', () => {
    let w = syncWithRun(null, input({ T1: 'running' }));
    w = syncWithRun(w, input({ T1: 'reviewing' }));
    expect(col(w, 'task:T1').tiles.map((t) => t.id)).toEqual(['session:T1', 'review:T1']);
    w = focusTile(w, 'review:T1');
    w = syncWithRun(w, input({ T1: 'approved' }));
    expect(col(w, 'task:T1').tiles.map((t) => t.id)).toEqual(['session:T1']);
    expect(w.focus).toEqual({ column: 'col:task:T1', tile: 'session:T1' });
  });

  it('adds the PR tile at the end and expands the end column after execution', () => {
    let w = syncWithRun(null, input({ T1: 'merged' }));
    w = syncWithRun(w, input({ T1: 'merged' }, { status: 'pr_ready' }));
    expect(col(w, 'end').tiles.map((t) => t.kind)).toEqual(['integration', 'pr']);
    expect(col(w, 'end').collapsed).toBe(false);
  });

  it('never removes user columns or user tiles', () => {
    let w = syncWithRun(null, input({ T1: 'running', T2: 'queued' }));
    const [id, withId] = allocateId(w, 'term');
    w = insertColumn(
      withId,
      makeColumn({
        id: `col:${id}`,
        tiles: [{ id, kind: 'terminal', params: { terminalId: null, cwd: '/r', attemptId: null }, auto: false }],
      }),
      'col:task:T1',
    );
    // The plan drops T2: its auto column disappears, the user column stays where it was.
    w = syncWithRun(w, input({ T1: 'running' }, { nodes: NODES.slice(0, 1) }));
    expect(keys(w)).toEqual(['plan', 'task:T1', null, 'end']);
  });

  it('moves focus to a neighbour when the focused column disappears', () => {
    let w = syncWithRun(null, input({ T1: 'running', T2: 'running' }));
    w = focusTile(w, 'session:T2');
    w = syncWithRun(w, input({ T1: 'running' }, { nodes: NODES.slice(0, 1) }));
    expect(w.focus?.column).toBe('col:end');
  });

  it('returns the same reference when nothing changed', () => {
    const i = input({ T1: 'merged', T2: 'running' });
    const w = syncWithRun(null, i);
    expect(syncWithRun(w, i)).toBe(w);
    expect(syncWithRun(w, { ...i, tasks: [...i.tasks] })).toBe(w);
  });

  it('starts over for a different run', () => {
    const w = syncWithRun(null, input({ T1: 'running' }));
    const other = syncWithRun(w, { ...input({}), runId: 'run_2', status: 'planning', nodes: [] });
    expect(other.runId).toBe('run_2');
    expect(keys(other)).toEqual(['plan']);
  });
});

describe('initial focus', () => {
  const merged = { T1: 'merged', T2: 'merged', T3: 'merged', T4: 'merged', T5: 'merged', T6: 'merged' } as const;

  it('lands on a failed task before running ones', () => {
    const ws = syncWithRun(null, input({ T1: 'merged', T2: 'running', T3: 'failed' }));
    expect(ws.focus?.tile).toBe('session:T3');
  });

  it('lands a finished run on its PR, active in its column', () => {
    for (const status of ['pr_ready', 'done'] as const) {
      const ws = syncWithRun(null, input(merged, { status }));
      expect(ws.focus?.tile).toBe('pr');
      expect(col(ws, 'end').active).toBe('pr');
    }
  });
});

describe('conversation and agents columns', () => {
  it('leaves the conversation to the chat view and adds the agents column with a hierarchy', () => {
    const ws = syncWithRun(null, input({}, { status: 'chatting', nodes: [], hierarchy: true }));
    expect(ws.strip.columns.map((c) => c.key)).toEqual(['plan', 'agents']);
    const agents = ws.strip.columns[1];
    expect(agents?.tiles.map((t) => t.kind)).toEqual(['agents', 'messages']);
    expect(agents?.collapsed).toBe(true);
  });

  it('keeps the agents column open while executing and leaves runs without coordinators alone', () => {
    const executing = syncWithRun(null, input({ T1: 'running' }, { hierarchy: true }));
    expect(executing.strip.columns.find((c) => c.key === 'agents')?.collapsed).toBe(false);
    const plain = syncWithRun(null, input({ T1: 'running' }));
    expect(plain.strip.columns.map((c) => c.key)).not.toContain('agents');
    expect(plain.strip.columns.map((c) => c.key)).not.toContain('assistant');
  });
});
