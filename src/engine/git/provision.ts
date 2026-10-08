import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tail } from '@shared/util';
import { execa } from 'execa';
import { z } from 'zod';
import { enginePlatform } from '../platform';
import { linkOrCopy } from '../util/links';
import { globToRegExp } from './glob';

// ---------------------------------------------------------------------------------------------
// legion.json
// ---------------------------------------------------------------------------------------------

export const LegionConfigSchema = z.object({
  setup: z.array(z.string().min(1)).optional(),
  verify: z.array(z.string().min(1)).optional(),
  copy: z.array(z.string().min(1)).optional(),
  symlink: z.array(z.string().min(1)).optional(),
  highRiskGlobs: z.array(z.string().min(1)).optional(),
  installCommand: z.string().min(1).optional(),
  /** Regenerates the lockfile after a lockfile conflict (default: per package manager, non-frozen). */
  lockfileCommand: z.string().min(1).optional(),
});
export type LegionConfig = z.infer<typeof LegionConfigSchema>;

export class LegionConfigError extends Error {
  override readonly name = 'LegionConfigError';
}

/** Read and validate `<root>/legion.json`. Returns null if absent; throws {@link LegionConfigError} if invalid. */
export async function loadLegionConfig(root: string): Promise<LegionConfig | null> {
  const file = join(root, 'legion.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new LegionConfigError(`${file}: invalid JSON (${(e as Error).message})`);
  }
  const parsed = LegionConfigSchema.safeParse(json);
  if (!parsed.success) throw new LegionConfigError(`${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Lockfiles / install command
// ---------------------------------------------------------------------------------------------

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** Order = precedence when several lockfiles exist. */
export const LOCKFILES: readonly { file: string; manager: PackageManager }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
];

const INSTALL_COMMANDS: Record<PackageManager, string> = {
  pnpm: 'pnpm install --frozen-lockfile',
  npm: 'npm ci',
  yarn: 'yarn install --frozen-lockfile',
  bun: 'bun install --frozen-lockfile',
};

/**
 * Rewrite the lockfile from the manifest without the frozen check (the install commands above refuse
 * exactly the out-of-sync lockfile a conflict resolution leaves behind).
 */
const LOCKFILE_COMMANDS: Record<PackageManager, string> = {
  pnpm: 'pnpm install --lockfile-only',
  npm: 'npm install --package-lock-only',
  yarn: 'yarn install',
  bun: 'bun install --lockfile-only',
};

/** `legion.json` `lockfileCommand` if set, else the regenerate command for the detected lockfile, else null. */
export async function lockfileCommand(dir: string, config?: LegionConfig | null): Promise<string | null> {
  if (config?.lockfileCommand) return config.lockfileCommand;
  const lock = await detectLockfile(dir);
  return lock ? LOCKFILE_COMMANDS[lock.manager] : null;
}

export function isLockfilePath(path: string): boolean {
  const base = path.split('/').at(-1) ?? path;
  return LOCKFILES.some((l) => l.file === base);
}

export async function detectLockfile(dir: string): Promise<{ file: string; manager: PackageManager } | null> {
  for (const l of LOCKFILES) {
    if (await exists(join(dir, l.file))) return l;
  }
  return null;
}

/** `legion.json` `installCommand` if set, else the default for the detected lockfile, else null. */
export async function installCommand(dir: string, config?: LegionConfig | null): Promise<string | null> {
  if (config?.installCommand) return config.installCommand;
  const lock = await detectLockfile(dir);
  return lock ? INSTALL_COMMANDS[lock.manager] : null;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------------------------
// copy / symlink
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_WALK_ENTRIES = 50_000;

/** Static leading directory of a pattern (no magic) and whether matches may be nested deeper. */
function walkPlan(pattern: string): { base: string; recursive: boolean } {
  const parts = pattern.replace(/^\.\//, '').split('/');
  const dirParts: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[\]{}]/.test(part)) break;
    dirParts.push(part);
  }
  const rest = parts.slice(dirParts.length);
  return { base: dirParts.join('/'), recursive: rest.length > 1 || pattern.endsWith('/') };
}

function assertSafePattern(pattern: string): void {
  const norm = pattern.replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.split('/').includes('..')) {
    throw new LegionConfigError(`unsafe copy/symlink pattern "${pattern}" (must be relative, no "..")`);
  }
}

/** Expand `patterns` against `root`: repo-relative file paths (never `.git` or `node_modules`). */
export async function expandGlobs(root: string, patterns: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    assertSafePattern(pattern);
    const rx = globToRegExp(pattern);
    const { base, recursive } = walkPlan(pattern);
    let budget = MAX_WALK_ENTRIES;
    const walk = async (relDir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(join(root, relDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (budget-- <= 0) return;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (recursive) await walk(rel);
        } else if (rx.test(rel)) {
          found.add(rel);
        }
      }
    };
    await walk(base);
  }
  return [...found].sort();
}

export interface ProvisionFilesResult {
  copied: string[];
  symlinked: string[];
  /** Skipped because the destination already exists. */
  skipped: string[];
}

/** Copy / symlink untracked files (e.g. `.env*`) from the main checkout into a fresh worktree. */
export async function provisionFiles(
  mainRoot: string,
  worktree: string,
  config: Pick<LegionConfig, 'copy' | 'symlink'>,
): Promise<ProvisionFilesResult> {
  const result: ProvisionFilesResult = { copied: [], symlinked: [], skipped: [] };
  const root = resolve(mainRoot);
  const wt = resolve(worktree);
  const place = async (rels: string[], mode: 'copy' | 'symlink') => {
    for (const rel of rels) {
      const src = join(root, rel);
      const dest = join(wt, rel);
      if (
        relative(wt, dest).startsWith('..') ||
        relative(root, src).startsWith('..') ||
        dest.split(sep).includes('.git')
      ) {
        continue;
      }
      if (await exists(dest)) {
        result.skipped.push(rel);
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      if (mode === 'copy') {
        await copyFile(src, dest);
        result.copied.push(rel);
      } else {
        // A copy where the OS refuses file symlinks (Windows without Developer Mode).
        if ((await linkOrCopy(src, dest)) === 'linked') result.symlinked.push(rel);
        else result.copied.push(rel);
      }
    }
  };
  await place(await expandGlobs(root, config.copy ?? []), 'copy');
  await place(await expandGlobs(root, config.symlink ?? []), 'symlink');
  return result;
}

// ---------------------------------------------------------------------------------------------
// Command execution (setup / verify)
// ---------------------------------------------------------------------------------------------

const PORT_FLOOR = 40_000;
const PORT_BLOCK = 20;
const PORT_SLOTS = 1000; // 40000..59999

/** Deterministic port block start for (run, task). Collisions are possible but unlikely (1000 slots). */
export function portBase(runId: string, taskId: string): number {
  const h = createHash('sha1').update(`${runId}:${taskId}`).digest().readUInt32BE(0);
  return PORT_FLOOR + (h % PORT_SLOTS) * PORT_BLOCK;
}

export interface CommandEnvInput {
  rootPath: string;
  taskId: string;
  runId: string;
  extra?: Readonly<Record<string, string>>;
}

export function legionEnv(input: CommandEnvInput): Record<string, string> {
  return {
    ...input.extra,
    LEGION_ROOT_PATH: input.rootPath,
    LEGION_TASK_ID: input.taskId,
    LEGION_RUN_ID: input.runId,
    LEGION_PORT_BASE: String(portBase(input.runId, input.taskId)),
  };
}

/** Result of one shell command; maps onto the domain `Verification` (id/run/phase added by the caller). */
export interface CommandResult {
  command: string;
  /** null = killed (timeout/abort). */
  exitCode: number | null;
  outputTail: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  env: CommandEnvInput;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

/** Run one command through the shell in `cwd`. Never throws for non-zero exit. */
export async function runShellCommand(command: string, opts: RunCommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const env = legionEnv(opts.env);
  const r = await execa(command, {
    // sh on macOS / Linux, Git Bash on Windows: legion.json commands are written once for every OS.
    shell: enginePlatform().scriptShell({ ...process.env, ...env }),
    cwd: opts.cwd,
    env,
    extendEnv: true,
    reject: false,
    all: true,
    stripFinalNewline: true,
    timeout: opts.timeoutMs ?? 600_000,
    ...(opts.signal ? { cancelSignal: opts.signal } : {}),
    stdin: 'ignore',
    maxBuffer: 64 * 1024 * 1024,
  });
  const all = typeof r.all === 'string' ? r.all : '';
  return {
    command,
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
    outputTail: tail(all, opts.maxOutputChars ?? 8000),
    durationMs: Date.now() - started,
    timedOut: r.timedOut === true,
  };
}

/** Run commands in order, stopping at the first failure. */
export async function runShellCommands(
  commands: readonly string[],
  opts: RunCommandOptions,
): Promise<{ ok: boolean; results: CommandResult[] }> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const r = await runShellCommand(command, opts);
    results.push(r);
    if (r.exitCode !== 0) return { ok: false, results };
  }
  return { ok: true, results };
}
