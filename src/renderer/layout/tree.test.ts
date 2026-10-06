import { describe, expect, it } from 'vitest';
import {
  type Column,
  collapse,
  cycleColumnMode,
  cycleWidth,
  effectiveWidth,
  emptyWorkspace,
  expand,
  focusDir,
  focusTile,
  getColumn,
  insertAfter,
  insertColumn,
  type LayoutTile,
  makeColumn,
  maximize,
  moveDir,
  normalize,
  remove,
  setWidthPreset,
  toggleCollapsed,
  toggleStacked,
  toggleTabbed,
  type Workspace,
} from './tree';

const t = (id: string): LayoutTile => ({
  id,
  kind: 'terminal',
  params: { terminalId: null, cwd: null, attemptId: null },
  auto: false,
});
const col = (id: string, ...tiles: string[]): Column => makeColumn({ id, tiles: tiles.map(t) });

function ws(...columns: Column[]): Workspace {
  let w = emptyWorkspace('run_1');
  for (const c of columns) w = insertColumn(w, c, w.strip.columns.at(-1)?.id ?? null);
  return w;
}

const ids = (w: Workspace) => w.strip.columns.map((c) => c.id);

describe('construction', () => {
  it('insertColumn appends after a column, at the start for null, at the end for unknown ids', () => {
    let w = ws(col('a', 'a1'), col('b', 'b1'));
    w = insertColumn(w, col('c', 'c1'), 'a');
    expect(ids(w)).toEqual(['a', 'c', 'b']);
    w = insertColumn(w, col('d', 'd1'), null);
    expect(ids(w)).toEqual(['d', 'a', 'c', 'b']);
    w = insertColumn(w, col('e', 'e1'), 'nope');
    expect(ids(w)).toEqual(['d', 'a', 'c', 'b', 'e']);
    expect(() => insertColumn(w, col('a', 'x'), null)).toThrow(/duplicate/);
  });

  it('the first inserted column receives focus; focus=true moves it', () => {
    let w = ws(col('a', 'a1'));
    expect(w.focus).toEqual({ column: 'a', tile: 'a1' });
    w = insertColumn(w, col('b', 'b1'), 'a');
    expect(w.focus?.column).toBe('a');
    w = insertColumn(w, col('c', 'c1'), 'a', true);
    expect(w.focus).toEqual({ column: 'c', tile: 'c1' });
  });

  it('insertAfter puts a tile below another in the same column', () => {
    let w = ws(col('a', 'a1', 'a2'));
    w = insertAfter(w, 'a1', t('x'), true);
    expect(getColumn(w, 'a')?.tiles.map((x) => x.id)).toEqual(['a1', 'x', 'a2']);
    expect(w.focus).toEqual({ column: 'a', tile: 'x' });
    expect(insertAfter(w, 'missing', t('y'))).toBe(w);
  });

  it('makeColumn requires a tile', () => {
    expect(() => makeColumn({ id: 'x', tiles: [] })).toThrow();
  });
});

describe('remove', () => {
  it('removes a tile and moves focus to its neighbour in the column', () => {
    let w = ws(col('a', 'a1', 'a2', 'a3'));
    w = focusTile(w, 'a2');
    w = remove(w, 'a2');
    expect(getColumn(w, 'a')?.tiles.map((x) => x.id)).toEqual(['a1', 'a3']);
    expect(w.focus).toEqual({ column: 'a', tile: 'a3' });
  });

  it('removes an emptied column and focuses the column to its left', () => {
    let w = ws(col('a', 'a1'), col('b', 'b1'), col('c', 'c1'));
    w = focusTile(w, 'b1');
    w = remove(w, 'b1');
    expect(ids(w)).toEqual(['a', 'c']);
    expect(w.focus).toEqual({ column: 'a', tile: 'a1' });
  });

  it('clears focus and maximized when the last column goes', () => {
    let w = maximize(ws(col('a', 'a1')));
    expect(w.maximized).toBe('a');
    w = remove(w, 'a1');
    expect(w.focus).toBeNull();
    expect(w.maximized).toBeNull();
  });

  it('is a no-op for unknown tiles', () => {
    const w = ws(col('a', 'a1'));
    expect(remove(w, 'zz')).toBe(w);
  });
});

describe('focusDir', () => {
  const base = ws(col('a', 'a1'), col('b', 'b1', 'b2', 'b3'), col('c', 'c1'));

  it('moves between columns with h/l and clamps at the edges', () => {
    let w = focusDir(base, 'l');
    expect(w.focus).toEqual({ column: 'b', tile: 'b1' });
    w = focusDir(focusDir(w, 'l'), 'l');
    expect(w.focus?.column).toBe('c');
    expect(focusDir(base, 'h')).toBe(base);
  });

  it('moves within a column with j/k', () => {
    let w = focusDir(base, 'l');
    w = focusDir(w, 'j');
    expect(w.focus?.tile).toBe('b2');
    w = focusDir(focusDir(w, 'j'), 'j');
    expect(w.focus?.tile).toBe('b3');
    w = focusDir(w, 'k');
    expect(w.focus?.tile).toBe('b2');
    expect(getColumn(w, 'b')?.active).toBe('b2');
  });

  it('returns to the active tile of a column', () => {
    let w = focusTile(base, 'b3');
    w = focusDir(w, 'l');
    w = focusDir(w, 'h');
    expect(w.focus).toEqual({ column: 'b', tile: 'b3' });
  });

  it('focuses the first column when nothing is focused', () => {
    const w = focusDir({ ...base, focus: null }, 'j');
    expect(w.focus?.column).toBe('a');
  });
});

describe('moveDir', () => {
  it('moves the focused column with h/l', () => {
    let w = focusTile(ws(col('a', 'a1'), col('b', 'b1'), col('c', 'c1')), 'a1');
    w = moveDir(w, 'l');
    expect(ids(w)).toEqual(['b', 'a', 'c']);
    w = moveDir(moveDir(w, 'l'), 'l');
    expect(ids(w)).toEqual(['b', 'c', 'a']);
    expect(w.focus?.column).toBe('a');
    w = moveDir(w, 'h');
    expect(ids(w)).toEqual(['b', 'a', 'c']);
  });

  it('moves the focused tile within its column with j/k', () => {
    let w = focusTile(ws(col('a', 'a1', 'a2', 'a3')), 'a1');
    w = moveDir(w, 'j');
    expect(getColumn(w, 'a')?.tiles.map((x) => x.id)).toEqual(['a2', 'a1', 'a3']);
    expect(moveDir(focusTile(w, 'a2'), 'k').strip).toEqual(focusTile(w, 'a2').strip);
  });
});

describe('widths, collapse and modes', () => {
  it('setWidthPreset pins the width; thin collapses but keeps the width', () => {
    let w = ws(col('a', 'a1'));
    w = setWidthPreset(w, 'a', '2/3');
    let c = getColumn(w, 'a') as Column;
    expect(effectiveWidth(c)).toBe('2/3');
    expect(c.pinned.width).toBe(true);
    w = setWidthPreset(w, 'a', 'thin');
    c = getColumn(w, 'a') as Column;
    expect(effectiveWidth(c)).toBe('thin');
    expect(c.width).toBe('2/3');
  });

  it('cycleWidth steps through presets and collapses below 1/3', () => {
    let w = ws(makeColumn({ id: 'a', width: '1/3', tiles: [t('a1')] }));
    w = cycleWidth(w, 'a', 1);
    expect(getColumn(w, 'a')?.width).toBe('1/2');
    w = cycleWidth(cycleWidth(cycleWidth(w, 'a', 1), 'a', 1), 'a', 1);
    expect(getColumn(w, 'a')?.width).toBe('full');
    w = setWidthPreset(w, 'a', '1/3');
    w = cycleWidth(w, 'a', -1);
    expect(getColumn(w, 'a')?.collapsed).toBe(true);
    expect(cycleWidth(w, 'a', -1)).toBe(w);
    w = cycleWidth(w, 'a', 1);
    expect(effectiveWidth(getColumn(w, 'a') as Column)).toBe('1/3');
  });

  it('collapse/expand/toggleCollapsed pin the collapsed state', () => {
    let w = ws(col('a', 'a1'));
    w = collapse(w, 'a');
    expect(getColumn(w, 'a')).toMatchObject({ collapsed: true, pinned: { collapsed: true } });
    w = expand(w, 'a');
    expect(getColumn(w, 'a')?.collapsed).toBe(false);
    w = toggleCollapsed(w, 'a');
    expect(getColumn(w, 'a')?.collapsed).toBe(true);
  });

  it('toggles stacked/tabbed and cycles modes', () => {
    let w = ws(col('a', 'a1', 'a2'));
    w = toggleStacked(w, 'a');
    expect(getColumn(w, 'a')?.mode).toBe('stacked');
    w = toggleStacked(w, 'a');
    expect(getColumn(w, 'a')?.mode).toBe('split');
    w = toggleTabbed(w, 'a');
    expect(getColumn(w, 'a')?.mode).toBe('tabbed');
    w = cycleColumnMode(w, 'a');
    expect(getColumn(w, 'a')?.mode).toBe('stacked');
    w = cycleColumnMode(w, 'a');
    expect(getColumn(w, 'a')?.mode).toBe('split');
    expect(getColumn(w, 'a')?.pinned.mode).toBe(true);
  });

  it('maximize toggles the focused column', () => {
    let w = focusTile(ws(col('a', 'a1'), col('b', 'b1')), 'b1');
    w = maximize(w);
    expect(w.maximized).toBe('b');
    w = maximize(w);
    expect(w.maximized).toBeNull();
  });
});

describe('normalize', () => {
  it('repairs dangling focus', () => {
    const w = ws(col('a', 'a1', 'a2'), col('b', 'b1'));
    expect(normalize({ ...w, focus: { column: 'a', tile: 'gone' } }).focus).toEqual({ column: 'a', tile: 'a1' });
    expect(normalize({ ...w, focus: { column: 'gone', tile: 'x' } }, 1).focus).toEqual({ column: 'b', tile: 'b1' });
    expect(normalize(w)).toBe(w);
  });

  it('ops are immutable', () => {
    const w = ws(col('a', 'a1'), col('b', 'b1'));
    const snapshot = JSON.stringify(w);
    moveDir(focusDir(w, 'l'), 'h');
    cycleWidth(w, 'a');
    remove(w, 'a1');
    expect(JSON.stringify(w)).toBe(snapshot);
  });
});
