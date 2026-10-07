/**
 * The project home's strip: Overview | Activity | Files at a third each (all three on screen at any window
 * size), plus the columns the user opens from them. Files, commits and search results open in a *preview*
 * column right of the tile they came from, reused for the next file (like an editor's preview tab), so browsing
 * never piles up columns; "open in a new column" (⌘⏎ / ⌘-click) keeps one.
 */

import {
  allocateId,
  columnOfTile,
  emptyWorkspace,
  focusTile,
  insertColumn,
  type LayoutTile,
  makeColumn,
  setTileParams,
  type Workspace,
} from './tree';
import type { TileParamsByKind } from './types';

export type PreviewKind = 'code' | 'diff' | 'search';
type PreviewParams<K extends PreviewKind> = TileParamsByKind[K];

export const HOME_TILES = { project: 'project', activity: 'activity', files: 'files' } as const;

function autoTile<K extends LayoutTile['kind']>(id: string, kind: K, params: LayoutTile<K>['params']): LayoutTile {
  return { id, kind, params, auto: true } as LayoutTile;
}

export function defaultProjectLayout(key: string, projectId: string): Workspace {
  const base = emptyWorkspace(key);
  const columns = [
    makeColumn({
      id: 'col:project',
      key: 'project',
      width: '1/3',
      tiles: [autoTile(HOME_TILES.project, 'project', { projectId })],
    }),
    makeColumn({
      id: 'col:activity',
      key: 'activity',
      width: '1/3',
      tiles: [autoTile(HOME_TILES.activity, 'activity', { projectId })],
    }),
    makeColumn({
      id: 'col:files',
      key: 'files',
      width: '1/3',
      tiles: [autoTile(HOME_TILES.files, 'files', { projectId })],
    }),
  ];
  return { ...base, strip: { columns }, focus: { column: 'col:project', tile: HOME_TILES.project } };
}

/** A stored home is only reused for the same project and when its three home tiles are still there. */
export function isUsableProjectLayout(layout: Workspace | null, projectId: string): layout is Workspace {
  if (!layout) return false;
  const ids = layout.strip.columns.flatMap((c) => c.tiles.map((t) => t));
  return Object.values(HOME_TILES).every((id) =>
    ids.some((t) => t.id === id && (t.params as { projectId?: string }).projectId === projectId),
  );
}

const previewKey = (kind: PreviewKind) => `preview:${kind}`;

/**
 * Show `params` in the preview column of `kind` (created right of `anchorTileId`'s column, or of the focused
 * column) and focus it. With `newColumn`, always open a fresh, permanent column instead.
 */
export function openPreview<K extends PreviewKind>(
  ws: Workspace,
  kind: K,
  params: PreviewParams<K>,
  anchorTileId: string | null,
  newColumn = false,
): Workspace {
  const existing = newColumn ? null : ws.strip.columns.find((c) => c.key === previewKey(kind));
  const reused = existing?.tiles.find((t) => t.kind === kind);
  if (existing && reused) {
    return focusTile(setTileParams(ws, reused.id, params as LayoutTile['params']), reused.id);
  }
  const [id, next] = allocateId(ws, kind);
  const column = makeColumn({
    id: `col:${id}`,
    key: newColumn ? null : previewKey(kind),
    width: kind === 'search' ? '1/3' : '1/2',
    tiles: [{ id, kind, params, auto: false } as LayoutTile],
  });
  const anchor = anchorTileId ? columnOfTile(next, anchorTileId) : null;
  return insertColumn(next, column, anchor?.id ?? next.focus?.column ?? null, true);
}

/** The tile currently showing previews of `kind`, if any. */
export function previewTile(ws: Workspace, kind: PreviewKind): LayoutTile | null {
  return ws.strip.columns.find((c) => c.key === previewKey(kind))?.tiles.find((t) => t.kind === kind) ?? null;
}
