/** Pixel geometry of the strip: preset widths, column offsets, scroll-into-view and virtualization windows. */
import { type Column, effectiveWidth, type WidthPreset } from './tree';

export const STRIP_GAP = 10;
export const STRIP_PAD = 10;
export const THIN_WIDTH = 44;
export const MIN_COLUMN_WIDTH = 300;
export const GHOST_WIDTH = 120;

/** Width in px of a preset inside a strip viewport of `viewport` px. */
export function presetWidth(preset: WidthPreset, viewport: number): number {
  if (preset === 'thin') return THIN_WIDTH;
  const inner = Math.max(0, viewport - 2 * STRIP_PAD);
  const third = (inner - 2 * STRIP_GAP) / 3;
  const px =
    preset === 'full'
      ? inner
      : preset === '1/2'
        ? (inner - STRIP_GAP) / 2
        : preset === '1/3'
          ? third
          : 2 * third + STRIP_GAP;
  return Math.max(MIN_COLUMN_WIDTH, Math.floor(px));
}

export interface ColumnBox {
  id: string;
  left: number;
  width: number;
}

/** Column boxes in strip coordinates (left includes the leading padding). */
export function layoutColumns(columns: readonly Column[], viewport: number, maximized: string | null): ColumnBox[] {
  let x = STRIP_PAD;
  return columns.map((column) => {
    const width =
      maximized === column.id ? presetWidth('full', viewport) : presetWidth(effectiveWidth(column), viewport);
    const box = { id: column.id, left: x, width };
    x += width + STRIP_GAP;
    return box;
  });
}

export function stripContentWidth(boxes: readonly ColumnBox[]): number {
  const last = boxes.at(-1);
  return (last ? last.left + last.width + STRIP_GAP : STRIP_PAD) + GHOST_WIDTH + STRIP_PAD;
}

/**
 * Where to scroll so `box` is fully visible, moving as little as possible (niri: never scroll when the column
 * is already in view). Columns wider than the viewport align left. Returns null when no scroll is needed.
 */
export function scrollTargetFor(box: ColumnBox, scrollLeft: number, viewport: number): number | null {
  const left = box.left - STRIP_PAD;
  const right = box.left + box.width + STRIP_PAD;
  if (box.width + 2 * STRIP_PAD >= viewport) return Math.abs(scrollLeft - left) < 1 ? null : Math.max(0, left);
  if (left < scrollLeft) return Math.max(0, left);
  if (right > scrollLeft + viewport) return right - viewport;
  return null;
}

/** Indexes of columns that intersect the viewport extended by `overscan` viewports on each side. */
export function visibleRange(
  boxes: readonly ColumnBox[],
  scrollLeft: number,
  viewport: number,
  overscan = 1,
): { first: number; last: number } {
  const from = scrollLeft - overscan * viewport;
  const to = scrollLeft + viewport + overscan * viewport;
  let first = -1;
  let last = -1;
  boxes.forEach((box, index) => {
    if (box.left + box.width >= from && box.left <= to) {
      if (first === -1) first = index;
      last = index;
    }
  });
  return { first, last };
}
