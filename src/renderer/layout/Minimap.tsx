/** Strip minimap: one pip per column (coloured by status), the viewport as an outline; click to scroll. */
import type { RefObject } from 'react';
import { useAcknowledged, useTileMeta } from '../app/hooks';
import { actions } from '../app/store';
import { toneColor } from '../chrome/ui';
import { type ColumnBox, stripContentWidth } from './geometry';
import { type Column, focusColumn, type LayoutTile, type Workspace } from './tree';

const MAX_WIDTH = 360;
const PIP_GAP = 3;

export function Minimap({
  layout,
  boxes,
  scrollLeft,
  viewport,
  scroller,
}: {
  layout: Workspace;
  boxes: ColumnBox[];
  scrollLeft: number;
  viewport: number;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const total = stripContentWidth(boxes);
  const scale = Math.min(MAX_WIDTH / Math.max(total, 1), 0.12);
  const width = Math.max(40, total * scale);
  const overflow = total > viewport + 1;
  const columns = layout.strip.columns;

  // Click a pip to focus its column; click elsewhere to scroll there. (Pointer shortcut only: the columns
  // themselves are keyboard reachable, so the minimap stays aria-hidden.)
  const jump = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left - 3) / scale;
    const hit = boxes.find((b) => x >= b.left - 5 && x <= b.left + b.width + 5);
    if (hit) actions.updateLayout(layout.runId, (l) => focusColumn(l, hit.id), true);
    else scroller.current?.scrollTo({ left: Math.max(0, x - viewport / 2), behavior: 'smooth' });
  };

  return (
    <div className="flex h-[18px] flex-none items-center justify-center px-2.5 pb-1.5" data-testid="minimap">
      <div
        className="relative flex h-[12px] cursor-pointer items-center rounded-[6px] bg-mantle px-[3px]"
        style={{ width: width + 6, gap: 0 }}
        onClick={jump}
        aria-hidden="true"
      >
        {columns.map((column, i) => {
          const box = boxes[i];
          if (!box) return null;
          return (
            <Pip
              key={column.id}
              runId={layout.runId}
              column={column}
              left={box.left * scale}
              width={Math.max(4, box.width * scale - PIP_GAP)}
              focused={layout.focus?.column === column.id}
            />
          );
        })}
        <span
          className="absolute top-[-3px] h-[16px] w-[10px] rounded-[3px] border border-dashed border-surface1"
          style={{ left: (stripContentWidth(boxes) - 120 - 10) * scale + 3, width: Math.max(4, 120 * scale) }}
        />
        {overflow ? (
          <span
            className="pointer-events-none absolute top-[-3px] h-[18px] rounded-[5px] border-[1.5px] border-subtext1 transition-[left] duration-150"
            style={{ left: scrollLeft * scale + 1, width: Math.min(width, viewport * scale) + 4 }}
          />
        ) : null}
      </div>
    </div>
  );
}

function Pip({
  runId,
  column,
  left,
  width,
  focused,
}: {
  runId: string;
  column: Column;
  left: number;
  width: number;
  focused: boolean;
}) {
  const tile = column.tiles.find((t) => t.id === column.active) ?? (column.tiles[0] as LayoutTile);
  const meta = useTileMeta(runId, tile);
  const urgentIds = meta.urgent.map((i) => i.id);
  const acknowledged = useAcknowledged(urgentIds);
  const tone = urgentIds.length > 0 ? 'warn' : column.collapsed && meta.tone === 'idle' ? 'idle' : meta.tone;
  return (
    <span
      className={`absolute h-[6px] rounded-[2px] ${urgentIds.length > 0 && !acknowledged ? 'live' : ''}`}
      title={`${meta.label ?? ''} ${meta.title}`.trim()}
      style={{
        left: left + 3,
        width,
        background: toneColor(tone),
        opacity: focused ? 1 : 0.6,
        boxShadow: focused ? '0 0 6px currentColor' : undefined,
        color: toneColor(tone),
      }}
    />
  );
}
