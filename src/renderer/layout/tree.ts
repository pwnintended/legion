/**
 * The tiling layout tree (architecture §11): Workspace(run) → Strip → Column → Tile.
 *
 * Pure and immutable: every op takes a Workspace and returns a new one (or the same reference when nothing
 * changed), so the tree can be persisted as JSON, diffed and unit-tested without a DOM.
 */
import type { TileDescriptor, TileKind } from './types';

export type ColumnMode = 'split' | 'stacked' | 'tabbed';
/** Column widths, niri-style presets. `thin` is a collapsed column showing only a vertical title. */
export type WidthPreset = '1/3' | '1/2' | '2/3' | 'full' | 'thin';
export type ExpandedWidth = Exclude<WidthPreset, 'thin'>;
export const WIDTH_CYCLE: readonly ExpandedWidth[] = ['1/3', '1/2', '2/3', 'full'];
export const COLUMN_MODES: readonly ColumnMode[] = ['split', 'tabbed', 'stacked'];

export type LayoutMode = 'strip' | 'focus' | 'overview' | 'pipeline';
export const LAYOUT_MODES: readonly LayoutMode[] = ['strip', 'focus', 'overview', 'pipeline'];

/** h = left, j = down, k = up, l = right. */
export type Dir = 'h' | 'j' | 'k' | 'l';

export interface LayoutTile<K extends TileKind = TileKind> extends TileDescriptor<K> {
  /** Created by `syncWithRun` (may be removed by it again); false for tiles the user opened. */
  auto: boolean;
}

export interface Column {
  id: string;
  /** Sync key for columns derived from the run (`plan`, `dag`, `task:T3`, `end`); null for user columns. */
  key: string | null;
  mode: ColumnMode;
  /** Width when expanded. */
  width: ExpandedWidth;
  /** Shown as a thin column with a vertical title. */
  collapsed: boolean;
  tiles: LayoutTile[];
  /** Active tile (the visible tab / expanded stack entry, and where focus lands when entering the column). */
  active: string;
  /** What the user changed by hand: `syncWithRun` never overrides these. */
  pinned: { width?: true; collapsed?: true; mode?: true };
}

export interface Strip {
  columns: Column[];
}

export interface Workspace {
  v: 1;
  runId: string;
  strip: Strip;
  focus: { column: string; tile: string } | null;
  /** Column temporarily shown at full width (⌘F). */
  maximized: string | null;
  /** Counter for ids of user-created columns/tiles. */
  nextId: number;
}

export function emptyWorkspace(runId: string): Workspace {
  return { v: 1, runId, strip: { columns: [] }, focus: null, maximized: null, nextId: 1 };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export function effectiveWidth(column: Column): WidthPreset {
  return column.collapsed ? 'thin' : column.width;
}

export function columnIndex(ws: Workspace, columnId: string): number {
  return ws.strip.columns.findIndex((c) => c.id === columnId);
}

export function getColumn(ws: Workspace, columnId: string): Column | null {
  return ws.strip.columns.find((c) => c.id === columnId) ?? null;
}

export function columnOfTile(ws: Workspace, tileId: string): Column | null {
  return ws.strip.columns.find((c) => c.tiles.some((t) => t.id === tileId)) ?? null;
}

export function findTile(ws: Workspace, tileId: string): LayoutTile | null {
  for (const column of ws.strip.columns) {
    const tile = column.tiles.find((t) => t.id === tileId);
    if (tile) return tile;
  }
  return null;
}

export function focusedColumn(ws: Workspace): Column | null {
  return ws.focus ? getColumn(ws, ws.focus.column) : null;
}

export function focusedTile(ws: Workspace): LayoutTile | null {
  return ws.focus ? findTile(ws, ws.focus.tile) : null;
}

export function allTiles(ws: Workspace): { tile: LayoutTile; column: Column }[] {
  return ws.strip.columns.flatMap((column) => column.tiles.map((tile) => ({ tile, column })));
}

// ---------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------

function withColumns(ws: Workspace, columns: Column[]): Workspace {
  return { ...ws, strip: { columns } };
}

function mapColumn(ws: Workspace, columnId: string, fn: (column: Column) => Column): Workspace {
  let changed = false;
  const columns = ws.strip.columns.map((c) => {
    if (c.id !== columnId) return c;
    const next = fn(c);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? withColumns(ws, columns) : ws;
}

/** Make sure focus and maximized point at things that exist. */
export function normalize(ws: Workspace, preferIndex = 0): Workspace {
  const columns = ws.strip.columns;
  let focus = ws.focus;
  if (columns.length === 0) focus = null;
  else {
    const column = focus ? columns.find((c) => c.id === focus?.column) : undefined;
    if (!column) {
      const fallback = columns[Math.max(0, Math.min(preferIndex, columns.length - 1))] as Column;
      focus = { column: fallback.id, tile: fallback.active };
    } else if (!column.tiles.some((t) => t.id === focus?.tile)) {
      focus = { column: column.id, tile: column.active };
    }
  }
  const maximized = ws.maximized && columns.some((c) => c.id === ws.maximized) ? ws.maximized : null;
  const sameFocus = focus === ws.focus || (focus?.column === ws.focus?.column && focus?.tile === ws.focus?.tile);
  if (sameFocus && maximized === ws.maximized) return ws;
  return { ...ws, focus, maximized };
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

export interface NewColumn {
  id: string;
  key?: string | null;
  mode?: ColumnMode;
  width?: ExpandedWidth;
  collapsed?: boolean;
  tiles: LayoutTile[];
}

export function makeColumn(spec: NewColumn): Column {
  const first = spec.tiles[0];
  if (!first) throw new Error('a column needs at least one tile');
  return {
    id: spec.id,
    key: spec.key ?? null,
    mode: spec.mode ?? 'split',
    width: spec.width ?? '1/2',
    collapsed: spec.collapsed ?? false,
    tiles: spec.tiles,
    active: first.id,
    pinned: {},
  };
}

/** A fresh id for a user-created column or tile, plus the workspace with its counter bumped. */
export function allocateId(ws: Workspace, prefix: string): [string, Workspace] {
  return [`${prefix}:u${ws.nextId}`, { ...ws, nextId: ws.nextId + 1 }];
}

// ---------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------

/** Insert a column after `afterColumnId` (null = at the start; missing id = at the end). */
export function insertColumn(ws: Workspace, column: Column, afterColumnId: string | null, focus = false): Workspace {
  if (getColumn(ws, column.id)) throw new Error(`duplicate column id ${column.id}`);
  const columns = [...ws.strip.columns];
  let index: number;
  if (afterColumnId === null) index = 0;
  else {
    const at = columns.findIndex((c) => c.id === afterColumnId);
    index = at === -1 ? columns.length : at + 1;
  }
  columns.splice(index, 0, column);
  const next = withColumns(ws, columns);
  return focus ? { ...next, focus: { column: column.id, tile: column.active } } : normalize(next);
}

/** Insert a tile into the column of `afterTileId`, right below it. */
export function insertAfter(ws: Workspace, afterTileId: string, tile: LayoutTile, focus = false): Workspace {
  if (findTile(ws, tile.id)) throw new Error(`duplicate tile id ${tile.id}`);
  const column = columnOfTile(ws, afterTileId);
  if (!column) return ws;
  const index = column.tiles.findIndex((t) => t.id === afterTileId);
  const tiles = [...column.tiles];
  tiles.splice(index + 1, 0, tile);
  const next = mapColumn(ws, column.id, (c) => ({ ...c, tiles, active: focus ? tile.id : c.active }));
  return focus ? { ...next, focus: { column: column.id, tile: tile.id } } : next;
}

/** Remove a tile; an emptied column disappears and focus moves to a neighbour. */
export function remove(ws: Workspace, tileId: string): Workspace {
  const column = columnOfTile(ws, tileId);
  if (!column) return ws;
  const colIndex = columnIndex(ws, column.id);
  const tiles = column.tiles.filter((t) => t.id !== tileId);
  if (tiles.length === 0) {
    const columns = ws.strip.columns.filter((c) => c.id !== column.id);
    const focus = ws.focus?.column === column.id ? null : ws.focus;
    return normalize({ ...withColumns(ws, columns), focus }, Math.max(0, colIndex - 1));
  }
  const tileIndex = column.tiles.findIndex((t) => t.id === tileId);
  const neighbour = (tiles[Math.min(tileIndex, tiles.length - 1)] ?? tiles[0]) as LayoutTile;
  const nextColumn = { ...column, tiles, active: column.active === tileId ? neighbour.id : column.active };
  const next = mapColumn(ws, column.id, () => nextColumn);
  if (ws.focus?.tile === tileId) return { ...next, focus: { column: column.id, tile: nextColumn.active } };
  return next;
}

export function removeColumn(ws: Workspace, columnId: string): Workspace {
  const index = columnIndex(ws, columnId);
  if (index === -1) return ws;
  const columns = ws.strip.columns.filter((c) => c.id !== columnId);
  const focus = ws.focus?.column === columnId ? null : ws.focus;
  return normalize({ ...withColumns(ws, columns), focus }, Math.max(0, index - 1));
}

/** Replace a tile's params (e.g. a terminal tile recording the engine terminal it opened). Same ref if unchanged. */
export function setTileParams(ws: Workspace, tileId: string, params: LayoutTile['params']): Workspace {
  const column = columnOfTile(ws, tileId);
  if (!column) return ws;
  return mapColumn(ws, column.id, (c) => {
    const tile = c.tiles.find((t) => t.id === tileId);
    if (!tile || JSON.stringify(tile.params) === JSON.stringify(params)) return c;
    return { ...c, tiles: c.tiles.map((t) => (t.id === tileId ? ({ ...t, params } as LayoutTile) : t)) };
  });
}

export function focusTile(ws: Workspace, tileId: string): Workspace {
  const column = columnOfTile(ws, tileId);
  if (!column) return ws;
  if (ws.focus?.tile === tileId && ws.focus.column === column.id && column.active === tileId) return ws;
  const next = column.active === tileId ? ws : mapColumn(ws, column.id, (c) => ({ ...c, active: tileId }));
  return { ...next, focus: { column: column.id, tile: tileId } };
}

export function focusColumn(ws: Workspace, columnId: string): Workspace {
  const column = getColumn(ws, columnId);
  return column ? focusTile(ws, column.active) : ws;
}

/** Keyboard focus movement: h/l between columns, j/k between tiles of a column. Clamps at the edges. */
export function focusDir(ws: Workspace, dir: Dir): Workspace {
  const column = focusedColumn(ws);
  if (!column) {
    const first = ws.strip.columns[0];
    return first ? focusColumn(ws, first.id) : ws;
  }
  if (dir === 'h' || dir === 'l') {
    const index = columnIndex(ws, column.id) + (dir === 'l' ? 1 : -1);
    const target = ws.strip.columns[index];
    return target ? focusColumn(ws, target.id) : ws;
  }
  const tileIndex = column.tiles.findIndex((t) => t.id === ws.focus?.tile);
  const target = column.tiles[tileIndex + (dir === 'j' ? 1 : -1)];
  return target ? focusTile(ws, target.id) : ws;
}

/** h/l moves the focused column along the strip; j/k moves the focused tile within its column. */
export function moveDir(ws: Workspace, dir: Dir): Workspace {
  const column = focusedColumn(ws);
  if (!column || !ws.focus) return ws;
  if (dir === 'h' || dir === 'l') {
    const index = columnIndex(ws, column.id);
    const target = index + (dir === 'l' ? 1 : -1);
    if (target < 0 || target >= ws.strip.columns.length) return ws;
    const columns = [...ws.strip.columns];
    columns.splice(index, 1);
    columns.splice(target, 0, column);
    return withColumns(ws, columns);
  }
  const tileId = ws.focus.tile;
  const index = column.tiles.findIndex((t) => t.id === tileId);
  const target = index + (dir === 'j' ? 1 : -1);
  if (index === -1 || target < 0 || target >= column.tiles.length) return ws;
  const tiles = [...column.tiles];
  const [tile] = tiles.splice(index, 1);
  tiles.splice(target, 0, tile as LayoutTile);
  return mapColumn(ws, column.id, (c) => ({ ...c, tiles }));
}

/** Set a width preset; `thin` collapses the column (its expanded width is kept). Pins the choice. */
export function setWidthPreset(ws: Workspace, columnId: string, preset: WidthPreset): Workspace {
  return mapColumn(ws, columnId, (c) => {
    if (preset === 'thin') {
      if (c.collapsed && c.pinned.collapsed) return c;
      return { ...c, collapsed: true, pinned: { ...c.pinned, collapsed: true } };
    }
    if (c.width === preset && !c.collapsed && c.pinned.width && c.pinned.collapsed) return c;
    return { ...c, width: preset, collapsed: false, pinned: { ...c.pinned, width: true, collapsed: true } };
  });
}

/** Step through 1/3 → 1/2 → 2/3 → full (dir +1) or back; stepping below 1/3 collapses to thin. */
export function cycleWidth(ws: Workspace, columnId: string, dir: 1 | -1 = 1): Workspace {
  const column = getColumn(ws, columnId);
  if (!column) return ws;
  if (column.collapsed) return dir > 0 ? setWidthPreset(ws, columnId, column.width) : ws;
  const index = WIDTH_CYCLE.indexOf(column.width) + dir;
  if (index < 0) return setWidthPreset(ws, columnId, 'thin');
  const preset = WIDTH_CYCLE[Math.min(index, WIDTH_CYCLE.length - 1)] as ExpandedWidth;
  return setWidthPreset(ws, columnId, preset);
}

export function collapse(ws: Workspace, columnId: string): Workspace {
  return setWidthPreset(ws, columnId, 'thin');
}

export function expand(ws: Workspace, columnId: string): Workspace {
  return mapColumn(ws, columnId, (c) =>
    !c.collapsed && c.pinned.collapsed ? c : { ...c, collapsed: false, pinned: { ...c.pinned, collapsed: true } },
  );
}

export function toggleCollapsed(ws: Workspace, columnId: string): Workspace {
  const column = getColumn(ws, columnId);
  if (!column) return ws;
  return column.collapsed ? expand(ws, columnId) : collapse(ws, columnId);
}

export function setColumnMode(ws: Workspace, columnId: string, mode: ColumnMode): Workspace {
  return mapColumn(ws, columnId, (c) =>
    c.mode === mode && c.pinned.mode ? c : { ...c, mode, pinned: { ...c.pinned, mode: true } },
  );
}

/** split ↔ stacked */
export function toggleStacked(ws: Workspace, columnId: string): Workspace {
  const column = getColumn(ws, columnId);
  return column ? setColumnMode(ws, columnId, column.mode === 'stacked' ? 'split' : 'stacked') : ws;
}

/** split ↔ tabbed */
export function toggleTabbed(ws: Workspace, columnId: string): Workspace {
  const column = getColumn(ws, columnId);
  return column ? setColumnMode(ws, columnId, column.mode === 'tabbed' ? 'split' : 'tabbed') : ws;
}

/** split → tabbed → stacked → split (⌘W). */
export function cycleColumnMode(ws: Workspace, columnId: string): Workspace {
  const column = getColumn(ws, columnId);
  if (!column) return ws;
  const next = COLUMN_MODES[(COLUMN_MODES.indexOf(column.mode) + 1) % COLUMN_MODES.length] as ColumnMode;
  return setColumnMode(ws, columnId, next);
}

/** Toggle the focused column at full width (niri's maximize-column). */
export function maximize(ws: Workspace): Workspace {
  const column = focusedColumn(ws);
  if (!column) return ws;
  return { ...ws, maximized: ws.maximized === column.id ? null : column.id };
}
