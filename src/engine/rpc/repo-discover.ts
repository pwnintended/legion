/**
 * Repository discovery for the composer's picker (`repos.discover`) and branch listing (`repos.branches`).
 *
 * Discovery walks a few common dev roots shallowly (depth ≤ 3, no hidden dirs, no node_modules), stops at
 * the first `.git` it meets on each path, and stays inside a time budget. It only reads: directory
 * listings plus `git rev-parse` / `git log` / `git status` with optional locks off, so the index is never
 * rewritten.
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import type { DiscoveredRepo, RepoBranches } from '@shared/rpc';
import { execa } from 'execa';

/** Common places people keep checkouts, relative to $HOME. */
export const DEV_ROOTS = ['Projects', 'Developer', 'src', 'code', 'dev', 'work', 'repos', 'GitHub'] as const;

/** Directory names never descended into. Hidden directories (`.x`) are skipped too. */
const SKIP = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'target',
  'dist',
  'build',
  'out',
  'Library',
  'Applications',
  'Pictures',
  'Music',
  'Movies',
]);

/** Env override (path-delimited list) for the discovery roots; tests and e2e point it at temp dirs. */
export const DISCOVER_ROOTS_ENV = 'LEGION_DISCOVER_ROOTS';

export interface DiscoverRoot {
  path: string;
  /** How many levels below `path` to look (0 = only `path` itself). */
  depth: number;
}

/**
 * The roots to scan: `LEGION_DISCOVER_ROOTS` if set, else the common dev roots under `home` (depth 3), plus the
 * parent folders of recent repos (depth 1: their siblings are likely checkouts too).
 */
export function discoveryRoots(
  home: string,
  recentRepoPaths: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DiscoverRoot[] {
  const override = env[DISCOVER_ROOTS_ENV];
  const roots: DiscoverRoot[] = override
    ? override
        .split(delimiter)
        .filter(Boolean)
        .map((p) => ({ path: resolve(p), depth: 3 }))
    : DEV_ROOTS.map((name) => ({ path: join(home, name), depth: 3 }));
  for (const repo of recentRepoPaths) {
    const parent = dirname(repo);
    // Never sweep the home directory or the filesystem root itself.
    if (parent === home || parent === dirname(parent)) continue;
    roots.push({ path: parent, depth: 1 });
  }
  const byPath = new Map<string, DiscoverRoot>();
  for (const root of roots) if (!byPath.has(root.path)) byPath.set(root.path, root);
  return [...byPath.values()];
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Directories under the roots that contain a `.git` entry, breadth-first, until `deadline`. */
export async function findRepoDirs(roots: readonly DiscoverRoot[], deadline: number, limit = 400): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  let frontier: { path: string; left: number }[] = roots.map((r) => ({ path: r.path, left: r.depth }));
  while (frontier.length > 0 && found.length < limit && Date.now() < deadline) {
    const next: { path: string; left: number }[] = [];
    // One level at a time, listed in parallel batches.
    for (let i = 0; i < frontier.length && Date.now() < deadline; i += 32) {
      const batch = frontier.slice(i, i + 32).filter((d) => !seen.has(d.path));
      for (const d of batch) seen.add(d.path);
      const listings = await Promise.all(batch.map(async (d) => ({ dir: d, entries: await listDir(d.path) })));
      for (const { dir, entries } of listings) {
        if (entries.some((e) => e.name === '.git')) {
          found.push(dir.path);
          continue; // a checkout: don't look for nested repos inside it
        }
        if (dir.left <= 0) continue;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
          next.push({ path: join(dir.path, entry.name), left: dir.left - 1 });
        }
      }
    }
    frontier = next;
  }
  return found.slice(0, limit);
}

async function git(
  cwd: string,
  env: Readonly<Record<string, string>>,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  const result = await execa('git', ['--no-optional-locks', '-C', cwd, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    extendEnv: false,
    reject: false,
    timeout: Math.max(50, timeoutMs),
  });
  return result.exitCode === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : null;
}

/** Branch, last commit time and dirty flag of one checkout (each null/false when git can't tell in time). */
export async function describeRepo(
  path: string,
  env: Readonly<Record<string, string>>,
  deadline: number,
): Promise<DiscoveredRepo> {
  const left = () => deadline - Date.now();
  const [log, branch, status] = await Promise.all([
    git(path, env, ['log', '-1', '--format=%ct'], left()),
    git(path, env, ['rev-parse', '--abbrev-ref', 'HEAD'], left()),
    git(path, env, ['status', '--porcelain', '--untracked-files=no'], left()),
  ]);
  const seconds = log ? Number.parseInt(log, 10) : Number.NaN;
  return {
    path,
    name: basename(path),
    branch: branch && branch !== 'HEAD' ? branch : null,
    dirty: status !== null && status.length > 0,
    lastCommitAt: Number.isFinite(seconds) ? seconds * 1000 : null,
  };
}

/** Newest commit first; repos without a known commit time last, by name. */
export function sortDiscovered(repos: DiscoveredRepo[]): DiscoveredRepo[] {
  return [...repos].sort(
    (a, b) =>
      (b.lastCommitAt ?? -1) - (a.lastCommitAt ?? -1) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
}

export interface DiscoverOptions {
  roots: readonly DiscoverRoot[];
  env: Readonly<Record<string, string>>;
  /** Total time budget for walking and describing (default 1500 ms). */
  budgetMs?: number;
  /** Concurrent git describes (default 8). */
  concurrency?: number;
}

/** Find and describe the repositories under `roots` within the time budget. */
export async function discoverRepos(options: DiscoverOptions): Promise<DiscoveredRepo[]> {
  const started = Date.now();
  const budget = options.budgetMs ?? 1500;
  // Leave at least a third of the budget for describing what the walk found.
  const dirs = await findRepoDirs(options.roots, started + budget * 0.66);
  const deadline = started + budget;
  const results: DiscoveredRepo[] = [];
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const path = dirs[next++] as string;
      if (Date.now() >= deadline) {
        results.push({ path, name: basename(path), branch: null, dirty: false, lastCommitAt: null });
        continue;
      }
      results.push(await describeRepo(path, options.env, deadline));
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 8 }, worker));
  return sortDiscovered(results);
}

/** A small TTL cache around `discoverRepos`, keyed by the root set (concurrent callers share one scan). */
export class DiscoveryCache {
  private entry: { key: string; at: number; value: Promise<DiscoveredRepo[]> } | null = null;

  constructor(private readonly ttlMs = 120_000) {}

  get(options: DiscoverOptions, refresh = false): Promise<DiscoveredRepo[]> {
    const key = JSON.stringify(options.roots);
    const now = Date.now();
    if (!refresh && this.entry && this.entry.key === key && now - this.entry.at < this.ttlMs) return this.entry.value;
    const value = discoverRepos(options);
    this.entry = { key, at: now, value };
    value.catch(() => {
      if (this.entry?.value === value) this.entry = null;
    });
    return value;
  }
}

/** Local and remote branches of a repo; the default branch follows `repos.inspect`'s rule. */
export async function listBranches(path: string, env: Readonly<Record<string, string>>): Promise<RepoBranches> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return { current: null, default: null, local: [], remote: [] };
  const run = (args: string[]) => git(path, env, args, 10_000);
  const [current, originHead, localRaw, remoteRaw] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['rev-parse', '--abbrev-ref', 'origin/HEAD']),
    run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
    run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes']),
  ]);
  const lines = (raw: string | null) =>
    raw
      ? raw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const local = lines(localRaw);
  // `origin` alone is how `refs/remotes/origin/HEAD` prints itself; skip it and other symbolic HEADs.
  const remote = lines(remoteRaw).filter((r) => r.includes('/') && !r.endsWith('/HEAD'));
  const head = current && current !== 'HEAD' ? current : null;
  let fallback: string | null = null;
  if (originHead && originHead !== 'origin/HEAD') fallback = originHead.replace(/^origin\//, '');
  fallback ??= ['main', 'master'].find((b) => local.includes(b)) ?? head;
  return { current: head, default: fallback, local, remote };
}
