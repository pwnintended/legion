/**
 * Strip mode (niri-style): a horizontally scrollable strip of columns. Focus changes scroll the focused column
 * into view (minimal movement); columns slide with critically damped springs (position only — widths snap, so
 * terminals are never resized per frame); off-screen columns beyond ±1 viewport render as light placeholders.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { commandTooltip, executeCommand } from '../app/commands';
import { useData } from '../app/hooks';
import { Icon } from '../chrome/icons';
import { DURATION_OPEN_MS, SPRING } from '../theme/motion';
import { ColumnView } from './ColumnView';
import { layoutColumns, STRIP_GAP, STRIP_PAD, scrollTargetFor, stripContentWidth, visibleRange } from './geometry';
import { Minimap } from './Minimap';
import type { Workspace } from './tree';

export function StripView({ layout }: { layout: Workspace }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(1200);
  const [scrollLeft, setScrollLeft] = useState(0);
  const reduced = useReducedMotion() ?? false;
  const columns = layout.strip.columns;
  const boxes = useMemo(
    () => layoutColumns(columns, viewport, layout.maximized),
    [columns, viewport, layout.maximized],
  );
  const range = visibleRange(boxes, scrollLeft, viewport, 1);
  const onScreen = visibleRange(boxes, scrollLeft, viewport, 0);
  // Gate rendering on the data being there (avoids a flash of empty frames on first load).
  const ready = useData((s) => s.loadedRuns[layout.runId] !== undefined);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      if (el) setScrollLeft(el.scrollLeft);
    });
  }, []);

  // Reveal the focused column (and re-reveal when widths change, e.g. maximize).
  const focusedColumn = layout.focus?.column ?? null;
  const focusedBox = boxes.find((b) => b.id === focusedColumn);
  const targetKey = focusedBox ? `${focusedBox.id}:${focusedBox.left}:${focusedBox.width}:${viewport}` : null;
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetKey captures the box geometry.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !focusedBox) return;
    const target = scrollTargetFor(focusedBox, el.scrollLeft, el.clientWidth);
    if (target !== null) el.scrollTo({ left: target, behavior: reduced || first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [targetKey, reduced]);

  // Vertical wheel over gaps/headers scrolls the strip sideways (tile bodies keep their own scrolling).
  const onWheel = useCallback((event: React.WheelEvent) => {
    const el = scroller.current;
    if (!el || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if ((event.target as Element).closest('[data-tile-body]')) return;
    el.scrollLeft += event.deltaY;
  }, []);

  const transition = reduced ? { duration: 0 } : SPRING;
  const enter = reduced
    ? { duration: 0 }
    : { duration: DURATION_OPEN_MS / 1000, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="strip relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
        onScroll={onScroll}
        onWheel={onWheel}
      >
        <div
          className="strip-track flex h-full"
          style={{
            width: stripContentWidth(boxes),
            gap: STRIP_GAP,
            padding: `${STRIP_PAD}px ${STRIP_PAD}px 6px`,
            boxSizing: 'border-box',
          }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {ready &&
              columns.map((column, index) => {
                const box = boxes[index];
                const width = box?.width ?? 400;
                const inRange = index >= range.first && index <= range.last;
                const visible = index >= onScreen.first && index <= onScreen.last;
                return (
                  <motion.div
                    key={column.id}
                    data-column={column.id}
                    layout="position"
                    className="strip-col h-full flex-none"
                    style={{ width }}
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1, transition: enter }}
                    exit={{ opacity: 0, scale: 0.94, transition: { duration: reduced ? 0 : 0.15 } }}
                    transition={transition}
                  >
                    {inRange ? (
                      <ColumnView
                        runId={layout.runId}
                        column={column}
                        focusedTileId={layout.focus?.tile ?? null}
                        visible={visible}
                      />
                    ) : (
                      <div className="placeholder h-full" aria-hidden="true" />
                    )}
                  </motion.div>
                );
              })}
          </AnimatePresence>
          <motion.button
            layout="position"
            transition={transition}
            type="button"
            className="ghost h-full"
            onClick={() => void executeCommand('tile.newTerminal')}
            title={commandTooltip('tile.newTerminal', 'Open a terminal')}
          >
            <Icon name="plus" size={18} />
            New terminal
          </motion.button>
        </div>
      </div>
      <Minimap layout={layout} boxes={boxes} scrollLeft={scrollLeft} viewport={viewport} scroller={scroller} />
    </div>
  );
}
