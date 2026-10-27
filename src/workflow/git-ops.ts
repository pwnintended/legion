/**
 * The workflow SDK's git operations over `src/git`. Worktrees live outside the repository, under
 * `~/.legion/worktrees/<repo>-<hash>/<runId>/<name>`, so the user's checkout (and the assistant's searches in it)
 * never see them. Branches are `legion/<run>/integration` and `legion/<run>/<name>`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  branchExists,
  changedFiles,
  checkDiskSpace,
  commitAll,
  createWorktree,
  currentBranch,
  defaultBranch,
  finishMerge,
  ghPrHost,
  git,
  gitText,
  integrationBranchName,
  isDirty,
  listWorktrees,
  lockWorktree,
  mergeIntoBase,
  mergeIntoTaskBranch,
  type PrHost,
  removeWorktree,
  repoHash,
  resolveSha,
  squashMergeIntoIntegration,
  taskBranchName,
  toplevel,
  untrackedFiles,
  type WarmSettings,
  warmWorktree,
  withRepoLock,
} from '../git/index.ts';
import { type Logger, silentLogger } from '../util/log.ts';
import type { GitOps, Worktree } from './host.ts';

export interface GitOpsOptions {
  repo: string;
  /** Default `~/.legion/worktrees`. */
  worktreeRoot?: string;
  prHost?: PrHost;
  /** How new worktrees are prepared (`[worktrees]`), read each time one is made. */
  warm?: () => WarmSettings;
  log?: Logger;
}

/**
 * Where Legion keeps a repository's worktrees: `~/.legion/worktrees/<repo>-<hash>` (`repo`: its top level).
 * `LEGION_WORKTREES` moves the parent directory (the tests use a temporary one).
 */
export function worktreeRoot(
  repo: string,
  base = process.env.LEGION_WORKTREES || join(homedir(), '.legion', 'worktrees'),
): string {
  return join(base, `${basename(repo)}-${repoHash(repo)}`);
}

export async function createGitOps(opts: GitOpsOptions): Promise<GitOps> {
  const repo = await toplevel(opts.repo);
  const root = worktreeRoot(repo, opts.worktreeRoot);
  const prHost = opts.prHost ?? ghPrHost;
  const log = opts.log ?? silentLogger;

  /** Disk check before, build caches and setup commands after a worktree is made. */
  const beforeCreate = async () => {
    if (opts.warm) await checkDiskSpace(root, opts.warm().minFreeGb);
  };
  const afterCreate = async (path: string) => {
    if (!opts.warm) return;
    const { cloned, warnings } = await warmWorktree(repo, path, opts.warm());
    if (cloned.length) log.info(`worktree ${path}: cloned ${cloned.join(', ')}`);
    for (const w of warnings) log.warn(`worktree ${path}: ${w}`);
  };

  const branchOrNull = async (rev: string): Promise<string | null> => ((await branchExists(repo, rev)) ? rev : null);

  const open = async (runId: string, name: string, branch: string, from: string | null): Promise<Worktree> => {
    const path = join(root, runId, name);
    const baseBranch = from ? await branchOrNull(from) : await currentBranch(repo);
    if (await branchExists(repo, branch)) {
      // A retried step after a crash between `worktree add` and the journal entry: reuse what is there.
      const wt: Worktree = { name, branch, path, baseSha: await resolveSha(repo, from ?? 'HEAD'), baseBranch };
      await restore(wt);
      return wt;
    }
    const startSha = await resolveSha(repo, from ?? 'HEAD');
    await beforeCreate();
    await createWorktree({ repo, path, branch, startSha });
    await afterCreate(path);
    return { name, branch, path, baseSha: startSha, baseBranch };
  };

  const restore = async (wt: Worktree): Promise<void> => {
    if (existsSync(wt.path)) return;
    await beforeCreate();
    await withRepoLock(repo, async () => {
      // A registered worktree whose directory vanished blocks `worktree add` for its branch; drop just that entry.
      await git(repo, ['worktree', 'remove', '--force', wt.path], { okExitCodes: [0, 128] });
      await git(repo, ['worktree', 'add', wt.path, wt.branch]);
    });
    await lockWorktree(repo, wt.path);
    await afterCreate(wt.path);
  };

  /** Agents leave their work uncommitted; merging needs it in a commit. */
  const commitPending = async (wt: Worktree, message: string) => {
    if (await isDirty(wt.path)) await commitAll(wt.path, message);
  };

  return {
    integration: (runId, { base }) => open(runId, 'integration', integrationBranchName(runId), base),

    worktree: (runId, name, { from }) => open(runId, name, taskBranchName(runId, name), from),

    async commit(wt, message) {
      const result = await commitAll(wt.path, message);
      return { sha: result.committed ? result.sha : null };
    },

    async squashMerge(wt, into, message) {
      await commitPending(wt, message);
      const result = await squashMergeIntoIntegration(into.path, wt.branch, message, { cleanFirst: [] });
      return result.ok
        ? { ok: true, sha: result.empty ? null : result.mergedSha }
        : { ok: false, conflicts: result.files };
    },

    async mergeInto(wt, from) {
      await commitPending(wt, `WIP ${wt.name}`);
      const result = await mergeIntoTaskBranch(wt.path, from.branch);
      return result.status === 'conflict' ? { ok: false, conflicts: result.files } : { ok: true, sha: result.sha };
    },

    finishMerge: (wt, message) => finishMerge(wt.path, message),

    async diff(wt, { against }) {
      return gitText(wt.path, ['diff', '--no-color', '--no-ext-diff', '-M', against ?? wt.baseSha, '--']);
    },

    async changedFiles(wt) {
      const [tracked, untracked] = await Promise.all([
        changedFiles(wt.path, wt.baseSha, null),
        untrackedFiles(wt.path),
      ]);
      return [...new Set([...tracked.map((f) => f.path), ...untracked])];
    },

    async draftPr(wt, { title, body, base }) {
      const existing = await prHost.prStatus(repo, wt.branch);
      if (existing && existing.state === 'open') return { url: existing.url };
      const target = base ?? wt.baseBranch ?? (await defaultBranch(repo));
      if (!target) throw new Error('Cannot tell which branch the PR should target; pass `base`');
      await prHost.push(repo, wt.branch);
      const pr = await prHost.createDraftPr({ repoPath: repo, base: target, head: wt.branch, title, body });
      return { url: pr.url };
    },

    async mergeToBase(wt, { base, message }) {
      const target = base ?? wt.baseBranch ?? (await defaultBranch(repo));
      if (!target) throw new Error('Cannot tell which branch to merge into; pass `base`');
      return { sha: await mergeIntoBase(repo, target, wt.branch, message) };
    },

    remove: (wt) => removeWorktree({ repo, path: wt.path, branch: null }),

    async release(runId) {
      // Every worktree of the run; the branches stay (a resumed run re-creates what it needs from them).
      const dir = join(root, runId);
      // git reports resolved paths (/private/var on macOS for /var).
      const dirs = existsSync(dir) ? [dir, realpathSync(dir)] : [dir];
      for (const w of await listWorktrees(repo)) {
        if (dirs.some((d) => w.path === d || w.path.startsWith(`${d}/`))) {
          await removeWorktree({ repo, path: w.path, branch: null });
        }
      }
      await rm(dir, { recursive: true, force: true });
    },

    restore,
  };
}
