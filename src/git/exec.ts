import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Raised for any non-zero git/gh exit (unless the caller whitelisted the code). */
export class GitError extends Error {
  override readonly name = 'GitError';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** null = killed / timed out / failed to spawn. */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    command: string,
    args: readonly string[],
    cwd: string,
    exitCode: number | null,
    stderr: string,
    stdout: string,
  ) {
    super(
      `${command} ${args.join(' ')} failed (exit ${exitCode ?? 'null'}) in ${cwd}: ${stderr.trim() || stdout.trim()}`,
    );
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

export interface GitOptions {
  env?: Readonly<Record<string, string>>;
  input?: string;
  /** Exit codes that are not errors (default `[0]`). The result carries the real code. */
  okExitCodes?: readonly number[];
  /** Default 120s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
};

/** Config always passed: stable, unquoted paths. */
export const GLOBAL_GIT_ARGS = ['-c', 'core.quotepath=off'] as const;

export const ANY_EXIT: readonly number[] = Array.from({ length: 256 }, (_, i) => i);

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Spawn `command args` directly (no shell) in `cwd` and collect its output. Throws {@link GitError} for an exit
 * code outside `okExitCodes`, and with `exitCode: null` when the process could not be spawned, was killed (timeout,
 * abort) or exceeded the output buffer.
 */
export function runCommand(
  command: string,
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<GitResult> {
  const ok = opts.okExitCodes ?? [0];
  return new Promise((resolvePromise, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    let failure: string | null = null;
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, ...BASE_ENV, ...opts.env },
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const kill = (reason: string) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(`timed out after ${opts.timeoutMs ?? 120_000}ms`), opts.timeoutMs ?? 120_000);
    const onAbort = () => kill('aborted');
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) kill('output exceeded the buffer');
      else into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    child.on('error', (e) => {
      if (settled) return;
      done();
      reject(new GitError(command, args, cwd, null, e.message, ''));
    });
    child.on('close', (code) => {
      if (settled) return;
      done();
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const exitCode = failure === null ? code : null;
      if (exitCode === null || !ok.includes(exitCode)) {
        reject(new GitError(command, args, cwd, exitCode, stderr || (failure ?? ''), stdout));
      } else {
        resolvePromise({ stdout, stderr, exitCode });
      }
    });
    if (opts.input !== undefined && child.stdin) {
      // The child may exit before reading everything (EPIPE): its exit code tells what happened.
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
  });
}

/** Run `git -c core.quotepath=off <args>` in `repo` (any directory inside a repo or worktree). */
export function git(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<GitResult> {
  return runCommand('git', repo, [...GLOBAL_GIT_ARGS, ...args], opts);
}

/** Like {@link git} but returns stdout with the trailing newline removed. */
export async function gitText(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  return (await git(repo, args, opts)).stdout.replace(/\r?\n$/, '');
}

/** True when git exited 0; false for any other exit code. Spawn failures still throw. */
export async function gitSucceeds(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<boolean> {
  const r = await git(repo, args, { ...opts, okExitCodes: ANY_EXIT });
  return r.exitCode === 0;
}

/** Split NUL-terminated (`-z`) output into records, dropping the trailing empty one. */
export function splitZ(output: string): string[] {
  const parts = output.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

export interface PorcelainEntry {
  /** Two-char XY status. */
  xy: string;
  path: string;
  /** Previous path for rename/copy entries. */
  origPath: string | null;
}

/** Parse `git status --porcelain=v1 -z` output. */
export function parsePorcelainZ(output: string): PorcelainEntry[] {
  const parts = splitZ(output);
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] as string;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      entries.push({ xy, path, origPath: parts[++i] ?? null });
    } else {
      entries.push({ xy, path, origPath: null });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Per-repository mutex
// ---------------------------------------------------------------------------------------------

const keyCache = new Map<string, Promise<string>>();
const tails = new Map<string, Promise<void>>();

/** Stable key for "this repository" regardless of which of its worktrees `path` points into. */
export function repoKey(path: string): Promise<string> {
  const abs = resolve(path);
  let key = keyCache.get(abs);
  if (!key) {
    key = (async () => {
      const common = await gitText(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      return realpath(common);
    })();
    key.catch(() => keyCache.delete(abs));
    keyCache.set(abs, key);
  }
  return key;
}

/**
 * Serialize `fn` with every other `withRepoLock` call on the same repository (the main checkout and
 * all of its worktrees share one lock). NOT re-entrant: never call a locking function from inside `fn`.
 * Use it for ref-changing operations; read-only git calls need no lock.
 */
export async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = await repoKey(repo);
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** Forget cached repo keys (for tests that delete and recreate repos at the same path). */
export function clearRepoKeyCache(): void {
  keyCache.clear();
}
