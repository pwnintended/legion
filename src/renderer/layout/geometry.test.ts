import { describe, expect, it } from 'vitest';
import {
  layoutColumns,
  presetWidth,
  revealTarget,
  scrollTargetFor,
  stripContentWidth,
  THIN_WIDTH,
  visibleRange,
} from './geometry';
import { type Column, makeColumn } from './tree';

const column = (id: string, width: Column['width'], collapsed = false): Column => ({
  ...makeColumn({ id, width, tiles: [{ id: `${id}-t`, kind: 'dag', params: {}, auto: true }] }),
  collapsed,
});

describe('geometry', () => {
  it('computes preset widths inside the padded viewport', () => {
    expect(presetWidth('full', 1220)).toBe(1200);
    expect(presetWidth('1/2', 1220)).toBe(595);
    expect(presetWidth('1/3', 1220)).toBe(393);
    expect(presetWidth('2/3', 1220)).toBe(796);
    expect(presetWidth('thin', 1220)).toBe(THIN_WIDTH);
    expect(presetWidth('1/3', 500)).toBe(300);
  });

  it('lays columns out with gaps, honouring collapse and maximize', () => {
    const boxes = layoutColumns([column('a', '1/3'), column('b', '1/2', true), column('c', '1/2')], 1220, null);
    expect(boxes.map((b) => [b.left, b.width])).toEqual([
      [10, 393],
      [413, 44],
      [467, 595],
    ]);
    expect(stripContentWidth(boxes)).toBe(467 + 595 + 10 + 120 + 10);
    expect(layoutColumns([column('a', '1/3')], 1220, 'a')[0]?.width).toBe(1200);
  });

  it('scrolls minimally to reveal a column', () => {
    const box = { id: 'x', left: 1000, width: 400 };
    expect(scrollTargetFor(box, 0, 1220)).toBe(1000 + 400 + 10 - 1220);
    expect(scrollTargetFor(box, 600, 1220)).toBeNull();
    expect(scrollTargetFor(box, 1200, 1220)).toBe(990);
    expect(scrollTargetFor({ id: 'w', left: 500, width: 1300 }, 0, 1220)).toBe(490);
    expect(scrollTargetFor({ id: 'w', left: 500, width: 1300 }, 490, 1220)).toBeNull();
  });

  it('reveals relative to where an in-flight smooth scroll will land', () => {
    const viewport = 1000;
    const contentWidth = 4000;
    const box = { id: 'x', left: 1200, width: 300 };
    // At rest: minimal scroll, or nothing when the column is in view.
    expect(revealTarget(box, { scrollLeft: 0, pending: null, viewport, contentWidth })).toBe(1200 + 300 + 10 - 1000);
    expect(revealTarget(box, { scrollLeft: 800, pending: null, viewport, contentWidth })).toBeNull();
    // Mid-flight towards 2400 the column happens to be on screen at 800, but the scroll would cut it off at
    // 2400: retarget from the destination instead of leaving the old scroll running.
    expect(revealTarget(box, { scrollLeft: 800, pending: 2400, viewport, contentWidth })).toBe(1190);
    // The destination already shows the column: keep going there.
    expect(revealTarget(box, { scrollLeft: 300, pending: 600, viewport, contentWidth })).toBe(600);
    // Clamped to the scrollable range.
    const last = { id: 'z', left: 3700, width: 290 };
    expect(revealTarget(last, { scrollLeft: 0, pending: null, viewport, contentWidth })).toBe(3000);
    // Wider than the viewport: align its left edge.
    const wide = { id: 'w', left: 500, width: 1300 };
    expect(revealTarget(wide, { scrollLeft: 0, pending: null, viewport, contentWidth })).toBe(490);
    expect(revealTarget(wide, { scrollLeft: 900, pending: 2000, viewport, contentWidth })).toBe(490);
  });

  it('finds the columns to render around the viewport', () => {
    const boxes = Array.from({ length: 10 }, (_, i) => ({ id: String(i), left: i * 600, width: 590 }));
    expect(visibleRange(boxes, 0, 1200, 0)).toEqual({ first: 0, last: 2 });
    expect(visibleRange(boxes, 3000, 1200, 1)).toEqual({ first: 3, last: 9 });
    expect(visibleRange(boxes, 3000, 1200, 0.5)).toEqual({ first: 4, last: 8 });
  });
});
