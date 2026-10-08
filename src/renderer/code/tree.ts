/**
 * A workspace's layout, i3-style: a tree of containers whose leaves are tiles. A container splits its children
 * side by side (`h`) or above each other (`v`) in sizes that add up to 1, or shows one child at a time under a
 * row of tabs (`tabbed`) or a stack of title bars (`stacked`). The user arranges it: open beside the focused
 * tile, split it, move a tile, resize it, turn a container into tabs. Nothing rearranges itself.
 *
 * Pure: every op returns a new tree (or the same one when nothing changed). Geometry (`computeRects`) is pure too,
 * so the keyboard can find neighbours outside React.
 */

export type Orientation = 'h' | 'v';
export type ConLayout = 'split' | 'tabbed' | 'stacked';
export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Leaf {
  type: 'leaf';
  id: string;
}

export interface Con {
  type: 'con';
  id: string;
  orientation: Orientation;
  layout: ConLayout;
  children: Node[];
  /** Share of each child along the orientation (split layout); they add up to 1. */
  sizes: number[];
  /** The child shown in a tabbed or stacked container. */
  active: number;
}

export type Node = Leaf | Con;

export const MIN_SHARE = 0.12;
/** Height of a tabbed container's tab row, and of each title bar in a stacked one. */
export const TAB_H = 30;
export const STACK_H = 28;
export const GAP = 10;

export function emptyRoot(id = 'root'): Con {
  return { type: 'con', id, orientation: 'h', layout: 'split', children: [], sizes: [], active: 0 };
}

const axisOf = (dir: Direction): Orientation => (dir === 'left' || dir === 'right' ? 'h' : 'v');
const forward = (dir: Direction) => dir === 'right' || dir === 'down';

export function leaves(node: Node): string[] {
  return node.type === 'leaf' ? [node.id] : node.children.flatMap(leaves);
}

export function contains(node: Node, id: string): boolean {
  return node.id === id || (node.type === 'con' && node.children.some((c) => contains(c, id)));
}

/** The chain of containers from the root down to (not including) `id`. */
export function pathTo(root: Con, id: string): Con[] {
  const walk = (con: Con): Con[] | null => {
    for (const child of con.children) {
      if (child.id === id) return [con];
      if (child.type === 'con') {
        const below = walk(child);
        if (below) return [con, ...below];
      }
    }
    return null;
  };
  return walk(root) ?? [];
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (sizes.length === 0) return [];
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/** Replace the container `id` (found anywhere) by what `change` makes of it. */
function mapCon(root: Con, id: string, change: (con: Con) => Node): Con {
  const walk = (con: Con): Node => {
    if (con.id === id) return change(con);
    let changed = false;
    const children = con.children.map((child) => {
      if (child.type !== 'con') return child;
      const next = walk(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...con, children } : con;
  };
  const next = walk(root);
  return next.type === 'con' ? next : { ...emptyRoot(root.id), children: [next], sizes: [1] };
}

/** Collapse containers with a single child into that child, and drop empty ones (the root stays). */
function tidy(root: Con): Con {
  const walk = (con: Con): Node | null => {
    const kept: { node: Node; size: number }[] = [];
    con.children.forEach((child, i) => {
      const next = child.type === 'con' ? walk(child) : child;
      if (next) kept.push({ node: next, size: con.sizes[i] ?? 1 / con.children.length });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1 && con.id !== root.id) return kept[0]?.node ?? null;
    return {
      ...con,
      children: kept.map((k) => k.node),
      sizes: normalize(kept.map((k) => k.size)),
      active: Math.min(con.active, kept.length - 1),
    };
  };
  const next = walk(root);
  if (!next) return emptyRoot(root.id);
  // A root with one container child takes its place (keeping the root's id), so the tree never deepens for nothing.
  if (next.type === 'con' && next.children.length === 1 && next.children[0]?.type === 'con') {
    const only = next.children[0];
    return { ...only, id: root.id };
  }
  return next.type === 'con' ? next : { ...emptyRoot(root.id), children: [next], sizes: [1] };
}

/**
 * Open `id` beside `target`, along `orientation`. In a split container of that orientation it becomes the next
 * sibling (halving the target's share); in a tabbed or stacked container, the next tab; otherwise the target
 * and the new tile share a new container. With no target (an empty workspace), it fills the root.
 */
export function openBeside(root: Con, target: string | null, id: string, orientation: Orientation, conId: string): Con {
  const leaf: Leaf = { type: 'leaf', id };
  if (!target || !contains(root, target)) {
    if (root.children.length === 0) return { ...root, orientation, children: [leaf], sizes: [1] };
    return { ...root, children: [...root.children, leaf], sizes: normalize([...root.sizes, 1 / root.children.length]) };
  }
  const parent = pathTo(root, target).at(-1) ?? root;
  const at = parent.children.findIndex((c) => c.id === target);
  if (parent.layout !== 'split') {
    return mapCon(root, parent.id, (con) => {
      const children = [...con.children];
      children.splice(at + 1, 0, leaf);
      return { ...con, children, sizes: normalize([...con.sizes, 1 / con.children.length]), active: at + 1 };
    });
  }
  if (parent.orientation === orientation || parent.children.length === 1) {
    return mapCon(root, parent.id, (con) => {
      const children = [...con.children];
      children.splice(at + 1, 0, leaf);
      const sizes = [...con.sizes];
      const half = (sizes[at] ?? 1) / 2;
      sizes.splice(at, 1, half, half);
      return { ...con, orientation, children, sizes };
    });
  }
  return mapCon(root, parent.id, (con) => {
    const target = con.children[at] as Node;
    const pair: Con = {
      type: 'con',
      id: conId,
      orientation,
      layout: 'split',
      children: [target, leaf],
      sizes: [0.5, 0.5],
      active: 1,
    };
    const children = [...con.children];
    children[at] = pair;
    return { ...con, children };
  });
}

/** Take a tile out of its container, leaving the rest of the tree as it is (no tidying). */
function detach(root: Con, id: string): Con {
  const parent = pathTo(root, id).at(-1);
  if (!parent) return root;
  return mapCon(root, parent.id, (con) => {
    const at = con.children.findIndex((c) => c.id === id);
    const children = con.children.filter((_, i) => i !== at);
    const sizes = normalize(con.sizes.filter((_, i) => i !== at));
    const active = con.active > at ? con.active - 1 : Math.min(con.active, children.length - 1);
    return { ...con, children, sizes, active: Math.max(0, active) };
  });
}

/** Take a tile out; its share goes to its neighbours and containers left with one child dissolve. */
export function remove(root: Con, id: string): Con {
  if (!pathTo(root, id).length) return root;
  return tidy(detach(root, id));
}

/** In every tabbed or stacked container on the way to `id`, show the branch that holds it. */
export function reveal(root: Con, id: string): Con {
  let next = root;
  const chain = pathTo(root, id);
  for (let i = 0; i < chain.length; i++) {
    const con = chain[i] as Con;
    if (con.layout === 'split') continue;
    const branch = chain[i + 1]?.id ?? id;
    const at = con.children.findIndex((c) => c.id === branch);
    if (at !== -1 && at !== con.active) next = mapCon(next, con.id, (c) => ({ ...c, active: at }));
  }
  return next;
}

/** The container a tile sits in, set to `layout` (and for a split, `orientation`). */
export function setLayout(root: Con, id: string, layout: ConLayout, orientation?: Orientation): Con {
  const parent = pathTo(root, id).at(-1);
  if (!parent) return root;
  const at = parent.children.findIndex((c) => contains(c, id));
  return mapCon(root, parent.id, (con) => ({
    ...con,
    layout,
    orientation: orientation ?? con.orientation,
    active: layout === 'split' ? con.active : Math.max(0, at),
  }));
}

/** i3's "layout toggle split": a split container flips between side by side and above each other. */
export function toggleSplit(root: Con, id: string): Con {
  const parent = pathTo(root, id).at(-1);
  if (!parent) return root;
  if (parent.layout !== 'split') return setLayout(root, id, 'split');
  return setLayout(root, id, 'split', parent.orientation === 'h' ? 'v' : 'h');
}

/**
 * Grow (`step` > 0) or shrink the tile along the axis of `dir` (left/right = width, up/down = height): the nearest
 * split container of that axis gives the share to (or takes it from) the tile's neighbour on that side, or on
 * the other side at an edge. Shares never drop below MIN_SHARE.
 */
export function resize(root: Con, id: string, dir: Direction, step: number): Con {
  const axis = axisOf(dir);
  const chain = pathTo(root, id);
  for (let i = chain.length - 1; i >= 0; i--) {
    const con = chain[i] as Con;
    if (con.layout !== 'split' || con.orientation !== axis || con.children.length < 2) continue;
    const branch = chain[i + 1]?.id ?? id;
    const at = con.children.findIndex((c) => c.id === branch);
    const other = forward(dir) ? (at + 1 < con.children.length ? at + 1 : at - 1) : at > 0 ? at - 1 : at + 1;
    const grow = forward(dir) ? step : -step;
    const sizes = [...con.sizes];
    const mine = (sizes[at] ?? 0) + grow;
    const theirs = (sizes[other] ?? 0) - grow;
    if (mine < MIN_SHARE || theirs < MIN_SHARE) return root;
    sizes[at] = mine;
    sizes[other] = theirs;
    return mapCon(root, con.id, (c) => ({ ...c, sizes }));
  }
  return root;
}

/**
 * Move a tile one step in `dir`, i3-style: past its sibling in a container of that axis; out of its container
 * into the nearest ancestor of that axis (beside the branch it came from); else to that edge of the workspace,
 * which then splits along that axis.
 */
export function move(root: Con, id: string, dir: Direction, conId: string): Con {
  const axis = axisOf(dir);
  const chain = pathTo(root, id);
  const parent = chain.at(-1);
  if (!parent) return root;
  const leaf: Leaf = { type: 'leaf', id };
  const siblingAxis = parent.layout === 'split' ? parent.orientation : 'h';
  if (siblingAxis === axis && parent.children.length > 1) {
    const at = parent.children.findIndex((c) => c.id === id);
    const to = at + (forward(dir) ? 1 : -1);
    if (to >= 0 && to < parent.children.length) {
      const neighbour = parent.children[to] as Node;
      // Into a neighbouring container, i3 puts the tile inside it (at the near end); a tile just swaps places.
      if (neighbour.type === 'con') {
        const without = detach(root, id);
        return tidy(
          mapCon(without, neighbour.id, (con) => {
            const children = forward(dir) ? [leaf, ...con.children] : [...con.children, leaf];
            const share = 1 / (con.children.length + 1);
            const scaled = con.sizes.map((x) => x * (1 - share));
            const sizes = forward(dir) ? [share, ...scaled] : [...scaled, share];
            return { ...con, children, sizes, active: forward(dir) ? 0 : children.length - 1 };
          }),
        );
      }
      return mapCon(root, parent.id, (con) => {
        const children = [...con.children];
        const sizes = [...con.sizes];
        [children[at], children[to]] = [children[to] as Node, children[at] as Node];
        [sizes[at], sizes[to]] = [sizes[to] as number, sizes[at] as number];
        return { ...con, children, sizes };
      });
    }
  }
  // Out to the nearest ancestor of that axis, beside the branch we come from.
  for (let i = chain.length - 2; i >= 0; i--) {
    const con = chain[i] as Con;
    if (con.layout !== 'split' || con.orientation !== axis) continue;
    const branch = chain[i + 1]?.id as string;
    const at = con.children.findIndex((x) => x.id === branch);
    const insert = forward(dir) ? at + 1 : at;
    return tidy(
      mapCon(detach(root, id), con.id, (c) => {
        const children = [...c.children];
        children.splice(insert, 0, leaf);
        const share = 1 / (c.children.length + 1);
        const sizes = c.sizes.map((x) => x * (1 - share));
        sizes.splice(insert, 0, share);
        return { ...c, children, sizes };
      }),
    );
  }
  // To the workspace's edge: the root splits along that axis (what was there stays together on the other side).
  if (
    chain.length === 1 &&
    (parent.children.length === 1 || (parent.layout === 'split' && parent.orientation === axis))
  )
    return root;
  const without = detach(root, id);
  const rest: Con = { ...without, id: conId };
  const children: Node[] = forward(dir) ? [rest, leaf] : [leaf, rest];
  return tidy({ ...emptyRoot(root.id), orientation: axis, children, sizes: [0.5, 0.5] });
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bar {
  /** The tabbed or stacked container. */
  con: string;
  layout: 'tabbed' | 'stacked';
  rect: Rect;
  /** Its children, in order (a child container is named after the tiles in it). */
  children: { id: string; leaves: string[] }[];
  active: number;
}

export interface Layout {
  /** The tiles on screen; tiles behind another tab are not placed. */
  tiles: { id: string; rect: Rect }[];
  bars: Bar[];
}

/** Where everything goes in `area` (gaps between tiles; the caller pads the outside). */
export function computeRects(root: Con, area: Rect): Layout {
  const tiles: Layout['tiles'] = [];
  const bars: Bar[] = [];
  const place = (node: Node, rect: Rect) => {
    if (node.type === 'leaf') {
      tiles.push({ id: node.id, rect });
      return;
    }
    if (node.children.length === 0) return;
    if (node.layout !== 'split') {
      const head = node.layout === 'tabbed' ? TAB_H : STACK_H * node.children.length;
      bars.push({
        con: node.id,
        layout: node.layout,
        rect: { ...rect, h: head },
        children: node.children.map((c) => ({ id: c.id, leaves: leaves(c) })),
        active: node.active,
      });
      const shown = node.children[Math.min(node.active, node.children.length - 1)];
      const top = head + 6;
      if (shown) place(shown, { ...rect, y: rect.y + top, h: Math.max(0, rect.h - top) });
      return;
    }
    const horizontal = node.orientation === 'h';
    const total = (horizontal ? rect.w : rect.h) - GAP * (node.children.length - 1);
    let offset = horizontal ? rect.x : rect.y;
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      const span = last
        ? (horizontal ? rect.x + rect.w : rect.y + rect.h) - offset
        : Math.round(total * (node.sizes[i] ?? 1 / node.children.length));
      place(child, horizontal ? { ...rect, x: offset, w: span } : { ...rect, y: offset, h: span });
      offset += span + GAP;
    });
  };
  place(root, area);
  return { tiles, bars };
}

/**
 * The tile to focus from `from` in `dir`: of the tiles on screen directly that way (overlapping across the
 * direction), the nearest, preferring the one focused most recently; failing that, the nearest whose centre lies
 * that way.
 */
export function neighbour(layout: Layout, from: string | null, dir: Direction, recent: readonly string[] = []) {
  const origin = layout.tiles.find((t) => t.id === from);
  if (!origin) return layout.tiles[0]?.id ?? null;
  const horizontal = axisOf(dir) === 'h';
  const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const o = centre(origin.rect);
  const along = (r: Rect) => {
    const c = centre(r);
    return dir === 'left' ? o.x - c.x : dir === 'right' ? c.x - o.x : dir === 'up' ? o.y - c.y : c.y - o.y;
  };
  const span = (r: Rect) => (horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]) as [number, number];
  const [lo, hi] = span(origin.rect);
  const ahead = layout.tiles.filter((t) => t.id !== origin.id && along(t.rect) > 1);
  const adjacent = ahead.filter((t) => {
    const [a, b] = span(t.rect);
    return a < hi - 1 && b > lo + 1;
  });
  if (adjacent.length) {
    const nearest = Math.min(...adjacent.map((t) => along(t.rect)));
    const row = adjacent.filter((t) => along(t.rect) - nearest < 2);
    const remembered = recent.find((id) => row.some((t) => t.id === id));
    if (remembered) return remembered;
    return [...row].sort((a, b) => span(a.rect)[0] - span(b.rect)[0])[0]?.id ?? null;
  }
  let best: { id: string; score: number } | null = null;
  for (const tile of ahead) {
    const c = centre(tile.rect);
    const across = horizontal ? Math.abs(c.y - o.y) : Math.abs(c.x - o.x);
    const score = along(tile.rect) + 2 * across;
    if (!best || score < best.score) best = { id: tile.id, score };
  }
  return best?.id ?? null;
}

/** Step through the tabs of the tabbed or stacked container that holds `id` (null when there is none). */
export function cycleTabs(root: Con, id: string, step: 1 | -1): { root: Con; focus: string } | null {
  const chain = pathTo(root, id);
  for (let i = chain.length - 1; i >= 0; i--) {
    const con = chain[i] as Con;
    if (con.layout === 'split' || con.children.length < 2) continue;
    const active = (con.active + step + con.children.length) % con.children.length;
    const next = mapCon(root, con.id, (c) => ({ ...c, active }));
    const shown = con.children[active] as Node;
    return { root: next, focus: leaves(shown)[0] ?? id };
  }
  return null;
}

/** Is a tree from storage sound (every container's sizes match its children, leaves unique)? */
export function isSound(node: unknown, seen = new Set<string>()): node is Node {
  const n = node as Node | null;
  if (!n || typeof n.id !== 'string' || seen.has(n.id)) return false;
  seen.add(n.id);
  if (n.type === 'leaf') return true;
  if (n.type !== 'con' || !Array.isArray(n.children) || !Array.isArray(n.sizes)) return false;
  if (n.children.length !== n.sizes.length) return false;
  if (!['h', 'v'].includes(n.orientation) || !['split', 'tabbed', 'stacked'].includes(n.layout)) return false;
  return n.children.every((c) => isSound(c, seen));
}
