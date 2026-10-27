/**
 * Lead workspaces: each lead (whose role has `workspace: branch`) works in its own git worktree on its own branch,
 * `legion/lead/<name>` under `~/.legion/worktrees/<repo>-<hash>/leads/<name>`, started from its parent's branch
 * (the orchestrator's is the branch checked out in the user's checkout). Its runs start from and merge into that
 * branch; its parent merges the branch up with `merge_lead`. So leads never share a checkout, never commit on the
 * user's branch behind their back, and never improvise worktrees of their own.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  branchExists,
  checkDiskSpace,
  commitAll,
  createWorktree,
  currentBranch,
  git,
  isDirty,
  lockWorktree,
  mergeIntoBase,
  resolveSha,
  type WarmSettings,
  warmWorktree,
  withRepoLock,
} from '../git/index.ts';
import { type Logger, silentLogger } from '../util/log.ts';
import { worktreeRoot } from '../workflow/git-ops.ts';

export interface LeadWorkspace {
  path: string;
  branch: string;
  /** The branch it started from and merges into (null until created: the user's branch at that time). */
  base: string | null;
}

export interface Workspaces {
  /** Where a lead's worktree goes and its branch (nothing is created yet). */
  plan(lead: string, base: string | null): LeadWorkspace;
  /** Creates the worktree (or re-adds it from its branch when the directory is gone); fills in `base`. */
  ensure(ws: LeadWorkspace): Promise<void>;
  /** Commits what is left uncommitted in the workspace, then merges its branch into `into`. */
  merge(ws: LeadWorkspace, into: string, message: string): Promise<{ sha: string; files: string[] }>;
  /** Uncommitted paths in a checkout (what runs started from its branch will not see). */
  uncommitted(path: string): Promise<string[]>;
  /** The user's checkout: its path and checked-out branch (null when detached). */
  main(): Promise<{ path: string; branch: string | null }>;
}

export function createWorkspaces(
  repo: string,
  opts: { root?: string; warm?: () => WarmSettings; log?: Logger } = {},
): Workspaces {
  const root = opts.root ?? join(worktreeRoot(repo), 'leads');
  const log = opts.log ?? silentLogger;
  return {
    plan: (lead, base) => ({ path: join(root, lead), branch: `legion/lead/${lead}`, base }),

    async ensure(ws) {
      if (ws.base === null) ws.base = (await currentBranch(repo)) ?? (await resolveSha(repo, 'HEAD'));
      if (existsSync(ws.path)) return;
      if (opts.warm) await checkDiskSpace(dirname(ws.path), opts.warm().minFreeGb);
      if (await branchExists(repo, ws.branch)) {
        await withRepoLock(repo, async () => {
          // A registered worktree whose directory vanished blocks `worktree add` for its branch.
          await git(repo, ['worktree', 'remove', '--force', ws.path], { okExitCodes: [0, 128] });
          await git(repo, ['worktree', 'add', ws.path, ws.branch]);
        });
        await lockWorktree(repo, ws.path);
      } else {
        await createWorktree({ repo, path: ws.path, branch: ws.branch, startSha: await resolveSha(repo, ws.base) });
      }
      if (opts.warm) {
        const { cloned, warnings } = await warmWorktree(repo, ws.path, opts.warm());
        if (cloned.length) log.info(`lead worktree ${ws.path}: cloned ${cloned.join(', ')}`);
        for (const w of warnings) log.warn(`lead worktree ${ws.path}: ${w}`);
      }
    },

    async merge(ws, into, message) {
      if (existsSync(ws.path) && (await isDirty(ws.path))) await commitAll(ws.path, `${message} (uncommitted work)`);
      const before = await resolveSha(repo, into);
      const sha = await mergeIntoBase(repo, into, ws.branch, message);
      const files =
        sha === before
          ? []
          : (await git(repo, ['diff', '--name-only', before, sha])).stdout.split('\n').filter(Boolean);
      return { sha, files };
    },

    async uncommitted(path) {
      const out = (await git(path, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3));
    },

    async main() {
      return { path: repo, branch: await currentBranch(repo) };
    },
  };
}
