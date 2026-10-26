import { createHash } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { git, gitText, withRepoLock } from './exec.ts';
import { branchExists, toplevel } from './repo.ts';

// ---------------------------------------------------------------------------------------------
// Naming. Worktree paths are the caller's choice; branches are `legion/<runShort>/...`.
// ---------------------------------------------------------------------------------------------

/** Stable short hash of a repository's real top-level path (for callers laying out per-repo directories). */
export function repoHash(repoToplevel: string): string {
  return createHash('sha1').update(repoToplevel).digest('hex').slice(0, 12);
}

/** Branch-safe form of a run id used in git refs. Run ids (`20261026-2122-anhs`) already are; anything else is
 * reduced to a ref-safe component. */
export function runShort(runId: string): string {
  return refComponent(runId);
}

/** Lowercase, dash-separated, ascii-only slug for branch names. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'task';
}

/** A task name made safe for one ref path component (case kept: `T3` stays `T3`). */
function refComponent(name: string): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.lock$/, '');
  return safe.slice(0, 40).replace(/[-.]+$/g, '') || 'task';
}

export function integrationBranchName(runId: string): string {
  return `legion/${runShort(runId)}/integration`;
}

/** `legion/<runShort>/<name>` or, with a title, `legion/<runShort>/<name>-<slug(title)>`. */
export function taskBranchName(runId: string, name: string, title?: string): string {
  const base = refComponent(name);
  return `legion/${runShort(runId)}/${title ? `${base}-${slugify(title)}` : base}`;
}

// ---------------------------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------------------------

/**
 * Set `gc.auto=0` while Legion has worktrees active: an automatic `gc` also runs `worktree prune` and drops
 * unreachable objects (merge-tree forecasts). Returns the previous local value (null if unset) for
 * {@link restoreGcAuto}.
 */
export async function disableAutoGc(repo: string): Promise<string | null> {
  return withRepoLock(repo, async () => {
    const prev = await git(repo, ['config', '--local', '--get', 'gc.auto'], { okExitCodes: [0, 1] });
    const previous = prev.exitCode === 0 ? prev.stdout.trim() : null;
    await git(repo, ['config', '--local', 'gc.auto', '0']);
    return previous;
  });
}

export async function restoreGcAuto(repo: string, previous: string | null): Promise<void> {
  await withRepoLock(repo, async () => {
    if (previous === null) await git(repo, ['config', '--local', '--unset', 'gc.auto'], { okExitCodes: [0, 5] });
    else await git(repo, ['config', '--local', 'gc.auto', previous]);
  });
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

export interface CreateWorktreeInput {
  /** Any path inside the managed repo (usually the main checkout). */
  repo: string;
  path: string;
  branch: string;
  startSha: string;
  /** Lock reason; locked worktrees survive `git worktree prune`. Default: "legion". Null = don't lock. */
  lockReason?: string | null;
  /** Reuse an existing branch name by resetting it to `startSha` (`-B`), for retry attempts. */
  resetBranch?: boolean;
}

/**
 * `git worktree add -b <branch> <path> <startSha>`, lock. On failure nothing is left
 * behind except possibly an empty parent directory (a failed lock removes the new worktree again).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<void> {
  const { repo, branch, startSha } = input;
  const path = resolve(input.path);
  const reason = input.lockReason === undefined ? 'legion' : input.lockReason;
  await mkdir(dirname(path), { recursive: true });
  await withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'add', input.resetBranch ? '-B' : '-b', branch, path, startSha]);
    if (reason !== null) {
      try {
        await git(repo, ['worktree', 'lock', '--reason', reason, path]);
      } catch (e) {
        await git(repo, ['worktree', 'remove', '--force', path]).catch(() => undefined);
        await git(repo, ['branch', '-D', branch]).catch(() => undefined);
        throw e;
      }
    }
  });
}

export async function lockWorktree(repo: string, path: string, reason = 'legion'): Promise<void> {
  await withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'lock', '--reason', reason, path]);
  });
}

export async function unlockWorktree(repo: string, path: string): Promise<void> {
  await withRepoLock(repo, async () => {
    // exit 128 when already unlocked: treat as success.
    await git(repo, ['worktree', 'unlock', path], { okExitCodes: [0, 128] });
  });
}

export interface RemoveWorktreeInput {
  repo: string;
  path: string;
  /** Delete this local branch after removing the worktree. */
  branch?: string | null;
  /** Remove even with uncommitted changes / while locked. Default true. */
  force?: boolean;
}

/**
 * Unlock + remove the worktree (also when its directory is already gone), then delete `branch` (if given
 * and it exists). Only this worktree's administrative entry is touched: no `git worktree prune`, which
 * would also drop the entries of the user's own worktrees whose directories are temporarily missing.
 * Idempotent: a missing worktree directory or branch is fine.
 */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<void> {
  const { repo } = input;
  const path = resolve(input.path);
  const force = input.force ?? true;
  await withRepoLock(repo, async () => {
    const target = await canonical(path);
    let registered = false;
    for (const w of await listWorktreesUnlocked(repo)) {
      if ((await canonical(w.path)) === target) registered = true;
    }
    if (registered) {
      await git(repo, ['worktree', 'unlock', path], { okExitCodes: [0, 128] });
      await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
    }
    if (input.branch && (await branchExists(repo, input.branch))) {
      await git(repo, ['branch', force ? '-D' : '-d', input.branch]);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Listing & reconcile
// ---------------------------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  head: string | null;
  /** Short branch name, null if detached/bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  /** Git considers the entry stale (directory gone). */
  prunable: boolean;
}

/** Parse `git worktree list --porcelain -z` output. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const rec of output.split('\0')) {
    if (rec === '') {
      if (cur) result.push(cur);
      cur = null;
      continue;
    }
    const space = rec.indexOf(' ');
    const key = space === -1 ? rec : rec.slice(0, space);
    const value = space === -1 ? '' : rec.slice(space + 1);
    if (key === 'worktree') {
      if (cur) result.push(cur);
      cur = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
      };
    } else if (cur) {
      if (key === 'HEAD') cur.head = value;
      else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') cur.detached = true;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'locked') {
        cur.locked = true;
        cur.lockReason = value || null;
      } else if (key === 'prunable') cur.prunable = true;
    }
  }
  if (cur) result.push(cur);
  return result;
}

async function listWorktreesUnlocked(repo: string): Promise<WorktreeInfo[]> {
  return parseWorktreeList((await git(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout);
}

/** All worktrees of the repo, the main checkout first. */
export function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  return listWorktreesUnlocked(repo);
}

async function canonical(p: string): Promise<string> {
  // Resolve symlinks (macOS /var -> /private/var) even when the leaf no longer exists.
  const abs = resolve(p);
  try {
    return await realpath(abs);
  } catch {
    try {
      return join(await realpath(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {
      return abs;
    }
  }
}

export interface ExpectedWorktree {
  path: string;
  branch?: string | null;
}

export interface ReconcileResult {
  /** Expected but not registered, directory missing, or registered on the wrong branch. */
  missing: ExpectedWorktree[];
  /** Registered under `managedRoot` (or, if omitted, anywhere but the main checkout) yet not expected. */
  orphaned: WorktreeInfo[];
  /** Expected and healthy. */
  present: WorktreeInfo[];
}

/**
 * Compare `git worktree list` with the worktrees the caller expects (e.g. from a run journal).
 * `managedRoot` limits orphan detection to Legion's own directory (where it creates worktrees),
 * so a user's own worktrees are never reported.
 */
export async function reconcile(
  repo: string,
  expected: readonly ExpectedWorktree[],
  opts: { managedRoot?: string } = {},
): Promise<ReconcileResult> {
  const listed = await listWorktrees(repo);
  const main = listed[0];
  const byPath = new Map<string, WorktreeInfo>();
  for (const w of listed) byPath.set(await canonical(w.path), w);
  const root = opts.managedRoot ? await canonical(opts.managedRoot) : null;

  const missing: ExpectedWorktree[] = [];
  const present: WorktreeInfo[] = [];
  const expectedPaths = new Set<string>();
  for (const e of expected) {
    const p = await canonical(e.path);
    expectedPaths.add(p);
    const info = byPath.get(p);
    const dirExists = await access(p).then(
      () => true,
      () => false,
    );
    if (!info || info.prunable || !dirExists || (e.branch && info.branch !== e.branch)) missing.push(e);
    else present.push(info);
  }

  const orphaned: WorktreeInfo[] = [];
  for (const [p, info] of byPath) {
    if (info === main || expectedPaths.has(p)) continue;
    if (root && !(p === root || p.startsWith(root + sep))) continue;
    orphaned.push(info);
  }
  return { missing, orphaned, present };
}

/** Convenience: repo top-level + hash for naming. */
export async function repoIdentity(repoPath: string): Promise<{ toplevel: string; hash: string }> {
  const top = await toplevel(repoPath);
  return { toplevel: top, hash: repoHash(top) };
}

/** The worktree's checked-out branch, or null if detached. Cheap helper for callers holding only a path. */
export async function worktreeBranch(worktree: string): Promise<string | null> {
  const r = await gitText(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r === 'HEAD' ? null : r;
}
