import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWorkspace, loadLayout, saveLayout } from './persist';
import { syncWithRun } from './sync';
import { allocateId, insertColumn, makeColumn, type Workspace } from './tree';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

function layout(): Workspace {
  const ws = syncWithRun(null, {
    runId: 'run_1',
    status: 'executing',
    nodes: [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
    ],
    tasks: [
      { id: 'task_1', nodeId: 'T1', status: 'running' },
      { id: 'task_2', nodeId: 'T2', status: 'blocked' },
    ],
    clarifyItemId: null,
  });
  const [id, next] = allocateId(ws, 'terminal');
  const tile = { id, kind: 'terminal' as const, params: { terminalId: 'term_1', cwd: '/repo', attemptId: null } };
  return insertColumn(next, makeColumn({ id: `col:${id}`, tiles: [{ ...tile, auto: false }] }), null);
}

/** Loosely typed stored JSON, for breaking it on purpose. */
type Raw = Record<string, unknown> & { strip: { columns: (Record<string, unknown> & { tiles: Raw[] })[] } };
const col = (r: Raw, i: number) => r.strip.columns[i] as Raw['strip']['columns'][number];
const tile = (r: Raw, c: number, i: number) => col(r, c).tiles[i] as Record<string, unknown>;

/** A stored layout with one edit applied to its JSON. */
function corrupt(edit: (raw: Raw) => void): unknown {
  const raw = JSON.parse(JSON.stringify(layout())) as Raw;
  edit(raw);
  return raw;
}

describe('persisted layouts', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a layout (the terminal tile keeps its terminal id)', () => {
    const ws = layout();
    expect(isWorkspace(JSON.parse(JSON.stringify(ws)), 'run_1')).toBe(true);
    saveLayout(ws);
    expect(loadLayout('run_1')).toEqual({ ...ws, maximized: null });
  });

  it.each([
    ['a column without `pinned` (older layout)', (r: Raw) => delete col(r, 0).pinned],
    ['no `nextId`', (r: Raw) => delete r.nextId],
    ['a user id at or above `nextId`', (r: Raw) => (r.nextId = 1)],
    ['an unknown column mode', (r: Raw) => (col(r, 0).mode = 'grid')],
    ['an unknown width', (r: Raw) => (col(r, 0).width = 'thin')],
    ['an `active` tile that is not in the column', (r: Raw) => (col(r, 0).active = 'nope')],
    ['duplicate tile ids', (r: Raw) => (tile(r, 1, 0).id = tile(r, 0, 0).id)],
    ['duplicate column ids', (r: Raw) => (col(r, 1).id = col(r, 0).id)],
    ['tile params of the wrong shape', (r: Raw) => (tile(r, 0, 0).params = { terminalId: 7 })],
    ['a tile without `auto`', (r: Raw) => delete tile(r, 1, 0).auto],
    ['focus on a tile that does not exist', (r: Raw) => (r.focus = { column: 'col:plan', tile: 'nope' })],
    ['an unknown tile kind', (r: Raw) => (tile(r, 1, 0).kind = 'browser')],
  ])('discards %s instead of letting it reach the layout ops', (_label, edit) => {
    const raw = corrupt(edit);
    expect(isWorkspace(raw, 'run_1')).toBe(false);
    localStorage.setItem('legion.layout.run_1', JSON.stringify(raw));
    expect(loadLayout('run_1')).toBeNull();
    // ...and drops it, so it isn't re-read on every launch.
    expect(localStorage.getItem('legion.layout.run_1')).toBeNull();
  });

  it('ignores layouts of another run and unparsable values', () => {
    expect(isWorkspace(layout(), 'run_2')).toBe(false);
    localStorage.setItem('legion.layout.run_1', '{nope');
    expect(loadLayout('run_1')).toBeNull();
  });
});
