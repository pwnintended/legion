/**
 * Pure helpers for Settings → Gates: the editable form behind a project's legion.json `gates` (and legacy
 * `verify`), its validation, and turning it back into the config `projects.setGates` writes. Keys the user
 * didn't touch keep their original shape (`"test": "pnpm test"` stays a string, `secrets: "warn"` stays bare),
 * so loading and saving without edits writes back exactly what was there.
 */
import { gateNameFor, resolveGates } from '@engine/orchestrator/core/gates';
import {
  type GateCommandConfig,
  GateNameSchema,
  type GateScopeMode,
  type GateSpec,
  type GatesConfig,
  type ProjectGates,
  type SecretScanMode,
} from '@shared/domain';

/** One `gates.commands` entry: a command gate, or (`off`) a suppressed name (`"lint": false`). */
export interface CommandRow {
  /** Stable key for the list (names change while renaming). */
  id: string;
  name: string;
  run: string;
  blocking: boolean;
  off: boolean;
  /** The value as loaded, written back as is while the row is unchanged; null for new rows. */
  raw: GateCommandConfig | null;
}

export interface GlobRow {
  id: string;
  glob: string;
}

export interface GatesForm {
  /** The loaded `gates` and `verify`, to keep untouched keys in their original shape. */
  base: GatesConfig | null;
  baseVerify: string[];
  detect: boolean;
  commands: CommandRow[];
  /** Legacy `verify` commands still in legion.json. */
  verify: string[];
  scope: GateScopeMode;
  secretsMode: SecretScanMode;
  allow: GlobRow[];
  /** Next row id. */
  seq: number;
}

export interface GatesFormErrors {
  /** Per command row id. */
  commands: Record<string, { name?: string; run?: string }>;
  /** Per allowlist row id. */
  allow: Record<string, string>;
}

/** What `projects.setGates` takes besides the project and revision. */
export interface GatesSave {
  gates: GatesConfig | null;
  /** Only when the verify list changed (an entry was moved or removed). */
  verify?: string[];
}

function rowOf(id: string, name: string, value: GateCommandConfig): CommandRow {
  if (value === false) return { id, name, run: '', blocking: true, off: true, raw: value };
  if (typeof value === 'string') return { id, name, run: value, blocking: true, off: false, raw: value };
  return { id, name, run: value.run, blocking: value.blocking ?? true, off: false, raw: value };
}

export function formFromProjectGates(project: Pick<ProjectGates, 'gates' | 'verify' | 'settings'>): GatesForm {
  let seq = 0;
  const next = () => `g${++seq}`;
  const gates = project.gates;
  const commands = Object.entries(gates?.commands ?? {}).map(([name, value]) => rowOf(next(), name, value));
  const allow = project.settings.secrets.allow.map((glob) => ({ id: next(), glob }));
  return {
    base: gates,
    baseVerify: [...project.verify],
    detect: project.settings.detect,
    commands,
    verify: [...project.verify],
    scope: project.settings.scope,
    secretsMode: project.settings.secrets.mode,
    allow,
    seq,
  };
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/** `base`, or `base-2`, `base-3`, ... when a gate of `form` already has that name. */
function freeName(form: GatesForm, base: string): string {
  const taken = new Set(form.commands.map((c) => c.name.trim()));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function withRow(form: GatesForm, row: Omit<CommandRow, 'id'>): GatesForm {
  const seq = form.seq + 1;
  return { ...form, seq, commands: [...form.commands, { ...row, id: `g${seq}` }] };
}

/** A new, empty blocking command gate (to be named and filled in). */
export function addCommand(form: GatesForm): GatesForm {
  return withRow(form, { name: '', run: '', blocking: true, off: false, raw: null });
}

/** Rename, edit the command or flip `blocking` of one row. */
export function updateCommand(
  form: GatesForm,
  id: string,
  patch: Partial<Pick<CommandRow, 'name' | 'run' | 'blocking'>>,
): GatesForm {
  return { ...form, commands: form.commands.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function removeCommand(form: GatesForm, id: string): GatesForm {
  return { ...form, commands: form.commands.filter((c) => c.id !== id) };
}

/** Suppress a (detected) gate name: `"name": false`. */
export function suppressGate(form: GatesForm, name: string): GatesForm {
  if (form.commands.some((c) => c.off && c.name.trim() === name)) return form;
  return withRow(form, { name, run: '', blocking: true, off: true, raw: null });
}

/** Undo a suppression: drop the `"name": false` entry. */
export function restoreGate(form: GatesForm, name: string): GatesForm {
  return { ...form, commands: form.commands.filter((c) => !(c.off && c.name.trim() === name)) };
}

/** Move `verify[index]` into `gates.commands`, named like the engine names it (`pnpm test` → `test`). */
export function moveVerify(form: GatesForm, index: number, name?: string): GatesForm {
  const command = form.verify[index];
  if (command === undefined) return form;
  const moved = withRow(form, {
    name: freeName(form, name ?? gateNameFor(command)),
    run: command,
    blocking: true,
    off: false,
    raw: null,
  });
  return { ...moved, verify: form.verify.filter((_, i) => i !== index) };
}

export function removeVerify(form: GatesForm, index: number): GatesForm {
  return { ...form, verify: form.verify.filter((_, i) => i !== index) };
}

export function addGlob(form: GatesForm): GatesForm {
  const seq = form.seq + 1;
  return { ...form, seq, allow: [...form.allow, { id: `g${seq}`, glob: '' }] };
}

export function updateGlob(form: GatesForm, id: string, glob: string): GatesForm {
  return { ...form, allow: form.allow.map((g) => (g.id === id ? { ...g, glob } : g)) };
}

export function removeGlob(form: GatesForm, id: string): GatesForm {
  return { ...form, allow: form.allow.filter((g) => g.id !== id) };
}

// ---------------------------------------------------------------------------------------------
// Validation and output
// ---------------------------------------------------------------------------------------------

/** Names valid for `GateNameSchema` and unique, commands and allowlist globs not empty. */
export function validateGatesForm(form: GatesForm): GatesFormErrors {
  const errors: GatesFormErrors = { commands: {}, allow: {} };
  const counts = new Map<string, number>();
  for (const c of form.commands) counts.set(c.name.trim(), (counts.get(c.name.trim()) ?? 0) + 1);
  for (const c of form.commands) {
    const name = c.name.trim();
    const row: { name?: string; run?: string } = {};
    if (name === '') row.name = 'Give the gate a name.';
    else if (!GateNameSchema.safeParse(name).success)
      row.name = 'Lowercase letters, digits and : . _ - (max 40, starting with a letter or digit).';
    else if ((counts.get(name) ?? 0) > 1) row.name = `There is more than one gate called ${name}.`;
    if (!c.off && c.run.trim() === '') row.run = 'Enter the command to run.';
    if (row.name || row.run) errors.commands[c.id] = row;
  }
  for (const g of form.allow) if (g.glob.trim() === '') errors.allow[g.id] = 'Enter a glob, e.g. fixtures/**.';
  return errors;
}

export function hasErrors(errors: GatesFormErrors): boolean {
  return Object.keys(errors.commands).length > 0 || Object.keys(errors.allow).length > 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

function commandValue(row: CommandRow): GateCommandConfig {
  if (row.off) return false;
  const run = row.run.trim();
  if (row.raw !== null) {
    const loaded = rowOf(row.id, row.name, row.raw);
    if (!loaded.off && loaded.run === run && loaded.blocking === row.blocking) return row.raw;
  }
  return row.blocking ? run : { run, blocking: false };
}

/**
 * The `gates` (and, when it changed, `verify`) to save. A key is written when the loaded config had it or its
 * value differs from the default; an empty result removes `gates` (unless legion.json had an empty one).
 */
export function gatesConfigFromForm(form: GatesForm): GatesSave {
  const base = form.base ?? {};
  const has = (key: keyof GatesConfig) => Object.hasOwn(base, key);
  const gates: GatesConfig = {};
  if (has('detect') || !form.detect) gates.detect = form.detect;
  if (form.commands.length > 0 || has('commands')) {
    gates.commands = Object.fromEntries(form.commands.map((c) => [c.name.trim(), commandValue(c)]));
  }
  if (has('scope') || form.scope !== 'block') gates.scope = form.scope;

  const allow = form.allow.map((g) => g.glob.trim());
  const secrets = base.secrets;
  if (typeof secrets === 'object') {
    gates.secrets = {
      ...(Object.hasOwn(secrets, 'mode') || form.secretsMode !== 'block' ? { mode: form.secretsMode } : {}),
      ...(Object.hasOwn(secrets, 'allow') || allow.length > 0 ? { allow } : {}),
    };
  } else if (allow.length > 0) {
    gates.secrets = { mode: form.secretsMode, allow };
  } else if (secrets !== undefined || form.secretsMode !== 'block') {
    gates.secrets = form.secretsMode;
  }

  const empty = Object.keys(gates).length === 0;
  const keepEmpty = form.base !== null && Object.keys(form.base).length === 0;
  const out: GatesSave = { gates: empty && !keepEmpty ? null : gates };
  if (!sameValue(form.verify, form.baseVerify)) out.verify = [...form.verify];
  return out;
}

/** The form differs from what was loaded. */
export function isDirty(form: GatesForm): boolean {
  const { gates, verify } = gatesConfigFromForm(form);
  return verify !== undefined || !sameValue(gates, form.base);
}

/** The gates every task would run with this form saved (task commands aside), with their source. */
export function effectiveGates(form: GatesForm, detected: readonly GateSpec[]): GateSpec[] {
  const { gates } = gatesConfigFromForm(form);
  return resolveGates({ config: { gates, verify: form.verify }, detected, taskCommands: [] });
}

/** How a detected gate fares under the form: it runs, is replaced by a configured gate, or is suppressed. */
export function detectedState(form: GatesForm, spec: GateSpec): 'runs' | 'replaced' | 'suppressed' | 'off' {
  if (!form.detect) return 'off';
  const row = form.commands.find((c) => c.name.trim() === spec.name);
  if (row?.off) return 'suppressed';
  if (row) return 'replaced';
  return effectiveGates(form, [spec]).some((g) => g.source === 'detected') ? 'runs' : 'replaced';
}

// ---------------------------------------------------------------------------------------------
// Session: loading and saving one project's gates
// ---------------------------------------------------------------------------------------------

export type GatesLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ProjectGates };

export type GatesSaveState =
  | { kind: 'idle' | 'saving' | 'saved' }
  | { kind: 'error'; message: string; conflict: boolean };

/**
 * The section's state for the project being edited. Every load and save takes a new `generation`; a
 * response only applies while its ticket is still current (same project, same generation), so a late answer
 * for another project or an abandoned request never lands in the editor.
 */
export interface GatesSession {
  projectId: string | null;
  generation: number;
  load: GatesLoad;
  form: GatesForm | null;
  save: GatesSaveState;
}

export interface GatesTicket {
  projectId: string;
  generation: number;
}

export const EMPTY_SESSION: GatesSession = {
  projectId: null,
  generation: 0,
  load: { status: 'loading' },
  form: null,
  save: { kind: 'idle' },
};

function isCurrent(session: GatesSession, ticket: GatesTicket): boolean {
  return session.projectId === ticket.projectId && session.generation === ticket.generation;
}

/** (Re)load `projectId`: drops the form and invalidates every request still in flight. */
export function startLoad(projectId: string, generation: number): { session: GatesSession; ticket: GatesTicket } {
  return {
    session: { projectId, generation, load: { status: 'loading' }, form: null, save: { kind: 'idle' } },
    ticket: { projectId, generation },
  };
}

export function loadDone(session: GatesSession, ticket: GatesTicket, data: ProjectGates): GatesSession {
  if (!isCurrent(session, ticket)) return session;
  return { ...session, load: { status: 'ready', data }, form: data.error ? null : formFromProjectGates(data) };
}

export function loadFailed(session: GatesSession, ticket: GatesTicket, message: string): GatesSession {
  if (!isCurrent(session, ticket)) return session;
  return { ...session, load: { status: 'error', message }, form: null };
}

/** An edit to the form; ignored while a save is in flight (the form is what is being written). */
export function editSession(session: GatesSession, update: (form: GatesForm) => GatesForm): GatesSession {
  if (!session.form || session.save.kind === 'saving') return session;
  return {
    ...session,
    form: update(session.form),
    save: session.save.kind === 'saved' ? { kind: 'idle' } : session.save,
  };
}

/** The form as loaded again (undo every edit). */
export function discardEdits(session: GatesSession): GatesSession {
  if (session.load.status !== 'ready' || session.load.data.error || session.save.kind === 'saving') return session;
  return { ...session, form: formFromProjectGates(session.load.data), save: { kind: 'idle' } };
}

/** What `projects.setGates` receives. */
export interface GatesSaveRequest extends GatesSave {
  projectId: string;
  revision: string | null;
}

/**
 * Start saving: the request (against the loaded revision) and the session locked while it runs. Null when
 * there is nothing to save: no loaded form, invalid or unchanged, or a save already running.
 */
export function startSave(
  session: GatesSession,
  generation: number,
): { session: GatesSession; ticket: GatesTicket; request: GatesSaveRequest } | null {
  const { projectId, form, load } = session;
  if (projectId === null || !form || load.status !== 'ready' || session.save.kind === 'saving') return null;
  if (hasErrors(validateGatesForm(form)) || !isDirty(form)) return null;
  const { gates, verify } = gatesConfigFromForm(form);
  return {
    session: { ...session, generation, save: { kind: 'saving' } },
    ticket: { projectId, generation },
    request: { projectId, revision: load.data.revision, gates, ...(verify ? { verify } : {}) },
  };
}

/** The save went through: the written file becomes the loaded state (new revision) and the form's base. */
export function saveDone(session: GatesSession, ticket: GatesTicket, data: ProjectGates): GatesSession {
  if (!isCurrent(session, ticket)) return session;
  return {
    ...session,
    load: { status: 'ready', data },
    form: data.error ? null : formFromProjectGates(data),
    save: { kind: 'saved' },
  };
}

/** The save failed; the edits stay. `conflict`: legion.json changed on disk, so only a reload helps. */
export function saveFailed(
  session: GatesSession,
  ticket: GatesTicket,
  message: string,
  conflict: boolean,
): GatesSession {
  if (!isCurrent(session, ticket)) return session;
  return { ...session, save: { kind: 'error', message, conflict } };
}
