/**
 * Showing things to the user in the terminal: images inline where the terminal can draw them (the kitty graphics
 * protocol: kitty, Ghostty; the iTerm2 protocol: iTerm2, WezTerm), and a clickable link (OSC 8) to every file or
 * page either way. `LEGION_IMAGES=kitty|iterm|off` overrides the detection.
 */
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Presentation, PresentedItem } from '../team/team.ts';

export type ImageProtocol = 'kitty' | 'iterm';

/** The inline-image protocol this terminal speaks, or null (links only). Not inside tmux/screen. */
export function imageProtocol(
  env: NodeJS.ProcessEnv = process.env,
  isTty = process.stdout.isTTY,
): ImageProtocol | null {
  const forced = env.LEGION_IMAGES?.toLowerCase();
  if (forced === 'kitty' || forced === 'iterm') return forced;
  if (forced === 'off' || !isTty) return null;
  if (env.TMUX || env.STY) return null;
  const program = env.TERM_PROGRAM ?? '';
  const term = env.TERM ?? '';
  if (/ghostty/i.test(program) || term === 'xterm-ghostty' || term === 'xterm-kitty' || env.KITTY_WINDOW_ID) {
    return 'kitty';
  }
  if (program === 'iTerm.app' || program === 'WezTerm' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return null;
}

/** Width and height of a PNG from its header, or null. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Cells for an image: as wide as fits, no taller than `maxRows` (a cell is about twice as tall as wide). */
export function fitCells(
  size: { width: number; height: number },
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  const ratio = size.height / Math.max(1, size.width);
  let columns = Math.max(1, Math.min(maxColumns, Math.ceil(size.width / 8)));
  let rows = Math.max(1, Math.round((ratio * columns) / 2));
  if (rows > maxRows) {
    rows = maxRows;
    columns = Math.max(1, Math.round((rows * 2) / ratio));
  }
  return { columns, rows };
}

const MAX_PNG_BYTES = 3 * 1024 * 1024;
const MAX_SIDE = 1600;

/**
 * The image as PNG bytes small enough to send: PNGs as they are, anything else (or a huge PNG) converted and
 * scaled down with macOS `sips`. Null when that is not possible (the link still shows).
 */
export async function loadPng(path: string): Promise<Buffer | null> {
  try {
    if (extname(path).toLowerCase() === '.png' && statSync(path).size <= MAX_PNG_BYTES) return readFileSync(path);
  } catch {
    return null;
  }
  if (process.platform !== 'darwin') return null;
  const dir = await mkdtemp(join(tmpdir(), 'legion-img-'));
  const out = join(dir, 'image.png');
  const sips = (args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile('sips', args, { timeout: 15_000 }, (err) => (err ? reject(err) : resolve())),
    );
  try {
    await sips(['-s', 'format', 'png', path, '--out', out]);
    let png = await readFile(out);
    const size = pngSize(png);
    // `-Z` scales up as well as down: only shrink.
    if (size && Math.max(size.width, size.height) > MAX_SIDE) {
      await sips(['-Z', String(MAX_SIDE), out]);
      png = await readFile(out);
    }
    return png;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ESC = '\u001B';

/** The escape sequence that draws `png` at the cursor, `cells` big. The terminal is told not to reply. */
export function imageSequence(protocol: ImageProtocol, png: Buffer, cells: { columns: number; rows: number }): string {
  const data = png.toString('base64');
  if (protocol === 'iterm') {
    return `${ESC}]1337;File=inline=1;size=${png.length};width=${cells.columns};height=${cells.rows};preserveAspectRatio=1:${data}\u0007`;
  }
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 4096) chunks.push(data.slice(i, i + 4096));
  return chunks
    .map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0;
      const head = i === 0 ? `a=T,f=100,q=2,c=${cells.columns},r=${cells.rows},m=${more}` : `m=${more}`;
      return `${ESC}_G${head};${chunk}${ESC}\\`;
    })
    .join('');
}

/** A clickable link (OSC 8); terminals without them show the text. */
export function hyperlink(url: string, text: string): string {
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

export function linkTarget(item: PresentedItem): string {
  return item.kind === 'url' ? item.target : pathToFileURL(item.target).href;
}

const style = {
  bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
  dim: (s: string) => `${ESC}[2m${s}${ESC}[22m`,
  accent: (s: string) => `${ESC}[38;2;167;139;250m${s}${ESC}[39m`,
  link: (s: string) => `${ESC}[4m${ESC}[38;2;96;165;250m${s}${ESC}[39m${ESC}[24m`,
};

/**
 * The presentation as terminal output: its title, then per item the caption, the image (when the terminal can
 * draw it) and a link to open it. `show` shortens paths for display.
 */
export async function renderPresentation(
  p: Presentation,
  opts: { protocol: ImageProtocol | null; columns: number; maxRows?: number; show?: (path: string) => string },
): Promise<string> {
  const show = opts.show ?? ((s: string) => s);
  const out: string[] = ['', `${style.accent('◆')} ${style.bold(p.title)}`];
  for (const item of p.items) {
    if (item.caption) out.push(`  ${item.caption}`);
    if (item.kind === 'image' && opts.protocol) {
      const png = await loadPng(item.target);
      const size = png ? pngSize(png) : null;
      if (png && size) {
        const cells = fitCells(size, Math.max(10, Math.min(opts.columns - 4, 120)), opts.maxRows ?? 28);
        out.push(`  ${imageSequence(opts.protocol, png, cells)}`);
      }
    }
    const label = item.kind === 'url' ? item.target : show(item.target);
    out.push(`  ${style.dim('⎿')} ${style.link(hyperlink(linkTarget(item), label))}`);
  }
  return `${out.join('\n')}\n`;
}
