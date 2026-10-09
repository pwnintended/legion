/**
 * Editing `<root>/legion.json` from Settings (gates.ts, prompts.ts): read it with a revision, then replace some
 * keys, keeping every other key, the key order, the indent and the trailing newline, and refuse to overwrite a
 * file that changed since it was read. Writes of one file run one after another.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RpcError } from '@shared/rpc-transport';
import { z } from 'zod';
import { type LegionConfig, LegionConfigSchema } from '../git/provision';

export const FILE = 'legion.json';

export function legionPath(root: string): string {
  return join(root, FILE);
}

/** sha256 of the file's text. */
export function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The raw text of `<root>/legion.json`, or null when absent. */
export async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The parsed JSON object of legion.json, or a readable reason it isn't one. */
export function parseObject(raw: string): { json: Record<string, unknown> } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `${FILE}: invalid JSON (${(e as Error).message})` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: `${FILE}: not a JSON object` };
  return { json: json as Record<string, unknown> };
}

export function parseConfig(raw: string): { config: LegionConfig } | { error: string } {
  const object = parseObject(raw);
  if ('error' in object) return object;
  const parsed = LegionConfigSchema.safeParse(object.json);
  if (!parsed.success) return { error: `${FILE}: ${z.prettifyError(parsed.error)}` };
  return { config: parsed.data };
}

/** The indent of the file's first indented line (2 spaces, 4 spaces, a tab, ...), default 2 spaces. */
function detectIndent(raw: string): string | number {
  const match = /\n([ \t]+)\S/.exec(raw);
  const indent = match?.[1];
  if (!indent) return 2;
  return indent.startsWith('\t') ? '\t' : indent.length;
}

function conflict(raw: string | null): RpcError {
  return new RpcError('conflict', `${FILE} changed on disk since it was loaded; reload and try again`, {
    revision: raw === null ? null : revisionOf(raw),
  });
}

/**
 * Write `text` to `path` through a temp file in the same directory and a rename, unless the file stopped being
 * at `revision` while the temp file was written (`conflict`, and the temp file is removed).
 */
async function replaceIfUnchanged(path: string, text: string, revision: string | null): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
    const now = await readRaw(path);
    if ((now === null ? null : revisionOf(now)) !== revision) throw conflict(now);
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}

/** The write in progress per legion.json path: writes of one file run one after another. */
const writing = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (writing.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  writing.set(key, tail);
  try {
    return await run;
  } finally {
    if (writing.get(key) === tail) writing.delete(key);
  }
}

/**
 * Rewrite `<root>/legion.json` (creating it when absent) with the object `edit` returns for the current one.
 * `conflict` when the file no longer matches `revision`; `bad_request` for a file that can't be edited (not
 * JSON, or invalid after the change); `check` may throw for other problems. Nothing is written on error.
 */
export async function editLegionJson(
  root: string,
  revision: string | null,
  edit: (json: Record<string, unknown>) => Record<string, unknown>,
  check?: (config: LegionConfig) => void,
): Promise<void> {
  const path = legionPath(root);
  return serialized(path, async () => {
    const raw = await readRaw(path);
    if ((raw === null ? null : revisionOf(raw)) !== revision) throw conflict(raw);
    let json: Record<string, unknown> = {};
    if (raw !== null) {
      const object = parseObject(raw);
      if ('error' in object) throw new RpcError('bad_request', `${object.error}; fix it by hand first`);
      json = object.json;
    }
    const updated = edit(json);
    const parsed = LegionConfigSchema.safeParse(updated);
    if (!parsed.success) throw new RpcError('bad_request', `${FILE}: ${z.prettifyError(parsed.error)}`);
    check?.(parsed.data);

    const eol = raw?.includes('\r\n') ? '\r\n' : '\n';
    const trailing = raw === null ? eol : (/\r?\n$/.exec(raw)?.[0] ?? '');
    let text = JSON.stringify(updated, null, raw === null ? 2 : detectIndent(raw));
    if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
    await replaceIfUnchanged(path, text + trailing, revision);
  });
}
