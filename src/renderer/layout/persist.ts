/** Per-run layout persistence in localStorage (best effort: storage may be unavailable or full). */

import type { Workspace } from './tree';
import { TILE_KINDS } from './types';

const PREFIX = 'legion.layout.';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isWorkspace(value: unknown, runId: string): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const ws = value as Partial<Workspace>;
  return (
    ws.v === 1 &&
    ws.runId === runId &&
    Array.isArray(ws.strip?.columns) &&
    ws.strip.columns.every(
      (c) =>
        typeof c.id === 'string' &&
        Array.isArray(c.tiles) &&
        c.tiles.length > 0 &&
        c.tiles.every((t) => typeof t.id === 'string' && (TILE_KINDS as readonly string[]).includes(t.kind)),
    )
  );
}

export function loadLayout(runId: string): Workspace | null {
  try {
    const raw = storage()?.getItem(PREFIX + runId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isWorkspace(parsed, runId) ? { ...parsed, maximized: null } : null;
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
