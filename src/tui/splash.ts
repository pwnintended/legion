/**
 * The startup art: the LEGION wordmark, extruded, in front of a striped sun rising over a perspective grid. It is
 * drawn as a brightness field and shaded with the block ramp ` ░▒▓█` by ordered (Bayer) dithering, so it is one
 * color and sized to the window. `reveal` (0–1) dissolves it in along the same dither pattern.
 */

/** A 7-row bitmap font, two columns per vertical stroke (terminal cells are about twice as tall as wide). */
const FONT: Record<string, string[]> = {
  L: ['##     ', '##     ', '##     ', '##     ', '##     ', '##     ', '#######'],
  E: ['#######', '##     ', '##     ', '###### ', '##     ', '##     ', '#######'],
  G: [' ######', '##     ', '##     ', '##  ###', '##   ##', '##   ##', ' ######'],
  I: ['######', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '######'],
  O: [' ##### ', '##   ##', '##   ##', '##   ##', '##   ##', '##   ##', ' ##### '],
  N: ['##   ##', '###  ##', '#### ##', '## ####', '##  ###', '##   ##', '##   ##'],
};
const WORD = 'LEGION';
const GLYPH_ROWS = 7;
const GAP = 2;

const RAMP = [' ', '░', '▒', '▓', '█'];
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** The Bayer threshold of a cell, in (0, 1). */
function threshold(x: number, y: number): number {
  return ((BAYER[y & 3]?.[x & 3] ?? 0) + 0.5) / 16;
}

/** Brightness 0–1 shaded with the ramp, dithered between neighbouring steps. */
export function shade(v: number, x: number, y: number): string {
  const steps = RAMP.length - 1;
  const t = Math.max(0, Math.min(1, v)) * steps;
  const base = Math.floor(t);
  const level = base >= steps ? steps : t - base > threshold(x, y) ? base + 1 : base;
  return RAMP[level] ?? ' ';
}

/** The wordmark as a mask, `scale` cells per font pixel. */
function wordmark(scale: number): boolean[][] {
  const glyphs = [...WORD].map((c) => FONT[c] ?? []);
  const cols = glyphs.reduce((n, g) => n + (g[0]?.length ?? 0), 0) + GAP * (glyphs.length - 1);
  const mask: boolean[][] = [];
  for (let y = 0; y < GLYPH_ROWS * scale; y++) {
    const row: boolean[] = [];
    for (const [i, g] of glyphs.entries()) {
      if (i > 0) for (let k = 0; k < GAP * scale; k++) row.push(false);
      const line = g[Math.floor(y / scale)] ?? '';
      for (let x = 0; x < line.length * scale; x++) row.push(line[Math.floor(x / scale)] === '#');
    }
    mask.push(row.length === cols * scale ? row : row.slice(0, cols * scale));
  }
  return mask;
}

/** A stable pseudo-random value in [0, 1) per cell. */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export type SplashSize = 'large' | 'medium' | 'small' | 'none';

/** The largest art that fits `width` × `height` cells. */
export function splashSize(width: number, height: number): SplashSize {
  if (width >= 120 && height >= 44) return 'large';
  if (width >= 72 && height >= 30) return 'medium';
  if (width >= 56 && height >= 16) return 'small';
  return 'none';
}

/**
 * The art, one string per row, at most `width` columns wide. `small` is the extruded wordmark alone; `medium` and
 * `large` stand it on a horizon under a few stars, reflected in dark water (`large` at twice the size).
 */
export function splash(width: number, size: SplashSize, reveal = 1): string[] {
  if (size === 'none') return [];
  const scale = size === 'large' ? 2 : 1;
  const word = wordmark(scale);
  const wordW = word[0]?.length ?? 0;
  const wordH = word.length;
  const scenic = size !== 'small';
  const W = scenic ? Math.min(width, wordW + 36 * scale) : wordW + 2 * scale;
  const sky = scenic ? 2 * scale : 0;
  const top = sky;
  const left = Math.floor((W - wordW - scale) / 2);
  const horizon = top + wordH + 1;
  const water = scenic ? Math.ceil(wordH * 0.6) : 0;
  const H = scenic ? horizon + 1 + water : top + wordH + 1;
  const cx = (W - 1) / 2;

  const inWord = (x: number, y: number) => word[y - top]?.[x - left] === true;
  // The extrusion: the wordmark pushed down and to the right, behind the face.
  const inDepth = (x: number, y: number) => {
    for (let d = 1; d <= scale; d++) if (inWord(x - scale * d, y - d)) return d;
    return 0;
  };
  /** The wordmark as it stands, face and extrusion; 0 off it. */
  const solid = (x: number, y: number): number => {
    if (inWord(x, y)) {
      // Lit from above; at twice the size the base of each letter dithers into shadow.
      const v = (y - top) / Math.max(1, wordH - 1);
      return scale === 1 ? 1 : 1.04 - v * v * 0.24;
    }
    const d = inDepth(x, y);
    return d === 1 ? 0.5 : d ? 0.25 : 0;
  };

  const brightness = (x: number, y: number): number => {
    if (y < horizon) {
      const v = solid(x, y);
      if (v || !scenic) return v;
      return hash(x, y) > 0.988 && y < top + wordH / 2 ? 0.28 : 0;
    }
    // Fades out to the left and right, so the scene has no hard edge.
    const edge = Math.max(0, Math.min(1, (Math.min(x + 1, W - x) / W) * 3.2));
    if (y === horizon) return 0.62 * edge;
    // The reflection: the wordmark upside down and squashed, rippled sideways, fading with depth.
    const z = y - horizon;
    const fade = 1 - (z - 1) / water;
    const ripple = Math.round(Math.sin(z * 1.9 + 0.6) * scale);
    const source = horizon - 1 - Math.floor((z - 1) * 1.6 + 0.5);
    const mirrored = solid(x - ripple, source);
    const glow = 0.06 * fade * edge * (1 - Math.abs(x - cx) / W);
    return mirrored ? mirrored * (0.16 + 0.38 * fade) : glow;
  };

  const lines: string[] = [];
  for (let y = 0; y < H; y++) {
    let line = '';
    for (let x = 0; x < W; x++) {
      // The dissolve: a cell appears once `reveal` passes its threshold, the centre slightly first.
      const order = threshold(x, y) * 0.7 + (Math.abs(x - cx) / W) * 0.6;
      line += reveal >= 1 || order < reveal * 1.3 ? shade(brightness(x, y), x, y) : ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
