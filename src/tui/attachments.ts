/**
 * Images the user attaches to a message: a screenshot on the clipboard (Ctrl+V), or image files pasted or dropped
 * onto the prompt as paths. Each is kept as a PNG under `.legion/session/attachments/` (scaled down when huge), and
 * the engines get it as an image input next to the message's text.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { loadPng, pngSize } from './images.ts';

export interface Attachment {
  /** `Image #n`, counted over the session. */
  n: number;
  /** The PNG, absolute. */
  path: string;
  width: number;
  height: number;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tif', '.tiff', '.bmp']);

/**
 * The image files `text` names, when it is nothing but paths to existing images (what a terminal pastes for
 * files dropped on it: shell-escaped or quoted, separated by spaces or new lines). Null for anything else.
 */
export function imagePaths(text: string, cwd = process.cwd()): string[] | null {
  const words = splitPaths(text.trim());
  if (words.length === 0) return null;
  const paths: string[] = [];
  for (const word of words) {
    let path = word.startsWith('file://') ? decodeURIComponent(word.slice('file://'.length)) : word;
    if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
    path = resolve(cwd, path);
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return null;
    try {
      if (!statSync(path).isFile()) return null;
    } catch {
      return null;
    }
    paths.push(path);
  }
  return paths;
}

/** Shell-like words: backslash escapes, single and double quotes. */
function splitPaths(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) return [];
  if (started) words.push(word);
  return words;
}

/** The image on the clipboard as PNG bytes, or null (no image, or no way to read it here). */
export async function clipboardImage(): Promise<Buffer | null> {
  if (process.platform === 'darwin') {
    const dir = await mkdtemp(join(tmpdir(), 'legion-clip-'));
    const out = join(dir, 'clipboard.png');
    try {
      await run('osascript', [
        '-e',
        `set f to open for access POSIX file ${appleScriptString(out)} with write permission`,
        '-e',
        'try',
        '-e',
        'write (the clipboard as «class PNGf») to f',
        '-e',
        'end try',
        '-e',
        'close access f',
      ]);
      const png = await readFile(out);
      return png.length > 0 ? png : null;
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (process.platform === 'linux') {
    for (const [cmd, args] of [
      ['wl-paste', ['--no-newline', '--type', 'image/png']],
      ['xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out']],
    ] as const) {
      const png = await run(cmd, [...args]).catch(() => null);
      if (png && pngSize(png)) return png;
    }
  }
  return null;
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10_000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

/**
 * Keeps an image for the session as `<dir>/<n>.png`: converted to PNG if it is not one, and scaled down when it is
 * bigger than the engines take as it is (where `sips` can, else as it came). Null when it cannot be read as an image.
 */
export async function saveAttachment(dir: string, n: number, source: Buffer | string): Promise<Attachment | null> {
  let png = typeof source === 'string' ? await loadPng(source) : source;
  if (!png || !pngSize(png)) return null;
  mkdirSync(dir, { recursive: true });
  if (!fitsAsIs(png)) {
    const raw = join(dir, `${n}.original.png`);
    writeFileSync(raw, png);
    png = (await loadPng(raw, { scale: true })) ?? png;
    rmSync(raw, { force: true });
  }
  const size = pngSize(png);
  if (!size) return null;
  let path = join(dir, `${n}.png`);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${n}-${i}.png`);
  writeFileSync(path, png);
  return { n, path, ...size };
}

/** Within what the engines take without scaling (no side over 1600 px, at most 3 MB). */
function fitsAsIs(png: Buffer): boolean {
  const size = pngSize(png);
  return size !== null && Math.max(size.width, size.height) <= 1600 && png.length <= 3 * 1024 * 1024;
}

/** What the model reads next to the images: where each one is kept, so it can hand them on (a lead, `present`). */
export function attachmentNote(attachments: readonly Attachment[]): string {
  return attachments.map((a) => `[Image #${a.n}: ${a.path}]`).join('\n');
}
