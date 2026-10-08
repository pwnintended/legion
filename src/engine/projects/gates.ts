/**
 * A project's gate settings as Settings → Gates edits them (`projects.gates` / `projects.setGates`). legion.json
 * is the single source of truth: reading combines its `gates` and `verify` with the detected gates; writing
 * replaces only `gates` (and `verify` when given), keeping every other key, the key order, the indent and the
 * trailing newline, and refuses to overwrite a file that changed since it was read.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GateNameSchema, type GatesConfig, GatesConfigSchema, type ProjectGates } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { z } from 'zod';
import { detectPackageManager, detectProjectGates } from '../git/detect';
import { type LegionConfig, LegionConfigSchema } from '../git/provision';
import { gateNameFor, resolveGateSettings, resolveGates } from '../orchestrator/core/gates';

const FILE = 'legion.json';

export interface WriteProjectGatesInput {
  /** The revision the caller read (`ProjectGates.revision`); null when the file was absent. */
  revision: string | null;
  /** The new `gates` key; null removes it. */
  gates: GatesConfig | null;
  /** When given, replaces `verify` (an empty list removes the key). */
  verify?: readonly string[];
}

/** sha256 of the file's text. */
function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The raw text of `<root>/legion.json`, or null when absent. */
async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The parsed JSON object of legion.json, or a readable reason it isn't one. */
function parseObject(raw: string): { json: Record<string, unknown> } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `${FILE}: invalid JSON (${(e as Error).message})` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: `${FILE}: not a JSON object` };
  return { json: json as Record<string, unknown> };
}

function parseConfig(raw: string): { config: LegionConfig } | { error: string } {
  const object = parseObject(raw);
  if ('error' in object) return object;
  const parsed = LegionConfigSchema.safeParse(object.json);
  if (!parsed.success) return { error: `${FILE}: ${z.prettifyError(parsed.error)}` };
  return { config: parsed.data };
}

/** The project's legion.json gates, the detected gates and the effective result. Never throws on a bad file. */
export async function readProjectGates(root: string): Promise<ProjectGates> {
  const path = join(root, FILE);
  const [raw, detected, packageManager] = await Promise.all([
    readRaw(path),
    detectProjectGates(root),
    detectPackageManager(root),
  ]);
  const parsed = raw === null ? null : parseConfig(raw);
  const config = parsed && 'config' in parsed ? parsed.config : null;
  return {
    path,
    exists: raw !== null,
    revision: raw === null ? null : revisionOf(raw),
    error: parsed && 'error' in parsed ? parsed.error : null,
    gates: config?.gates ?? null,
    verify: config?.verify ?? [],
    detected,
    packageManager,
    resolved: resolveGates({ config, detected, taskCommands: [] }),
    settings: resolveGateSettings(config),
  };
}

/** The input as written, or a `bad_request` listing every problem. */
function validateInput(input: WriteProjectGatesInput): { gates: GatesConfig | null; verify?: string[] } {
  const problems: string[] = [];
  let gates: GatesConfig | null = null;
  if (input.gates !== null) {
    for (const name of Object.keys(input.gates.commands ?? {})) {
      const result = GateNameSchema.safeParse(name);
      if (!result.success) problems.push(`gate name "${name}": ${result.error.issues[0]?.message ?? 'invalid'}`);
    }
    const parsed = GatesConfigSchema.safeParse(input.gates);
    if (parsed.success) gates = parsed.data;
    else if (problems.length === 0) problems.push(z.prettifyError(parsed.error));
    for (const [name, value] of Object.entries(input.gates.commands ?? {})) {
      const command = typeof value === 'string' ? value : value === false ? null : value?.run;
      if (command !== null && !command?.trim()) problems.push(`gate "${name}": empty command`);
    }
    const secrets = input.gates.secrets;
    if (typeof secrets === 'object' && secrets !== null) {
      if ((secrets.allow ?? []).some((glob) => !glob.trim())) problems.push('secrets.allow: empty glob');
    }
  }
  const verify = input.verify ? [...input.verify] : undefined;
  if (verify) {
    if (verify.some((command) => !command.trim())) problems.push('verify: empty command');
  }
  if (problems.length > 0) invalid(problems);
  return verify ? { gates, verify } : { gates };
}

function invalid(problems: readonly string[]): never {
  throw new RpcError('bad_request', `invalid gates: ${[...new Set(problems)].join('; ')}`);
}

/**
 * Checks over the config as written, so `verify` entries kept from the file count too: no empty or repeated
 * `verify` command, and no two gates under one name (they would run as `name` and `name-2`). One `gates.commands`
 * entry and one `verify` entry with the same name and command are fine: that command runs once.
 */
function checkWrittenConfig(config: LegionConfig): void {
  const problems: string[] = [];
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(config.gates?.commands ?? {})) {
    if (value === false) continue;
    names.set(name, (typeof value === 'string' ? value : value.run).trim());
  }
  const verified = new Set<string>();
  for (const command of config.verify ?? []) {
    const trimmed = command.trim();
    if (!trimmed) {
      problems.push('verify: empty command');
      continue;
    }
    if (verified.has(trimmed)) {
      problems.push(`verify: "${command}" is listed twice`);
      continue;
    }
    verified.add(trimmed);
    const name = gateNameFor(command);
    const taken = names.get(name);
    if (taken === undefined) names.set(name, trimmed);
    else if (taken !== trimmed) problems.push(`duplicate gate name "${name}" (verify "${command}")`);
  }
  if (problems.length > 0) invalid(problems);
}

/** The indent of the file's first indented line (2 spaces, 4 spaces, a tab, ...), default 2 spaces. */
function detectIndent(raw: string): string | number {
  const match = /\n([ \t]+)\S/.exec(raw);
  const indent = match?.[1];
  if (!indent) return 2;
  return indent.startsWith('\t') ? '\t' : indent.length;
}

/** `json` with `gates` (and `verify` when given) replaced or removed, every other key kept in place. */
function rebuild(json: Record<string, unknown>, next: { gates: GatesConfig | null; verify?: string[] }) {
  // No prototype: a `__proto__` key stays an own key instead of hitting the prototype setter.
  const out: Record<string, unknown> = Object.create(null);
  const setVerify = next.verify !== undefined;
  const keepVerify = (next.verify?.length ?? 0) > 0;
  for (const [key, value] of Object.entries(json)) {
    if (key === 'gates') {
      if (next.gates !== null) out.gates = next.gates;
    } else if (key === 'verify' && setVerify) {
      if (keepVerify) out.verify = next.verify;
    } else {
      out[key] = value;
    }
  }
  if (keepVerify && !Object.hasOwn(out, 'verify')) out.verify = next.verify;
  if (next.gates !== null && !Object.hasOwn(out, 'gates')) out.gates = next.gates;
  return out;
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
 * Replace the `gates` key of `<root>/legion.json` (and `verify` when given), creating the file when absent.
 * `conflict` when the file no longer matches `revision`; `bad_request` for invalid input or a file that can't
 * be edited (not JSON, or invalid after the change). Nothing is written on error. Writes of one file are
 * serialized, and the revision is checked again right before the rename.
 */
export async function writeProjectGates(root: string, input: WriteProjectGatesInput): Promise<ProjectGates> {
  const path = join(root, FILE);
  return serialized(path, () => writeLocked(root, path, input));
}

async function writeLocked(root: string, path: string, input: WriteProjectGatesInput): Promise<ProjectGates> {
  const raw = await readRaw(path);
  if ((raw === null ? null : revisionOf(raw)) !== input.revision) throw conflict(raw);
  const next = validateInput(input);
  let json: Record<string, unknown> = {};
  if (raw !== null) {
    const object = parseObject(raw);
    if ('error' in object) throw new RpcError('bad_request', `${object.error}; fix it by hand first`);
    json = object.json;
  }
  const updated = rebuild(json, next);
  const parsed = LegionConfigSchema.safeParse(updated);
  if (!parsed.success) throw new RpcError('bad_request', `${FILE}: ${z.prettifyError(parsed.error)}`);
  checkWrittenConfig(parsed.data);

  const eol = raw?.includes('\r\n') ? '\r\n' : '\n';
  const trailing = raw === null ? eol : (/\r?\n$/.exec(raw)?.[0] ?? '');
  let text = JSON.stringify(updated, null, raw === null ? 2 : detectIndent(raw));
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  await replaceIfUnchanged(path, text + trailing, input.revision);
  return readProjectGates(root);
}
