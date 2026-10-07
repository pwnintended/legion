/** One strip column: split / stacked / tabbed tiles, or a thin collapsed column with a vertical title. */

import { useRef } from 'react';
import { commandTooltip } from '../app/commands';
import { useAcknowledged, useTileMeta } from '../app/hooks';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { Dot, toneColor } from '../chrome/ui';
import { TileFrame, useTakeFocus } from './TileFrame';
import { type Column, focusTile, type LayoutTile, toggleCollapsed } from './tree';

interface ColumnViewProps {
  runId: string;
  column: Column;
  focusedTileId: string | null;
  visible: boolean;
}

export function ColumnView({ runId, column, focusedTileId, visible }: ColumnViewProps) {
  if (column.collapsed) {
    return <ThinColumn runId={runId} column={column} focused={column.tiles.some((t) => t.id === focusedTileId)} />;
  }
  const focusIn = (tile: LayoutTile) => () => actions.updateLayout(runId, (l) => focusTile(l, tile.id), true);

  if (column.mode === 'tabbed' && column.tiles.length > 1) {
    const active = column.tiles.find((t) => t.id === column.active) ?? (column.tiles[0] as LayoutTile);
    return (
      <div className="flex h-full min-h-0 flex-col gap-1.5">
        <div className="tabs rounded-[10px] border border-surface0 bg-mantle" role="tablist">
          {column.tiles.map((tile) => (
            <TabButton
              key={tile.id}
              runId={runId}
              tile={tile}
              selected={tile.id === active.id}
              onSelect={focusIn(tile)}
            />
          ))}
        </div>
        <TileFrame
          runId={runId}
          tile={active}
          column={column}
          focused={active.id === focusedTileId}
          visible={visible}
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-[10px]">
      {column.tiles.map((tile, index) => {
        const stackedAway = column.mode === 'stacked' && column.tiles.length > 1 && tile.id !== column.active;
        return (
          <TileFrame
            key={tile.id}
            runId={runId}
            tile={tile}
            column={column}
            focused={tile.id === focusedTileId}
            visible={visible && !stackedAway}
            collapsed={stackedAway}
            onActivate={stackedAway ? focusIn(tile) : undefined}
            // Secondary tiles of a split column (e.g. a review under its session) get a bit less height.
            style={stackedAway ? undefined : { flex: index === 0 || column.mode === 'stacked' ? 1.25 : 1 }}
          />
        );
      })}
    </div>
  );
}

function TabButton({
  runId,
  tile,
  selected,
  onSelect,
}: {
  runId: string;
  tile: LayoutTile;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = useTileMeta(runId, tile);
  return (
    <button type="button" role="tab" className="tab" aria-selected={selected} onClick={onSelect}>
      {meta.status ? (
        <Dot color={toneColor(meta.urgent.length ? 'warn' : meta.status.tone)} live={meta.status.live} />
      ) : null}
      {meta.label ? <span className="tile-id">{meta.label}</span> : null}
      {meta.title}
    </button>
  );
}

function ThinColumn({ runId, column, focused }: { runId: string; column: Column; focused: boolean }) {
  const tile = column.tiles.find((t) => t.id === column.active) ?? (column.tiles[0] as LayoutTile);
  const meta = useTileMeta(runId, tile);
  const urgentIds = meta.urgent.map((i) => i.id);
  const acknowledged = useAcknowledged(urgentIds);
  const urgent = urgentIds.length > 0;
  const merged = meta.task?.status === 'merged' || meta.status?.tone === 'ok';
  const ref = useRef<HTMLButtonElement>(null);
  useTakeFocus(ref, focused);
  const expand = () => actions.updateLayout(runId, (l) => toggleCollapsed(focusTile(l, tile.id), column.id), true);
  return (
    <section
      className="tile thin"
      aria-label={`${meta.label ?? ''} ${meta.title} (collapsed)`}
      data-tile-id={tile.id}
      data-tile-kind={tile.kind}
      data-focused={focused}
      data-urgent={urgent}
      data-pulse={urgent && !acknowledged}
      style={{ opacity: meta.quiet && !focused && !urgent && !merged ? 0.7 : undefined }}
    >
      <button
        ref={ref}
        type="button"
        className="thin-inner"
        onClick={expand}
        title={commandTooltip('column.toggleCollapse', 'Expand')}
      >
        {urgent ? (
          <Icon name="alert" size={14} style={{ color: 'var(--peach)' }} />
        ) : merged ? (
          <Icon name="check" size={14} strokeWidth={2.6} style={{ color: 'var(--green)' }} />
        ) : (
          <Dot color={toneColor(meta.tone)} live={meta.status?.live} />
        )}
        <span className="vt">
          {meta.label ? <span className="tile-id">{meta.label}</span> : null}
          <span>{meta.title}</span>
          {meta.note && meta.note !== meta.title ? <span className="faint">{meta.note}</span> : null}
        </span>
      </button>
    </section>
  );
}
