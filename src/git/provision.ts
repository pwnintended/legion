import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, copyFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { globToRegExp } from './glob.ts';

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

/** How a fresh worktree is provisioned. Loaded by the caller from the project config. */
export interface ProvisionConfig {
  /** Shell commands run in a new worktree (see {@link runShellCommands}). */
  setup?: string[];
  /** Globs of (usually untracked) files copied from the main checkout, e.g. `.env*`. */
  copy?: string[];
  /** Globs of files symlinked from the main checkout. */
  symlink?: string[];
  /** Overrides the install command detected from the lockfile. */
  installCommand?: string;
  /** Regenerates the lockfile after a lockfile conflict (default: per package manager, non-frozen). */
  lockfileCommand?: string;
}

/** A copy/symlink pattern escapes the repository. */
export class ProvisionError extends Error {
  override readonly name = 'ProvisionError';
}

// ---------------------------------------------------------------------------------------------
// Lockfiles / install command
// ---------------------------------------------------------------------------------------------

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

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

/** `config.lockfileCommand` if set, else the regenerate command for the detected lockfile, else null. */
export async function lockfileCommand(dir: string, config?: ProvisionConfig | null): Promise<string | null> {
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

/** `config.installCommand` if set, else the default for the detected lockfile, else null. */
export async function installCommand(dir: string, config?: ProvisionConfig | null): Promise<string | null> {
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
    throw new ProvisionError(`unsafe copy/symlink pattern "${pattern}" (must be relative, no "..")`);
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
      let entries: Dirent[];
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
  config: Pick<ProvisionConfig, 'copy' | 'symlink'>,
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
        await symlink(src, dest);
        result.symlinked.push(rel);
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

export interface LegionEnvInput {
  rootPath: string;
  taskId: string;
  runId: string;
  extra?: Readonly<Record<string, string>>;
}

/** `LEGION_ROOT_PATH`, `LEGION_TASK_ID`, `LEGION_RUN_ID`, `LEGION_PORT_BASE` (over `extra`) for task commands. */
export function legionEnv(input: LegionEnvInput): Record<string, string> {
  return {
    ...input.extra,
    LEGION_ROOT_PATH: input.rootPath,
    LEGION_TASK_ID: input.taskId,
    LEGION_RUN_ID: input.runId,
    LEGION_PORT_BASE: String(portBase(input.runId, input.taskId)),
  };
}

/** Result of one shell command. */
export interface CommandResult {
  command: string;
  /** null = killed (timeout/abort) or failed to spawn. */
  exitCode: number | null;
  /** The last `maxOutputChars` of stdout and stderr, interleaved as written. */
  outputTail: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  /** Laid over `process.env` (see {@link legionEnv}). */
  env?: Readonly<Record<string, string>>;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Default 8000. */
  maxOutputChars?: number;
  signal?: AbortSignal;
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars + 1)}`;
}

/** Grace period between SIGTERM and SIGKILL for a timed-out / aborted command's process group. */
const KILL_GRACE_MS = 2000;

/**
 * Run one command with `/bin/sh -c` in `cwd`, stdin closed. Never throws for a non-zero exit. The command runs
 * in its own process group so a timeout or abort also stops whatever it spawned.
 */
export function runShellCommand(command: string, opts: RunCommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 600_000;
  // Keep a bounded window of output; tail() trims it to the final size.
  const keep = Math.max((opts.maxOutputChars ?? 8000) * 4, 64 * 1024);
  return new Promise((resolvePromise) => {
    let output = '';
    let timedOut = false;
    let killed = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    const kill = () => {
      if (killed) return;
      killed = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (opts.signal?.aborted) kill();
    opts.signal?.addEventListener('abort', kill, { once: true });
    const finish = (exitCode: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', kill);
      resolvePromise({
        command,
        exitCode: killed ? null : exitCode,
        outputTail: tail((output + extra).replace(/\r?\n$/, ''), opts.maxOutputChars ?? 8000),
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    // One decoder per stream: a multi-byte character may be split across chunks.
    const onData = (decoder: StringDecoder) => (chunk: Buffer) => {
      output += decoder.write(chunk);
      if (output.length > keep * 2) output = output.slice(output.length - keep);
    };
    child.stdout.on('data', onData(new StringDecoder('utf8')));
    child.stderr.on('data', onData(new StringDecoder('utf8')));
    child.on('error', (e) => finish(null, `${output ? '\n' : ''}${e.message}`));
    child.on('close', (code) => finish(code));
  });
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
