import { createHash } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { runShort, slugify } from '@shared/ids';
import { git, gitText, withRepoLock } from './exec';
import { branchExists, toplevel } from './repo';

// ---------------------------------------------------------------------------------------------
// Naming (architecture §9)
// ---------------------------------------------------------------------------------------------

/** Stable short hash of a repository's real top-level path. */
export function repoHash(repoToplevel: string): string {
  return createHash('sha1').update(repoToplevel).digest('hex').slice(0, 12);
}

export function runDir(legionHome: string, repoHashValue: string, runId: string): string {
  return join(legionHome, 'worktrees', repoHashValue, runId);
}

export function taskWorktreePath(legionHome: string, repoHashValue: string, runId: string, taskId: string): string {
  return join(runDir(legionHome, repoHashValue, runId), taskId);
}

export function integrationWorktreePath(legionHome: string, repoHashValue: string, runId: string): string {
  return join(runDir(legionHome, repoHashValue, runId), '_integration');
}

export function integrationBranchName(runId: string): string {
  return `legion/${runShort(runId)}/integration`;
}

export function taskBranchName(runId: string, taskId: string, title: string): string {
  return `legion/${runShort(runId)}/${taskId}-${slugify(title)}`;
}

// ---------------------------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------------------------

/** Enable rerere (resolutions live in the shared common dir, reusable across worktrees). */
export async function enableRerere(repo: string): Promise<void> {
  await withRepoLock(repo, async () => {
    await git(repo, ['config', 'rerere.enabled', 'true']);
  });
}

/** Set `gc.auto=0`. Returns the previous local value (null if unset) for {@link restoreGcAuto}. */
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
 * `git worktree add -b <branch> <path> <startSha>`, enable rerere, lock. On failure nothing is left
 * behind except possibly an empty parent directory (a failed lock removes the new worktree again).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<void> {
  const { repo, branch, startSha } = input;
  const path = resolve(input.path);
  const reason = input.lockReason === undefined ? 'legion' : input.lockReason;
  await mkdir(dirname(path), { recursive: true });
  await withRepoLock(repo, async () => {
    await git(repo, ['config', 'rerere.enabled', 'true']);
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
 * Unlock + remove the worktree, delete `branch` (if given and it exists), prune stale entries.
 * Idempotent: a missing worktree directory or branch is fine.
 */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<void> {
  const { repo } = input;
  const path = resolve(input.path);
  const force = input.force ?? true;
  await withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'unlock', path], { okExitCodes: [0, 128] });
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) {
      try {
        await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
      } catch (e) {
        // Not a registered worktree (already pruned) — fall through to prune/branch cleanup.
        const registered = (await listWorktreesUnlocked(repo)).some((w) => samePath(w.path, path));
        if (registered) throw e;
      }
    }
    await git(repo, ['worktree', 'prune']);
    if (input.branch && (await branchExists(repo, input.branch))) {
      await git(repo, ['branch', force ? '-D' : '-d', input.branch]);
    }
  });
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'prune']);
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

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
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
 * Compare `git worktree list` with the worktrees the DB expects.
 * `managedRoot` limits orphan detection to Legion's own directory (e.g. `<legionHome>/worktrees`),
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
