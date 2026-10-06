/** Navigation helpers for overlays (jump to an inbox item's tile, open tiles) and a tiny toast channel. */
import type { InboxItem } from '@shared/domain';
import { useSyncExternalStore } from 'react';
import { actions, syncActiveLayout, uiStore } from '../app/store';
import { itemTargetsTile, tileTaskId } from '../layout/describe';
import { allocateId, allTiles, columnOfTile, insertColumn, type LayoutTile, makeColumn } from '../layout/tree';

/** Switch to the item's run and focus the tile it targets (the same tile ⌘U would pick). */
export function jumpToItem(item: InboxItem): void {
  actions.closeOverlay();
  actions.setActiveRun(item.runId);
  syncActiveLayout();
  const layout = uiStore.getState().layouts[item.runId];
  const target = layout && allTiles(layout).find(({ tile }) => itemTargetsTile(item, tile, tileTaskId(tile)));
  if (target) actions.revealTile(item.runId, target.tile.id);
}

/** Switch to a run and focus a tile in it. */
export function revealInRun(runId: string, tileId: string | null): void {
  actions.closeOverlay();
  actions.setActiveRun(runId);
  syncActiveLayout();
  if (tileId) actions.revealTile(runId, tileId);
}

/** Open a user tile in a new column right of `anchorTileId` (or the focused column) and focus it. */
export function openTileColumn(runId: string, tile: Omit<LayoutTile, 'id' | 'auto'>, anchorTileId: string | null) {
  actions.setActiveRun(runId);
  syncActiveLayout();
  actions.updateLayout(
    runId,
    (layout) => {
      const [id, next] = allocateId(layout, tile.kind);
      const column = makeColumn({ id: `col:${id}`, width: '1/2', tiles: [{ ...tile, id, auto: false } as LayoutTile] });
      const anchor = anchorTileId ? columnOfTile(next, anchorTileId) : null;
      return insertColumn(next, column, anchor?.id ?? next.focus?.column ?? null, true);
    },
    true,
  );
  actions.setLayoutMode('strip');
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

export interface Toast {
  id: number;
  tone: 'info' | 'error';
  text: string;
}
let toasts: Toast[] = [];
let toastId = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastId;
  toasts = [...toasts.slice(-2), { id, tone, text }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 4200);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}
