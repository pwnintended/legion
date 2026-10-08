import { describe, expect, it } from 'vitest';
import {
  type Con,
  computeRects,
  cycleTabs,
  emptyRoot,
  isSound,
  leaves,
  move,
  type Node,
  neighbour,
  openBeside,
  remove,
  resize,
  reveal,
  setLayout,
  toggleSplit,
} from './tree';

/** A compact picture of a tree: `h(a b)`, `v(a h(b c))`, `tabbed(a b)`. */
function shape(node: Node): string {
  if (node.type === 'leaf') return node.id;
  const tag = node.layout === 'split' ? node.orientation : node.layout;
  return `${tag}(${node.children.map(shape).join(' ')})`;
}

let n = 0;
const con = () => `c${++n}`;
const open = (root: Con, target: string | null, id: string, o: 'h' | 'v' = 'h') =>
  openBeside(root, target, id, o, con());

const AREA = { x: 0, y: 0, w: 1000, h: 600 };

describe('workspace tree', () => {
  it('fills an empty workspace, then opens beside the focused tile, halving it', () => {
    let t = open(emptyRoot(), null, 'a');
    expect(shape(t)).toBe('h(a)');
    t = open(t, 'a', 'b');
    t = open(t, 'b', 'c');
    expect(shape(t)).toBe('h(a b c)');
    expect(t.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('splits the other way into a new container, and dissolves containers left with one tile', () => {
    let t = open(open(emptyRoot(), null, 'a'), 'a', 'b');
    t = open(t, 'b', 'c', 'v');
    expect(shape(t)).toBe('h(a v(b c))');
    t = remove(t, 'c');
    expect(shape(t)).toBe('h(a b)');
    expect(t.sizes).toEqual([0.5, 0.5]);
    t = remove(remove(t, 'a'), 'b');
    expect(shape(t)).toBe('h()');
    expect(leaves(t)).toEqual([]);
  });

  it('opens as the next tab in a tabbed container, and reveals a tile behind a tab', () => {
    let t = open(open(emptyRoot(), null, 'a'), 'a', 'b');
    t = setLayout(t, 'a', 'tabbed');
    expect(shape(t)).toBe('tabbed(a b)');
    t = open(t, 'a', 'c');
    expect(shape(t)).toBe('tabbed(a c b)');
    expect(t.active).toBe(1);
    t = reveal(t, 'b');
    expect(t.active).toBe(2);
    const cycled = cycleTabs(t, 'b', 1);
    expect(cycled?.focus).toBe('a');
  });

  it('toggles a split between side by side and above each other', () => {
    const t = open(open(emptyRoot(), null, 'a'), 'a', 'b');
    expect(shape(toggleSplit(t, 'a'))).toBe('v(a b)');
    expect(shape(toggleSplit(setLayout(t, 'a', 'stacked'), 'a'))).toBe('h(a b)');
  });

  it('resizes against the neighbour on that side, never below the minimum share', () => {
    const t = open(open(emptyRoot(), null, 'a'), 'a', 'b');
    const wider = resize(t, 'a', 'right', 0.1);
    expect(wider.sizes[0]).toBeCloseTo(0.6);
    expect(wider.sizes[1]).toBeCloseTo(0.4);
    // The last tile grows to the right by taking from its left neighbour.
    expect(resize(t, 'b', 'right', 0.1).sizes[1]).toBeCloseTo(0.6);
    expect(resize(t, 'a', 'right', 0.45)).toBe(t);
    // No container of that axis: nothing to do.
    expect(resize(t, 'a', 'down', 0.1)).toBe(t);
  });

  it('moves past a sibling, into a neighbouring container, out to an ancestor, and to the edge', () => {
    let t = open(open(open(emptyRoot(), null, 'a'), 'a', 'b'), 'b', 'c');
    expect(shape(move(t, 'a', 'right', con()))).toBe('h(b a c)');
    // Already at the edge of a split of that axis: nothing happens.
    expect(move(t, 'a', 'left', con())).toBe(t);
    t = open(t, 'c', 'd', 'v');
    expect(shape(t)).toBe('h(a b v(c d))');
    // Into the neighbouring container, at its near end.
    expect(shape(move(t, 'b', 'right', con()))).toBe('h(a v(b c d))');
    // Out of a vertical container to the left, beside it in the horizontal root.
    expect(shape(move(t, 'd', 'left', con()))).toBe('h(a b d c)');
    // Up to the top edge: the workspace splits vertically, the rest together below.
    expect(shape(move(t, 'a', 'up', con()))).toBe('v(a h(b v(c d)))');
  });

  it('lays out with gaps; a tabbed container shows its tab row and the active tile', () => {
    let t = open(open(emptyRoot(), null, 'a'), 'a', 'b');
    let layout = computeRects(t, AREA);
    expect(layout.tiles).toEqual([
      { id: 'a', rect: { x: 0, y: 0, w: 495, h: 600 } },
      { id: 'b', rect: { x: 505, y: 0, w: 495, h: 600 } },
    ]);
    t = setLayout(t, 'a', 'tabbed');
    layout = computeRects(t, AREA);
    expect(layout.tiles.map((x) => x.id)).toEqual(['a']);
    expect(layout.bars[0]).toMatchObject({ layout: 'tabbed', active: 0, children: [{ id: 'a' }, { id: 'b' }] });
  });

  it('finds the neighbour on screen in a direction, preferring the one focused last', () => {
    const t = open(open(open(emptyRoot(), null, 'a'), 'a', 'b'), 'b', 'c', 'v');
    const layout = computeRects(t, AREA);
    expect(neighbour(layout, 'a', 'right')).toBe('b');
    expect(neighbour(layout, 'a', 'right', ['c'])).toBe('c');
    expect(neighbour(layout, 'b', 'down')).toBe('c');
    expect(neighbour(layout, 'c', 'left')).toBe('a');
    expect(neighbour(layout, 'a', 'left')).toBeNull();
  });

  it('accepts only sound trees from storage', () => {
    const t = open(open(emptyRoot(), null, 'a'), 'a', 'b');
    expect(isSound(JSON.parse(JSON.stringify(t)))).toBe(true);
    expect(isSound({ ...t, sizes: [1] })).toBe(false);
    expect(isSound({ ...t, children: [t.children[0], t.children[0]], sizes: [0.5, 0.5] })).toBe(false);
  });
});
