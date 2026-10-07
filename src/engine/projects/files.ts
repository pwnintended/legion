/**
 * Read-only file browsing of a project: directory listings and file contents from the file index (so ignored
 * files never show), fuzzy "Go to file" and `git grep` content search. Every path goes through `paths.ts`.
 */
import { lstat, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fuzzyRank } from '@shared/fuzzy';
import { imageMimeOf } from '@shared/languages';
import type { FileContent, FileEntry, FileList, FileMatch, SearchMatch, SearchResult } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { git } from '../git';
import type { FileIndexCache } from './file-index';
import { normalizeRel, resolveInside } from './paths';

export const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Bytes sniffed for a NUL to call a file binary (what git does). */
const SNIFF_BYTES = 8000;
/** Search result lines longer than this are clipped around the match. */
const MAX_LINE_CHARS = 400;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------------------------
// files.list
// ---------------------------------------------------------------------------------------------

export async function listDir(root: string, cache: FileIndexCache, dir: string): Promise<FileList> {
  const clean = normalizeRel(dir);
  const index = await cache.get(root);
  const node = index.dirs.get(clean);
  if (!node) {
    if (clean === '') return { dir: '', entries: [] };
    throw new RpcError('not_found', `${clean} is not a directory of the project`);
  }
  // The directory itself must still resolve inside the root (a symlinked parent is refused).
  await resolveInside(root, clean);
  const prefix = clean ? `${clean}/` : '';
  const dirs: FileEntry[] = [...node.dirs].map((name) => ({ name, path: prefix + name, type: 'dir', size: null }));
  const files = await Promise.all(
    node.files.map(async (name): Promise<FileEntry | null> => {
      const path = prefix + name;
      const info = await lstat(join(root, path)).catch(() => null);
      if (!info) return null;
      if (info.isSymbolicLink()) return { name, path, type: 'symlink', size: null };
      // A submodule checkout is listed by git as one path: show it as a (closed) directory.
      if (info.isDirectory()) return { name, path, type: 'dir', size: null };
      return { name, path, type: 'file', size: info.size };
    }),
  );
  const entries = [...dirs, ...files.filter((f): f is FileEntry => f !== null)].sort(
    (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || collator.compare(a.name, b.name),
  );
  return { dir: clean, entries };
}

// ---------------------------------------------------------------------------------------------
// files.read
// ---------------------------------------------------------------------------------------------

/** Decode text bytes: BOMs first, then strict UTF-8, else Latin-1. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('latin1').decode(bytes), encoding: 'latin1' };
  }
}

/** Binary = a NUL byte in the first 8000 bytes (unless it's UTF-16 with a BOM). */
export function looksBinary(bytes: Uint8Array): boolean {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readProjectFile(
  root: string,
  cache: FileIndexCache,
  path: string,
  maxBytes: number = DEFAULT_MAX_TEXT_BYTES,
): Promise<FileContent> {
  const clean = normalizeRel(path);
  if (!clean) throw new RpcError('bad_request', 'the project root is a directory');
  let index = await cache.get(root);
  // A file created a moment ago may not be in the cached index yet.
  if (!index.set.has(clean)) index = await cache.get(root, { fresh: true });
  if (!index.set.has(clean)) throw new RpcError('not_found', `${clean} is not one of the project's files`);
  const real = await resolveInside(root, clean);
  const info = await stat(real);
  if (info.isDirectory()) throw new RpcError('bad_request', `${clean} is a directory`);
  const base: FileContent = {
    path: clean,
    size: info.size,
    kind: 'binary',
    text: null,
    encoding: null,
    truncated: false,
    image: null,
  };
  const mime = imageMimeOf(clean);
  if (mime) {
    if (info.size > MAX_IMAGE_BYTES) return { ...base, kind: 'too_large' };
    const data = await readHead(real, info.size);
    return { ...base, kind: 'image', image: { mime, base64: data.toString('base64') } };
  }
  const limit = Math.max(1, Math.min(maxBytes, info.size || 1));
  let bytes: Uint8Array = await readHead(real, limit);
  if (looksBinary(bytes)) return base;
  const truncated = info.size > bytes.length;
  if (truncated) {
    // Cut at the last line end so no line (or multi-byte character) is split.
    const newline = bytes.lastIndexOf(0x0a);
    if (newline > 0) bytes = bytes.subarray(0, newline + 1);
  }
  const { text, encoding } = decodeText(bytes);
  return { ...base, kind: 'text', text, encoding, truncated };
}

// ---------------------------------------------------------------------------------------------
// files.find
// ---------------------------------------------------------------------------------------------

export async function findFiles(
  root: string,
  cache: FileIndexCache,
  query: string,
  limit: number,
): Promise<FileMatch[]> {
  const index = await cache.get(root);
  if (!query.trim()) {
    // Nothing typed yet: the shallowest files (README, package.json, ...).
    return [...index.files]
      .sort((a, b) => a.split('/').length - b.split('/').length || collator.compare(a, b))
      .slice(0, limit)
      .map((path) => ({ path, score: 0, positions: [] }));
  }
  return fuzzyRank(query, index.files, limit);
}

// ---------------------------------------------------------------------------------------------
// files.search
// ---------------------------------------------------------------------------------------------

/** Parse `git grep -n --column -z` output: `path\0line\0column\0text` per line. */
export function parseGrepZ(output: string): { path: string; line: number; column: number; text: string }[] {
  const out: { path: string; line: number; column: number; text: string }[] = [];
  for (const record of output.split('\n')) {
    if (!record) continue;
    const a = record.indexOf('\0');
    const b = a === -1 ? -1 : record.indexOf('\0', a + 1);
    const c = b === -1 ? -1 : record.indexOf('\0', b + 1);
    if (c === -1) continue;
    const line = Number(record.slice(a + 1, b));
    const column = Number(record.slice(b + 1, c));
    if (!Number.isInteger(line) || line < 1) continue;
    out.push({
      path: record.slice(0, a),
      line,
      column: Number.isInteger(column) && column > 0 ? column : 1,
      text: record.slice(c + 1),
    });
  }
  return out;
}

/** Long lines are clipped to a window around the match. Columns from git are 1-based byte offsets. */
export function clipLine(text: string, byteColumn: number): { text: string; column: number; clipStart: number } {
  const clean = text.replace(/\r$/, '');
  // git reports bytes; convert to a character column.
  const prefix = Buffer.from(clean, 'utf8').subarray(0, Math.max(0, byteColumn - 1));
  const column = prefix.toString('utf8').length + 1;
  if (clean.length <= MAX_LINE_CHARS) return { text: clean, column, clipStart: 0 };
  const start = Math.max(0, Math.min(column - 1 - 80, clean.length - MAX_LINE_CHARS));
  return { text: clean.slice(start, start + MAX_LINE_CHARS), column, clipStart: start };
}

export interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  limit: number;
}

export async function searchFiles(root: string, options: SearchOptions): Promise<SearchResult> {
  if (options.query.includes('\n')) throw new RpcError('bad_request', 'search one line at a time');
  const args = [
    'grep',
    '-n',
    '-I',
    '--column',
    '-z',
    '--untracked',
    '--full-name',
    '--no-color',
    ...(options.caseSensitive ? [] : ['-i']),
    options.regex ? '-E' : '-F',
    '-e',
    options.query,
    '--',
  ];
  // Exit 1 = no matches; 128 = a bad pattern (reported as such).
  const result = await git(root, args, { okExitCodes: [0, 1, 128], timeoutMs: 20_000 });
  if (result.exitCode === 128) {
    throw new RpcError('bad_request', result.stderr.replace(/^fatal:\s*/m, '').trim() || 'invalid search pattern');
  }
  const parsed = parseGrepZ(result.stdout);
  const matches: SearchMatch[] = parsed.slice(0, options.limit).map((m) => {
    const clipped = clipLine(m.text, m.column);
    return { path: m.path, line: m.line, column: clipped.column, text: clipped.text, clipStart: clipped.clipStart };
  });
  return {
    matches,
    truncated: parsed.length > options.limit,
    fileCount: new Set(matches.map((m) => m.path)).size,
  };
}
