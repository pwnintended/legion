import type { TileKind, TileProps } from '../layout/types';

/** Placeholder body shared by tile stubs until each tile folder gets its real implementation. */
export function TileStub<K extends TileKind>({ kind, tileId, runId }: TileProps<K>) {
  return (
    <div className="flex h-full items-center justify-center bg-base text-sm text-overlay1" data-tile={kind}>
      <span className="font-mono">
        {kind} · {runId} · {tileId}
      </span>
    </div>
  );
}
