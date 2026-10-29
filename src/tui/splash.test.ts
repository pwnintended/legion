import { describe, expect, it } from 'vitest';
import { shade, splash, splashSize } from './splash.ts';

describe('splash', () => {
  it('picks the largest art that fits the window', () => {
    expect(splashSize(160, 50)).toBe('large');
    expect(splashSize(100, 40)).toBe('medium');
    expect(splashSize(100, 20)).toBe('small');
    expect(splashSize(40, 40)).toBe('none');
  });

  it('stays within the width it is given, in the block ramp only', () => {
    for (const [width, size] of [
      [56, 'small'],
      [72, 'medium'],
      [200, 'medium'],
      [120, 'large'],
    ] as const) {
      const art = splash(width, size);
      expect(art.length).toBeGreaterThan(7);
      for (const line of art) {
        expect(line.length).toBeLessThanOrEqual(width);
        expect(line).toMatch(/^[ ░▒▓█]*$/);
      }
    }
  });

  it('draws the wordmark face in solid blocks', () => {
    const art = splash(80, 'small');
    // The top row of L, E, G, I, O and N.
    expect(art[0]?.trim()).toBe('██       ███████   ██████  ██████   █████   ██   ██');
  });

  it('dissolves in: nothing at 0, everything at 1', () => {
    expect(splash(100, 'medium', 0).every((l) => l === '')).toBe(true);
    const half = splash(100, 'medium', 0.5).join('').replace(/ /g, '').length;
    const full = splash(100, 'medium', 1).join('').replace(/ /g, '').length;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it('dithers between neighbouring steps of the ramp', () => {
    expect(shade(0, 0, 0)).toBe(' ');
    expect(shade(1, 0, 0)).toBe('█');
    const mixed = new Set([0, 1, 2, 3].flatMap((x) => [0, 1, 2, 3].map((y) => shade(0.6, x, y))));
    expect([...mixed].sort()).toEqual(['▒', '▓']);
  });
});
