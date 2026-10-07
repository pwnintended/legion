import { describe, expect, it } from 'vitest';
import { arrange, GAP, neighbour, SPLIT_MIN, TAB_H } from './arrange';

const WIDE = { w: 1600, h: 1000 };
const none = { monocle: null, focus: null, recent: [] };
const placed = (ids: string[], size = WIDE, options = none) =>
  Object.fromEntries(arrange(ids, size, options).tiles.map((t) => [t.id, t.rect]));

describe('arrange', () => {
  it('fills the board with one tile, inside the gutter', () => {
    expect(placed(['a'])).toEqual({ a: { x: GAP, y: GAP, w: 1600 - 2 * GAP, h: 1000 - 2 * GAP } });
  });

  it('splits two tiles side by side, edge to edge with one gap between', () => {
    const { a, b } = placed(['a', 'b']);
    expect(a?.y).toBe(b?.y);
    expect(a?.h).toBe(b?.h);
    expect((b?.x ?? 0) - ((a?.x ?? 0) + (a?.w ?? 0))).toBe(GAP);
    expect((b?.x ?? 0) + (b?.w ?? 0)).toBe(1600 - GAP);
  });

  it('puts the master on the left and stacks the rest, master wider than the stack', () => {
    const { a, b, c, d } = placed(['a', 'b', 'c', 'd']);
    expect(a?.h).toBe(1000 - 2 * GAP);
    expect(a?.w).toBeGreaterThan(b?.w ?? 0);
    expect(b?.x).toBe(c?.x);
    expect(c?.x).toBe(d?.x);
    expect((c?.y ?? 0) - ((b?.y ?? 0) + (b?.h ?? 0))).toBe(GAP);
    expect((d?.y ?? 0) + (d?.h ?? 0)).toBe(1000 - GAP);
  });

  it('turns the overflow into tabs in the last stack slot', () => {
    const result = arrange(['a', 'b', 'c', 'd', 'e', 'f'], WIDE, none);
    expect(result.tiles.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]?.ids).toEqual(['d', 'e', 'f']);
    expect(result.tabs[0]?.rect.h).toBe(TAB_H);
  });

  it('shows the focused (or most recent) tile of a tab row', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(arrange(ids, WIDE, { ...none, focus: 'f' }).tabs[0]?.active).toBe('f');
    expect(arrange(ids, WIDE, { ...none, focus: 'a', recent: ['a', 'e'] }).tabs[0]?.active).toBe('e');
  });

  it('stacks fewer tiles on a short board', () => {
    const result = arrange(['a', 'b', 'c', 'd'], { w: 1400, h: 520 }, none);
    expect(result.tiles).toHaveLength(3);
    expect(result.tabs[0]?.ids).toEqual(['c', 'd']);
  });

  it('shows one tile under every tab in monocle, and when too narrow to split', () => {
    const asked = arrange(['a', 'b', 'c'], WIDE, { ...none, monocle: 'b' });
    expect(asked.monocle).toBe(true);
    expect(asked.tiles.map((t) => t.id)).toEqual(['b']);
    expect(asked.tabs[0]?.ids).toEqual(['a', 'b', 'c']);
    const narrow = arrange(['a', 'b'], { w: SPLIT_MIN, h: 800 }, { ...none, focus: 'b' });
    expect(narrow.monocle).toBe(true);
    expect(narrow.tiles.map((t) => t.id)).toEqual(['b']);
  });

  it('ignores a monocle id that is not on the board', () => {
    expect(arrange(['a', 'b'], WIDE, { ...none, monocle: 'zz' }).monocle).toBe(false);
  });
});

describe('neighbour', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const layout = arrange(ids, WIDE, none);
  it('moves between the master and the stack', () => {
    expect(neighbour(layout, ids, 'a', 'right')).toBe('b');
    expect(neighbour(layout, ids, 'c', 'left')).toBe('a');
    expect(neighbour(layout, ids, 'b', 'down')).toBe('c');
    expect(neighbour(layout, ids, 'c', 'up')).toBe('b');
    expect(neighbour(layout, ids, 'a', 'left')).toBeNull();
  });
  it('returns to the stacked tile focused last', () => {
    expect(neighbour(layout, ids, 'a', 'right', ['a', 'd', 'b'])).toBe('d');
  });
  it('starts from the master when nothing is focused', () => {
    expect(neighbour(layout, ids, null, 'right')).toBe('a');
  });
  it('steps through the tabs in monocle, wrapping', () => {
    const mono = arrange(ids, WIDE, { ...none, monocle: 'd' });
    expect(neighbour(mono, ids, 'd', 'right')).toBe('a');
    expect(neighbour(mono, ids, 'a', 'left')).toBe('d');
  });
});
