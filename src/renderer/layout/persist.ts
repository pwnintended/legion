/**
 * Per-run layout persistence in localStorage (best effort: storage may be unavailable or full).
 *
 * Stored layouts are validated strictly before use: they outlive app versions and a hand-edited or older
 * shape must never reach the layout ops (which assume the full `Workspace` shape and would throw on the
 * data path). Anything that doesn't match is discarded and the layout is re-derived from the run.
 */

import { COLUMN_MODES, WIDTH_CYCLE, type Workspace } from './tree';
import { TILE_KINDS } from './types';

const PREFIX = 'legion.layout.';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNullableStr = (v: unknown) => v === null || typeof v === 'string';
const hasOnly = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/** Tile params per kind (see `TileParamsByKind`). */
function validParams(kind: string, params: unknown): boolean {
  if (!isObj(params)) return false;
  switch (kind) {
    case 'plan':
      return isNullableStr(params.planId);
    case 'session':
      return isNullableStr(params.attemptId) && isNullableStr(params.taskId);
    case 'review':
      return isNullableStr(params.taskId);
    case 'diff': {
      const target = params.target;
      if (!isObj(target)) return false;
      if (target.kind === 'task') return isStr(target.taskId);
      if (target.kind === 'run') return isStr(target.runId);
      if (target.kind === 'range')
        return isStr(target.runId) && typeof target.from === 'string' && typeof target.to === 'string';
      return false;
    }
    case 'terminal':
      return isNullableStr(params.terminalId) && isNullableStr(params.cwd) && isNullableStr(params.attemptId);
    case 'clarify':
      return isNullableStr(params.inboxItemId);
    default:
      // dag, pr, integration: no params.
      return true;
  }
}

function validTile(value: unknown, tileIds: Set<string>): boolean {
  if (!isObj(value)) return false;
  if (!isStr(value.id) || tileIds.has(value.id)) return false;
  tileIds.add(value.id);
  return (
    typeof value.kind === 'string' &&
    (TILE_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.auto === 'boolean' &&
    validParams(value.kind, value.params)
  );
}

function validColumn(value: unknown, columnIds: Set<string>, tileIds: Set<string>): boolean {
  if (!isObj(value)) return false;
  if (!isStr(value.id) || columnIds.has(value.id)) return false;
  columnIds.add(value.id);
  const pinned = value.pinned;
  return (
    isNullableStr(value.key) &&
    (COLUMN_MODES as readonly unknown[]).includes(value.mode) &&
    (WIDTH_CYCLE as readonly unknown[]).includes(value.width) &&
    typeof value.collapsed === 'boolean' &&
    Array.isArray(value.tiles) &&
    value.tiles.length > 0 &&
    value.tiles.every((t) => validTile(t, tileIds)) &&
    isStr(value.active) &&
    value.tiles.some((t) => (t as Obj).id === value.active) &&
    isObj(pinned) &&
    hasOnly(pinned, ['width', 'collapsed', 'mode']) &&
    Object.values(pinned).every((v) => v === true)
  );
}

/** Is `value` a complete, internally consistent `Workspace` for `runId`? */
export function isWorkspace(value: unknown, runId: string): value is Workspace {
  if (!isObj(value) || value.v !== 1 || value.runId !== runId) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  const strip = value.strip;
  if (!isObj(strip) || !Array.isArray(strip.columns)) return false;
  const columnIds = new Set<string>();
  const tileIds = new Set<string>();
  if (!strip.columns.every((c) => validColumn(c, columnIds, tileIds))) return false;
  // User-created ids (`kind:uN`) must stay below the counter, or the next allocation would collide.
  for (const id of [...columnIds, ...tileIds]) {
    const n = /:u(\d+)$/.exec(id)?.[1];
    if (n !== undefined && Number(n) >= (value.nextId as number)) return false;
  }
  const focus = value.focus;
  if (focus !== null) {
    if (!isObj(focus) || !isStr(focus.column) || !isStr(focus.tile)) return false;
    const column = strip.columns.find((c) => (c as Obj).id === focus.column) as Obj | undefined;
    if (!column || !(column.tiles as Obj[]).some((t) => t.id === focus.tile)) return false;
  }
  return value.maximized === undefined || isNullableStr(value.maximized);
}

export function loadLayout(runId: string): Workspace | null {
  try {
    const raw = storage()?.getItem(PREFIX + runId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isWorkspace(parsed, runId)) return { ...parsed, maximized: null };
    clearLayout(runId);
    return null;
  } catch {
    return null;
  }
}

export function saveLayout(layout: Workspace): void {
  try {
    storage()?.setItem(PREFIX + layout.runId, JSON.stringify(layout));
  } catch {
    // Quota exceeded or storage disabled: the layout is simply re-derived next time.
  }
}

export function clearLayout(runId: string): void {
  try {
    storage()?.removeItem(PREFIX + runId);
  } catch {
    // ignore
  }
}
