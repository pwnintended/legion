/**
 * Warm worktrees: a fresh worktree has none of the checkout's untracked build caches (`target/`, `node_modules/`,
 * Godot's `.godot/`), so every agent in it would start with a cold build — slow, and gigabytes per worktree. They
 * are copied from the user's checkout as copy-on-write clones (APFS `clonefile`, `--reflink` elsewhere): instant,
 * and no extra disk until a build changes them. Where the filesystem cannot clone, nothing is copied.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from './exec.ts';

export interface WarmSettings {
  /** Paths relative to the repository root; null: found automatically. */
  clone: readonly string[] | null;
  setup: readonly string[];
  minFreeGb: number;
}

const CACHE_NAMES = new Set(['target', 'node_modules', '.venv', '.godot']);
const SKIP = new Set(['.git', 'node_modules', 'target', '.venv']);

/** Untracked cache directories of the checkout, two levels deep, that git ignores. */
export async function findCacheDirs(repo: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(repo, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (CACHE_NAMES.has(e.name)) found.push(path);
      else if (depth < 2 && !SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path, depth + 1);
    }
  };
  await walk('', 0);
  if (found.length === 0) return [];
  const ignored = await git(repo, ['check-ignore', '--', ...found], { okExitCodes: [0, 1] });
  const set = new Set(ignored.stdout.split('\n').map((l) => l.trim().replace(/\/$/, '')));
  return found.filter((p) => set.has(p));
}

/** Free space on the filesystem holding `path`, in GB. */
export async function freeGb(path: string): Promise<number> {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const s = await statfs(dir);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

export class DiskSpaceError extends Error {
  override readonly name = 'DiskSpaceError';
}

/** Refuses to create a worktree when the disk is nearly full (a full disk kills every running agent). */
export async function checkDiskSpace(path: string, minFreeGb: number): Promise<void> {
  if (minFreeGb <= 0) return;
  const free = await freeGb(path);
  if (free < minFreeGb) {
    throw new DiskSpaceError(
      `Only ${free.toFixed(1)} GB free on the disk of ${path} (minimum ${minFreeGb} GB, [worktrees] minFreeGb): not creating another worktree. Free some space (finished runs' worktrees are removed when they end) and resume the run.`,
    );
  }
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** Copy-on-write clone of a directory tree; false when the filesystem cannot (nothing is copied then). */
export async function cloneDir(from: string, to: string): Promise<boolean> {
  if (!existsSync(from) || existsSync(to)) return false;
  await mkdir(dirname(to), { recursive: true });
  const args =
    process.platform === 'darwin' ? ['-c', '-R', '-p', from, to] : ['-R', '-p', '--reflink=always', from, to];
  const r = await run('cp', args, dirname(to), 10 * 60_000);
  if (r.code !== 0) await run('rm', ['-rf', to], dirname(to), 60_000);
  return r.code === 0;
}

export interface WarmResult {
  cloned: string[];
  /** Problems worth a log line (a clone the filesystem refused, a failed setup command). */
  warnings: string[];
}

/** Clones the caches into a new worktree and runs the setup commands there. */
export async function warmWorktree(repo: string, worktree: string, settings: WarmSettings): Promise<WarmResult> {
  const dirs = settings.clone ?? (await findCacheDirs(repo));
  const cloned: string[] = [];
  const warnings: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(join(repo, dir))) continue;
    if (await cloneDir(join(repo, dir), join(worktree, dir))) cloned.push(dir);
    else if (!existsSync(join(worktree, dir))) warnings.push(`could not clone ${dir} (no copy-on-write support?)`);
  }
  for (const command of settings.setup) {
    const r = await run('bash', ['-lc', command], worktree, 15 * 60_000);
    if (r.code !== 0)
      warnings.push(`setup "${command}" failed (${r.code}): ${r.out.trim().split('\n').slice(-3).join(' ')}`);
  }
  return { cloned, warnings };
}
