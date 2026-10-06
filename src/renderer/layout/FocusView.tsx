/**
 * Focus mode (dwm master-stack): the focused tile as master (~62%), a stack of the tiles most worth watching
 * on the right (urgent first, then live work), and the rest as a compact list.
 */
import { motion } from 'motion/react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useData } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { actions, dataStore } from '../app/store';
import { Dot, toneColor } from '../chrome/ui';
import { describeTile } from './describe';
import { TileFrame } from './TileFrame';
import { allTiles, type Column, focusedTile, focusTile, type LayoutTile, type Workspace } from './tree';

const STACK_SIZE = 3;

export function FocusView({ layout }: { layout: Workspace }) {
  const reduced = useReducedMotionPref();
  const master = focusedTile(layout) ?? allTiles(layout)[0]?.tile ?? null;
  // Rank the other tiles by how much they deserve attention.
  const rankInputs = useData(useShallow((s) => [s.tasks, s.inbox, s.attempts, s.reviews]));
  const ranked = useMemo(() => {
    void rankInputs;
    const data = dataStore.getState();
    return allTiles(layout)
      .filter(({ tile }) => tile.id !== master?.id)
      .map(({ tile, column }, order) => {
        const meta = describeTile(data, layout.runId, tile);
        const score =
          (meta.urgent.length > 0 ? 100 : 0) +
          (meta.status?.live ? 40 : 0) +
          (tile.kind === 'review' ? 10 : 0) +
          (tile.kind === 'plan' ? 5 : 0) -
          (meta.quiet ? 30 : 0) -
          order * 0.01;
        return { tile, column, meta, score };
      })
      .sort((a, b) => b.score - a.score);
  }, [layout, master, rankInputs]);

  if (!master) return null;
  const masterColumn = layout.strip.columns.find((c) => c.tiles.some((t) => t.id === master.id)) ?? null;
  const stack = ranked.slice(0, STACK_SIZE);
  const rest = ranked.slice(STACK_SIZE);
  const focus = (tile: LayoutTile) => () => actions.updateLayout(layout.runId, (l) => focusTile(l, tile.id), true);
  const fade = reduced ? { duration: 0 } : { duration: 0.15 };

  return (
    <div
      className="grid min-h-0 flex-1 gap-[10px] p-[10px]"
      style={{ gridTemplateColumns: 'minmax(0, 1.65fr) minmax(0, 1fr)' }}
    >
      <motion.div
        key={master.id}
        className="flex min-h-0"
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
        transition={fade}
      >
        <TileFrame runId={layout.runId} tile={master} column={masterColumn} focused visible className="flex-1" />
      </motion.div>
      <div className="flex min-h-0 flex-col gap-[10px]">
        {stack.map(({ tile, column }) => (
          <StackTile key={tile.id} runId={layout.runId} tile={tile} column={column} onActivate={focus(tile)} />
        ))}
        {rest.length > 0 ? (
          <nav
            aria-label="More tiles"
            className="flex flex-none flex-wrap gap-1.5 rounded-[12px] border border-surface0 bg-mantle p-2"
          >
            {rest.map(({ tile, meta }) => (
              <button key={tile.id} type="button" className="btn btn-ghost btn-sm" onClick={focus(tile)}>
                <Dot color={toneColor(meta.urgent.length ? 'warn' : meta.tone)} live={meta.status?.live} />
                {meta.label ? <span className="tile-id">{meta.label}</span> : null}
                <span className="max-w-[140px] truncate">{meta.title}</span>
              </button>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}

function StackTile({
  runId,
  tile,
  column,
  onActivate,
}: {
  runId: string;
  tile: LayoutTile;
  column: Column;
  onActivate: () => void;
}) {
  return (
    <TileFrame
      runId={runId}
      tile={tile}
      column={column}
      focused={false}
      visible
      compact
      onActivate={onActivate}
      className="min-h-[120px] flex-1"
    />
  );
}
