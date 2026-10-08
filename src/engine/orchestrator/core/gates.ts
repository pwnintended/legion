/**
 * Gates (§8 Verify): which named gates a task runs (legion.json `gates.commands`, legacy `verify`, detected
 * project gates, the task's own commands) and how their results count. Pure; the runner lives in
 * `worktrees.ts`.
 */
import type { GateKind, GateSettings, GateSource, GateSpec, GateStatus, GatesConfig } from '@shared/domain';
import type { VerifyResultInput } from './prompts/types';

export type { GateSettings, GateSource, GateSpec } from '@shared/domain';

/** One gate's outcome; a verify-phase `Verification` row carries the same fields. */
export interface GateResult extends VerifyResultInput {
  readonly name: string;
  readonly kind: GateKind;
  readonly status: GateStatus;
  readonly blocking: boolean;
  /** One line: what passed or why it failed. */
  readonly summary: string;
  readonly source: GateSource;
}

/** A likely secret on an added line of the task's diff. */
export interface SecretFinding {
  readonly file: string;
  /** Line number in the new file. */
  readonly line: number;
  /** The rule that matched (`aws-access-key`, `private-key`, ...). */
  readonly rule: string;
  /** The line with the secret value masked; the value itself is never kept. */
  readonly excerpt: string;
}

/** The parts of legion.json gate resolution reads. */
export interface GatesConfigInput {
  readonly gates?: GatesConfig | null;
  readonly verify?: readonly string[] | null;
}

const MAX_NAME = 40;
/** Package manager flags that take a value (`pnpm --filter web test`, `npm -w web run lint`). */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set(['--filter', '-F', '--dir', '-C']),
  npm: new Set(['--workspace', '-w', '--prefix']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '--filter']),
};
/** Runners whose first argument is the actual program (`npx vitest run`). */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);

function sanitizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_NAME)
    .replace(/[-:._]+$/, '');
}

/** The name of the script a package manager command runs, or null when it isn't one. */
function packageScript(tokens: readonly string[]): string | null {
  const [pm, ...rest] = tokens;
  const valueFlags = pm && Object.hasOwn(VALUE_FLAGS, pm) ? VALUE_FLAGS[pm] : undefined;
  if (!valueFlags) return null;
  let i = 0;
  while (rest[i]?.startsWith('-')) {
    const flag = rest[i] ?? '';
    i += valueFlags.has(flag) ? 2 : 1;
  }
  let script = rest[i];
  if (script === 'run' || script === 'run-script') script = rest[i + 1];
  if (!script || script.startsWith('-')) return null;
  if (script === 't' || script === 'tst') return 'test';
  if (script === 'exec' || script === 'dlx' || script === 'x') return null;
  return script;
}

/**
 * The default gate name of a command: the script for package manager forms (`pnpm test` → `test`,
 * `npm run lint` → `lint`, `yarn typecheck` → `typecheck`, `bun run db:check` → `db:check`), else a short label
 * from the program and its subcommand (`cargo test` → `cargo-test`, `tsc --noEmit` → `tsc`). Only the first part
 * of `a && b` counts. Always a valid `GateNameSchema` name.
 */
export function gateNameFor(command: string): string {
  const first = command.split(/&&|\|\||;/)[0] ?? '';
  let tokens = first
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const script = packageScript(tokens);
  if (script !== null) return sanitizeName(script) || 'verify';
  if (tokens[0] && RUNNERS.has(tokens[0])) tokens = tokens.slice(1);
  else if (tokens[0] && Object.hasOwn(VALUE_FLAGS, tokens[0]) && ['exec', 'dlx', 'x'].includes(tokens[1] ?? '')) {
    tokens = tokens.slice(2);
  }
  const program = (tokens[0] ?? '').split(/[\\/]/).at(-1) ?? '';
  const sub = tokens.slice(1).find((t) => /^[A-Za-z][A-Za-z0-9:_-]*$/.test(t));
  return sanitizeName(sub ? `${program}-${sub}` : program) || 'verify';
}

/** The effective `gates` settings: detection on, scope and secrets blocking, no secret allowlist. */
export function resolveGateSettings(config: GatesConfigInput | null | undefined): GateSettings {
  const gates = config?.gates;
  const secrets = gates?.secrets;
  return {
    detect: gates?.detect ?? true,
    scope: gates?.scope ?? 'block',
    secrets:
      typeof secrets === 'string'
        ? { mode: secrets, allow: [] }
        : { mode: secrets?.mode ?? 'block', allow: [...(secrets?.allow ?? [])] },
  };
}

/** `name`, or `name-2`, `name-3`, ... (within the length limit) when taken. */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Names the built-in gates record under; a command gate never takes one (it gets a `-2` suffix instead). */
export const BUILTIN_GATE_NAMES: readonly string[] = ['scope', 'secrets'];

/**
 * The command gates to run, in order: legion.json `gates.commands` (`false` suppresses that name), legacy
 * `verify`, detected gates whose name isn't taken or suppressed (only with detection on), then the task's
 * commands that no gate already runs. A command runs once (the first source to name it wins); colliding
 * names, and names of the built-in gates, get a `-2`, `-3`, ... suffix.
 */
export function resolveGates(input: {
  readonly config: GatesConfigInput | null | undefined;
  readonly detected: readonly GateSpec[];
  readonly taskCommands: readonly string[];
}): GateSpec[] {
  const { config } = input;
  const gates: GateSpec[] = [];
  const names = new Set<string>(BUILTIN_GATE_NAMES);
  const commands = new Set<string>();
  /** Names `gates.commands` or `verify` define or suppress: never detected. */
  const reserved = new Set<string>();
  const add = (name: string, command: string, blocking: boolean, source: GateSource): void => {
    if (commands.has(command.trim())) return;
    const unique = uniqueName(name, names);
    names.add(unique);
    commands.add(command.trim());
    gates.push({ name: unique, command, blocking, source });
  };

  const suppressed = new Set<string>();
  for (const [name, value] of Object.entries(config?.gates?.commands ?? {})) {
    reserved.add(name);
    if (value === false) suppressed.add(name);
    else if (typeof value === 'string') add(name, value, true, 'config');
    else add(name, value.run, value.blocking ?? true, 'config');
  }
  for (const command of config?.verify ?? []) {
    const name = gateNameFor(command);
    if (suppressed.has(name) || commands.has(command.trim())) continue;
    reserved.add(name);
    add(name, command, true, 'verify');
  }
  if (resolveGateSettings(config).detect) {
    for (const spec of input.detected) {
      if (reserved.has(spec.name) || gates.some((g) => g.name === spec.name)) continue;
      add(spec.name, spec.command, spec.blocking, spec.source);
    }
  }
  for (const command of input.taskCommands) add(gateNameFor(command), command, true, 'task');
  return gates;
}

/** `total`: results that ran (not skipped); `green`: passed; failures split into blocking and warnings. */
export function gateCounts(results: readonly Pick<GateResult, 'status' | 'blocking'>[]): {
  green: number;
  total: number;
  blockingFailed: number;
  warnings: number;
} {
  let green = 0;
  let total = 0;
  let blockingFailed = 0;
  let warnings = 0;
  for (const r of results) {
    if (r.status === 'skipped') continue;
    total++;
    if (r.status === 'pass') green++;
    else if (r.blocking) blockingFailed++;
    else warnings++;
  }
  return { green, total, blockingFailed, warnings };
}

/** No blocking gate failed (non-blocking failures only warn; skipped gates don't count). */
export function gatesPassed(results: readonly Pick<GateResult, 'status' | 'blocking'>[]): boolean {
  return !results.some((r) => r.status === 'fail' && r.blocking);
}

const BUILTIN_KINDS: Readonly<Record<string, GateKind>> = { 'legion:scope': 'scope', 'legion:secrets': 'secrets' };

function isGateResult(v: VerifyResultInput | GateResult): v is GateResult {
  return 'name' in v && 'status' in v && typeof v.name === 'string' && typeof v.status === 'string';
}

/** A structured result as is; a legacy verify result (task meta from before gates) as a blocking command gate. */
export function normalizeGateResult(v: VerifyResultInput | GateResult): GateResult {
  if (isGateResult(v)) return v;
  const kind = Object.hasOwn(BUILTIN_KINDS, v.command) ? (BUILTIN_KINDS[v.command] as GateKind) : 'command';
  const passed = v.exitCode === 0;
  return {
    command: v.command,
    exitCode: v.exitCode,
    outputTail: v.outputTail,
    durationMs: v.durationMs ?? null,
    name: kind === 'command' ? gateNameFor(v.command) : kind,
    kind,
    status: passed ? 'pass' : 'fail',
    blocking: true,
    summary: summaryLine(
      v.outputTail,
      passed ? 'passed' : v.exitCode === null ? 'killed or timed out' : `exit code ${v.exitCode}`,
    ),
    source: kind === 'command' ? 'verify' : 'builtin',
  };
}

const MAX_SUMMARY = 160;

/** The last non-empty line of `output` (ANSI codes stripped, clipped), or `fallback` when there is none. */
export function summaryLine(output: string, fallback: string): string {
  const lines = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.at(-1);
  if (!line) return fallback;
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}
