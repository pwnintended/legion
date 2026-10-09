/**
 * A project's gate settings as Settings → Gates edits them (`projects.gates` / `projects.setGates`). legion.json
 * is the single source of truth: reading combines its `gates` and `verify` with the detected gates; writing
 * replaces only `gates` (and `verify` when given), keeping every other key, the key order, the indent and the
 * trailing newline, and refuses to overwrite a file that changed since it was read.
 */
import { GateNameSchema, type GatesConfig, GatesConfigSchema, type ProjectGates } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { z } from 'zod';
import { detectPackageManager, detectProjectGates } from '../git/detect';
import type { LegionConfig } from '../git/provision';
import { BUILTIN_GATE_NAMES, gateNameFor, resolveGateSettings, resolveGates } from '../orchestrator/core/gates';
import { editLegionJson, legionPath, parseConfig, readRaw, revisionOf } from './legion-file';

export interface WriteProjectGatesInput {
  /** The revision the caller read (`ProjectGates.revision`); null when the file was absent. */
  revision: string | null;
  /** The new `gates` key; null removes it. */
  gates: GatesConfig | null;
  /** When given, replaces `verify` (an empty list removes the key). */
  verify?: readonly string[];
}

/** The project's legion.json gates, the detected gates and the effective result. Never throws on a bad file. */
export async function readProjectGates(root: string): Promise<ProjectGates> {
  const path = legionPath(root);
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
      if (command !== null && BUILTIN_GATE_NAMES.includes(name))
        problems.push(`gate "${name}": a built-in gate's name`);
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

/**
 * Replace the `gates` key of `<root>/legion.json` (and `verify` when given), creating the file when absent.
 * `conflict` when the file no longer matches `revision`; `bad_request` for invalid input or a file that can't
 * be edited (not JSON, or invalid after the change). Nothing is written on error. Writes of one file are
 * serialized, and the revision is checked again right before the rename.
 */
export async function writeProjectGates(root: string, input: WriteProjectGatesInput): Promise<ProjectGates> {
  const next = validateInput(input);
  await editLegionJson(root, input.revision, (json) => rebuild(json, next), checkWrittenConfig);
  return readProjectGates(root);
}
