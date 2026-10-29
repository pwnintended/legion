import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fitCells,
  imageProtocol,
  imageSequence,
  kittyPlace,
  kittyPlaceholder,
  pngSize,
  renderPresentation,
} from './images.ts';

// A 1×1 PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('images', () => {
  it('detects the protocol from the terminal, not inside tmux, and honours LEGION_IMAGES', () => {
    expect(imageProtocol({ TERM_PROGRAM: 'ghostty' }, true)).toBe('kitty');
    expect(imageProtocol({ TERM: 'xterm-kitty' }, true)).toBe('kitty');
    expect(imageProtocol({ TERM_PROGRAM: 'iTerm.app' }, true)).toBe('iterm');
    expect(imageProtocol({ TERM_PROGRAM: 'WezTerm' }, true)).toBe('iterm');
    expect(imageProtocol({ TERM_PROGRAM: 'Apple_Terminal' }, true)).toBeNull();
    expect(imageProtocol({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/t' }, true)).toBeNull();
    expect(imageProtocol({ TERM_PROGRAM: 'ghostty' }, false)).toBeNull();
    expect(imageProtocol({ TERM_PROGRAM: 'ghostty', LEGION_IMAGES: 'off' }, true)).toBeNull();
    expect(imageProtocol({ LEGION_IMAGES: 'iterm' }, false)).toBe('iterm');
  });

  it('reads PNG sizes and fits images into the terminal', () => {
    expect(pngSize(PIXEL)).toEqual({ width: 1, height: 1 });
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeNull();
    expect(fitCells({ width: 1600, height: 900 }, 100, 28)).toEqual({ columns: 100, rows: 28 });
    // Tall: capped by rows, narrower.
    expect(fitCells({ width: 900, height: 1600 }, 100, 28)).toEqual({ columns: 32, rows: 28 });
    expect(fitCells({ width: 80, height: 40 }, 100, 28)).toEqual({ columns: 10, rows: 3 });
  });

  it('encodes kitty images in quiet chunks and iTerm images in one sequence', () => {
    const big = Buffer.alloc(10_000, 1);
    const kitty = imageSequence('kitty', big, { columns: 10, rows: 5 });
    expect(kitty.startsWith('\u001B_Ga=T,f=100,q=2,c=10,r=5,m=1;')).toBe(true);
    expect(kitty.split('\u001B_G')).toHaveLength(5);
    expect(kitty).toContain('\u001B_Gm=0;');
    const iterm = imageSequence('iterm', PIXEL, { columns: 10, rows: 5 });
    expect(
      iterm.startsWith(`\u001B]1337;File=inline=1;size=${PIXEL.length};width=10;height=5;preserveAspectRatio=1:`),
    ).toBe(true);
  });

  it('places kitty images virtually and draws them with placeholder cells', () => {
    const place = kittyPlace(0x4c0102, Buffer.alloc(5000, 1), { columns: 3, rows: 2 });
    expect(place.startsWith('\u001B_Ga=t,f=100,i=4980994,q=2,m=1;')).toBe(true);
    expect(place).toContain('\u001B_Gm=0;');
    expect(place.endsWith('\u001B_Ga=p,U=1,i=4980994,c=3,r=2,q=2\u001B\\')).toBe(true);
    const P = String.fromCodePoint(0x10eeee);
    // The id in the colour (0x4c, 0x01, 0x02); row then column in the first cell's diacritics.
    expect(kittyPlaceholder(0x4c0102, { columns: 3, rows: 2 })).toEqual([
      `\u001B[38;2;76;1;2m${P}\u0305\u0305${P}${P}\u001B[39m`,
      `\u001B[38;2;76;1;2m${P}\u030D\u0305${P}${P}\u001B[39m`,
    ]);
  });

  it('renders images inline when it can, and a link to every item', async () => {
    dir = mkdtempSync(join(tmpdir(), 'legion-images-'));
    const png = join(dir, 'shot.png');
    writeFileSync(png, PIXEL);
    const p = {
      title: 'Body B',
      items: [
        { kind: 'image' as const, target: png, caption: 'Front view' },
        { kind: 'url' as const, target: 'http://localhost:5173/creator', caption: null },
      ],
    };
    const plain = await renderPresentation(p, { protocol: null, columns: 80 });
    expect(plain).toContain('Body B');
    expect(plain).toContain('Front view');
    expect(plain).toContain(`\u001B]8;;file://${png}\u001B\\`);
    expect(plain).toContain('\u001B]8;;http://localhost:5173/creator\u001B\\');
    expect(plain).not.toContain('\u001B_G');
    const inline = await renderPresentation(p, { protocol: 'kitty', columns: 80 });
    expect(inline).toContain('\u001B_Ga=T,f=100,q=2');
  });
});
