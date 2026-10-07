import type { TaskStatus } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { buildWaves, foldMap, type MapItem, type RouteNode, type RouteTask, routeCounts, stageWord } from './route';

const node = (id: string, dependsOn: string[] = []): RouteNode => ({ id, title: `Task ${id}`, dependsOn });
const task = (status: TaskStatus, fixRounds = 0): RouteTask => ({ id: `task_${status}`, status, fixRounds });
const keys = (items: MapItem[]) => items.map((i) => i.key);

/** T1 → (T2..T12 in parallel) → (T13..T15) → T16 → T17. */
function bigRun() {
  const nodes = [node('T1')];
  for (let i = 2; i <= 12; i++) nodes.push(node(`T${i}`, ['T1']));
  nodes.push(node('T13', ['T2']), node('T14', ['T3']), node('T15', ['T4']));
  nodes.push(node('T16', ['T13']), node('T17', ['T16']));
  const tasks = new Map<string, RouteTask>([
    ['T1', task('merged')],
    ['T2', task('merged')],
    ['T3', task('merged')],
    ['T4', task('running')],
    ['T5', task('reviewing')],
    ['T6', task('fixing', 1)],
    ['T7', task('failed')],
    ['T8', task('queued')],
  ]);
  return { nodes, tasks };
}

describe('buildWaves', () => {
  it('groups nodes by dependency depth, in plan order, with their phase', () => {
    const { nodes, tasks } = bigRun();
    const waves = buildWaves(nodes, tasks, new Set(['T9']));
    expect(waves.map((w) => [w.index, w.rows.length, w.phase])).toEqual([
      [1, 1, 'done'],
      [2, 11, 'active'],
      [3, 3, 'ahead'],
      [4, 1, 'ahead'],
      [5, 1, 'ahead'],
    ]);
    expect(waves[1]?.rows.map((r) => r.nodeId).slice(0, 3)).toEqual(['T2', 'T3', 'T4']);
    // A waiting node reads as waiting even before its task is live.
    expect(waves[1]?.rows.find((r) => r.nodeId === 'T9')?.state).toBe('waiting');
    expect(waves[1]?.rows.find((r) => r.nodeId === 'T7')?.state).toBe('failed');
  });

  it('marks the remaining critical path, never finished work', () => {
    const { nodes, tasks } = bigRun();
    const rows = buildWaves(nodes, tasks, new Set()).flatMap((w) => w.rows);
    const critical = rows.filter((r) => r.critical).map((r) => r.nodeId);
    expect(critical).toEqual(['T13', 'T16', 'T17']);
    expect(critical).not.toContain('T2');
  });

  it('puts tasks missing from the plan in a last wave of their own', () => {
    const waves = buildWaves([node('T1')], new Map([['T9', task('running')]]), new Set());
    expect(waves.at(-1)?.rows.map((r) => r.nodeId)).toEqual(['T9']);
  });
});

describe('foldMap', () => {
  const { nodes, tasks } = bigRun();
  const waves = buildWaves(nodes, tasks, new Set());

  it('keeps a single finished task as a row, folds merged rows of the open wave and the far waves', () => {
    const items = foldMap(waves, 'T6', new Set());
    expect(keys(items)).toEqual([
      'row:T1',
      'head:2',
      'merged:2',
      ...['T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12'].map((id) => `row:${id}`),
      'head:3',
      'row:T13',
      'row:T14',
      'row:T15',
      'row:T16',
      'row:T17',
    ]);
    // Rows ahead are dimmed, except the selected one.
    expect(items.find((i) => i.key === 'row:T13')).toMatchObject({ dim: true });
  });

  it('folds what does not fit the budget into one line, and opens it up to a selection further down', () => {
    const many = [node('T1'), ...Array.from({ length: 6 }, (_, i) => node(`A${i}`, ['T1']))];
    many.push(...Array.from({ length: 6 }, (_, i) => node(`B${i}`, [`A${i}`])));
    many.push(node('Z', ['B0']));
    const w = buildWaves(many, new Map([['T1', task('running')]]), new Set());
    expect(keys(foldMap(w, null, new Set())).at(-1)).toBe('later');
    expect(keys(foldMap(w, 'Z', new Set())).at(-1)).toBe('row:Z');
  });

  it('opens a folded merged line when asked, or when the selection is in it', () => {
    expect(keys(foldMap(waves, 'T2', new Set()))).toContain('row:T2');
    expect(keys(foldMap(waves, null, new Set(['merged:2'])))).toContain('row:T3');
  });

  it('folds a finished wave of several rows', () => {
    const done = buildWaves(
      [node('T1'), node('T2'), node('T3', ['T1'])],
      new Map([
        ['T1', task('merged')],
        ['T2', task('merged')],
        ['T3', task('running')],
      ]),
      new Set(),
    );
    expect(keys(foldMap(done, 'T3', new Set()))).toEqual(['fold:1', 'row:T3']);
  });
});

describe('words', () => {
  it('counts and names stages', () => {
    const { nodes, tasks } = bigRun();
    const waves = buildWaves(nodes, tasks, new Set(['T9']));
    expect(routeCounts(waves)).toEqual({ tasks: 17, working: 3, waiting: 1, failed: 1, done: 3 });
    const row = waves[1]?.rows.find((r) => r.nodeId === 'T6');
    expect(row && stageWord(row, 2)).toBe('fix 1/2');
  });
});
