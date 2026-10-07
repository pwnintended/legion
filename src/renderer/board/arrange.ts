/**
 * Where the board's tiles go: a dwm/xmonad "tall" layout, deterministic by count. The first id is the master,
 * on the left; the rest stack on the right, as many as the height allows, and the overflow shares the last
 * stack slot as tabs. One tile fills the board; two split it in half. Monocle (or a board too narrow to split)
 * shows one tile with every tile's tab above it. Pure, so the keyboard can ask for neighbours outside React.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TabRow {
  rect: Rect;
  ids: string[];
  active: string;
}

export interface Arrangement {
  /** The tiles on screen. Ids in a tab row other than its active one are not placed. */
  tiles: { id: string; rect: Rect }[];
  tabs: TabRow[];
  /** One tile with every tab above it (asked for, or forced by a narrow board). */
  monocle: boolean;
}

export const GAP = 10;
export const TAB_H = 30;
/** Below this inner width the board stops splitting. */
export const SPLIT_MIN = 720;
/** A stacked tile is never shorter than this; the overflow becomes tabs instead. */
const SLOT_MIN = 230;
const MAX_SLOTS = 3;
const MASTER_SHARE = 0.56;

export interface ArrangeOptions {
  /** The tile shown alone (null = tiled). Ignored when it is not on the board. */
  monocle: string | null;
  /** The focused tile, if any: it is the visible one of its tab row. */
  focus: string | null;
  /** Most recently focused first: picks the visible tile of a tab row the focus is not in. */
  recent: readonly string[];
}

export function arrange(ids: readonly string[], size: { w: number; h: number }, options: ArrangeOptions): Arrangement {
  const inner: Rect = { x: GAP, y: GAP, w: Math.max(0, size.w - 2 * GAP), h: Math.max(0, size.h - 2 * GAP) };
  const n = ids.length;
  if (n === 0) return { tiles: [], tabs: [], monocle: false };
  if (n === 1) return { tiles: [{ id: ids[0] as string, rect: inner }], tabs: [], monocle: false };

  const pick = (group: readonly string[]) => {
    if (options.focus && group.includes(options.focus)) return options.focus;
    return options.recent.find((id) => group.includes(id)) ?? (group[0] as string);
  };

  const asked = options.monocle !== null && ids.includes(options.monocle);
  if (asked || inner.w < SPLIT_MIN) {
    const active = asked ? (options.monocle as string) : pick(ids);
    return {
      tiles: [{ id: active, rect: below(inner) }],
      tabs: [{ rect: { ...inner, h: TAB_H }, ids: [...ids], active }],
      monocle: true,
    };
  }

  if (n === 2) {
    const w = Math.floor((inner.w - GAP) / 2);
    return {
      tiles: [
        { id: ids[0] as string, rect: { ...inner, w } },
        { id: ids[1] as string, rect: { ...inner, x: inner.x + w + GAP, w: inner.w - w - GAP } },
      ],
      tabs: [],
      monocle: false,
    };
  }

  const masterW = Math.round((inner.w - GAP) * MASTER_SHARE);
  const master: Rect = { ...inner, w: masterW };
  const column: Rect = { x: inner.x + masterW + GAP, y: inner.y, w: inner.w - masterW - GAP, h: inner.h };
  const fit = Math.max(1, Math.min(MAX_SLOTS, Math.floor((column.h + GAP) / (SLOT_MIN + GAP))));
  const rest = ids.slice(1);
  const slots = Math.min(rest.length, fit);
  const slotH = (column.h - GAP * (slots - 1)) / slots;
  const tiles: Arrangement['tiles'] = [{ id: ids[0] as string, rect: master }];
  const tabs: TabRow[] = [];
  for (let i = 0; i < slots; i++) {
    const y = Math.round(column.y + i * (slotH + GAP));
    const rect: Rect = { ...column, y, h: Math.round(column.y + (i + 1) * slotH + i * GAP) - y };
    const last = i === slots - 1;
    if (last && rest.length > slots) {
      const group = rest.slice(i);
      const active = pick(group);
      tabs.push({ rect: { ...rect, h: TAB_H }, ids: group, active });
      tiles.push({ id: active, rect: below(rect) });
    } else tiles.push({ id: rest[i] as string, rect });
  }
  return { tiles, tabs, monocle: false };
}

/** A slot's tile under its tab row. */
function below(rect: Rect): Rect {
  const top = TAB_H + 6;
  return { ...rect, y: rect.y + top, h: Math.max(0, rect.h - top) };
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * The tile to focus from `from` in `dir`, as a tiling window manager does it: of the tiles directly that way
 * (overlapping `from` across the direction), the one focused most recently, else the first (top or left one);
 * failing those, the nearest tile whose centre lies that way. In monocle, left/up and right/down step through
 * the tabs instead.
 */
export function neighbour(
  arrangement: Arrangement,
  order: readonly string[],
  from: string | null,
  dir: Direction,
  recent: readonly string[] = [],
): string | null {
  if (arrangement.monocle) {
    const ids = arrangement.tabs[0]?.ids ?? order;
    const at = from ? ids.indexOf(from) : -1;
    if (at === -1) return ids[0] ?? null;
    const step = dir === 'left' || dir === 'up' ? -1 : 1;
    return ids[(at + step + ids.length) % ids.length] ?? null;
  }
  const origin = arrangement.tiles.find((t) => t.id === from);
  if (!origin) return arrangement.tiles[0]?.id ?? null;
  const horizontal = dir === 'left' || dir === 'right';
  const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const o = centre(origin.rect);
  const along = (r: Rect) => {
    const c = centre(r);
    return dir === 'left' ? o.x - c.x : dir === 'right' ? c.x - o.x : dir === 'up' ? o.y - c.y : c.y - o.y;
  };
  const span = (r: Rect) => (horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]) as [number, number];
  const [lo, hi] = span(origin.rect);
  const ahead = arrangement.tiles.filter((t) => t.id !== origin.id && along(t.rect) > 1);
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
