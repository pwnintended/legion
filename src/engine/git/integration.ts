import { identityArgs, NO_HOOKS, RERERE } from './changes';
import { GitError, git, gitSucceeds, gitText, splitZ, withRepoLock } from './exec';
import { isLockfilePath } from './provision';
import { headSha, isDirty } from './repo';

/** A precondition on the worktree (dirty, merge in progress, ...) failed before anything was changed. */
export class IntegrationError extends Error {
  override readonly name = 'IntegrationError';
}

// ---------------------------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------------------------

export interface MergeForecast {
  clean: boolean;
  /** Resulting tree (for conflicts: the tree with conflict markers committed in). */
  tree: string;
  conflictFiles: string[];
  /** Informational messages from merge-tree (CONFLICT lines etc.). */
  messages: string;
}

/** Parse `git merge-tree --write-tree --name-only -z` output. */
export function parseMergeTree(output: string, exitCode: number): MergeForecast {
  const parts = output.split('\0');
  const tree = parts[0] ?? '';
  const files: string[] = [];
  let i = 1;
  for (; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p === '') {
      i++;
      break;
    }
    files.push(p);
  }
  const messages = parts.slice(i).join('\0').replace(/\0+$/, '').replace(/\0/g, '\n');
  return { clean: exitCode === 0, tree, conflictFiles: [...new Set(files)].sort(), messages };
}

/**
 * Predict merging `theirs` into `ours` without touching any worktree or ref (objects only).
 * Needs no lock (it only adds unreachable objects).
 */
export async function forecastMerge(repo: string, ours: string, theirs: string): Promise<MergeForecast> {
  const r = await git(repo, ['merge-tree', '--write-tree', '--name-only', '-z', ours, theirs], {
    okExitCodes: [0, 1],
  });
  return parseMergeTree(r.stdout, r.exitCode);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Paths with unresolved conflicts (unmerged index entries), sorted. */
export async function unmergedFiles(worktree: string): Promise<string[]> {
  const out = (await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout;
  return splitZ(out).sort();
}

export async function isMergeInProgress(worktree: string): Promise<boolean> {
  return gitSucceeds(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
}

async function assertCleanWorktree(worktree: string, what: string): Promise<void> {
  if (await isMergeInProgress(worktree))
    throw new IntegrationError(`${what}: a merge is already in progress in ${worktree}`);
  if (await isDirty(worktree)) throw new IntegrationError(`${what}: worktree ${worktree} has uncommitted changes`);
}

// ---------------------------------------------------------------------------------------------
// Integration worktree operations
// ---------------------------------------------------------------------------------------------

export type SquashMergeResult =
  | {
      ok: true;
      mergedSha: string;
      preMergeSha: string;
      /** The task introduced no changes relative to integration; no commit was made (`mergedSha === preMergeSha`). */
      empty: boolean;
    }
  | { ok: false; conflict: true; files: string[]; preMergeSha: string };

/**
 * Squash-merge `taskBranch` into the integration worktree's branch and commit with `message`.
 * Requires a clean integration worktree (call {@link resetIntegration} first after a failed verify).
 * Conflict -> the worktree is hard-reset to the pre-merge sha, i.e. left exactly as it was.
 * Any other failure (e.g. commit refused) also resets before rethrowing.
 */
export async function squashMergeIntoIntegration(
  integrationWorktree: string,
  taskBranch: string,
  message: string,
): Promise<SquashMergeResult> {
  return withRepoLock(integrationWorktree, async () => {
    await assertCleanWorktree(integrationWorktree, 'squash merge');
    const preMergeSha = await headSha(integrationWorktree);
    const merge = await git(
      integrationWorktree,
      [...NO_HOOKS, ...RERERE, 'merge', '--squash', '--no-commit', taskBranch],
      {
        okExitCodes: [0, 1],
      },
    );
    try {
      if (merge.exitCode === 1) {
        const files = await unmergedFiles(integrationWorktree);
        if (files.length === 0)
          throw new GitError('git', ['merge', '--squash'], integrationWorktree, 1, merge.stderr, merge.stdout);
        await git(integrationWorktree, ['reset', '--hard', preMergeSha]);
        return { ok: false, conflict: true, files, preMergeSha } as const;
      }
      const hasChanges =
        (await git(integrationWorktree, ['diff', '--cached', '--quiet'], { okExitCodes: [0, 1] })).exitCode === 1;
      if (!hasChanges) return { ok: true, mergedSha: preMergeSha, preMergeSha, empty: true } as const;
      const id = await identityArgs(integrationWorktree);
      await git(integrationWorktree, [...id, ...NO_HOOKS, 'commit', '--no-verify', '--no-gpg-sign', '-F', '-'], {
        input: message,
      });
      return { ok: true, mergedSha: await headSha(integrationWorktree), preMergeSha, empty: false } as const;
    } catch (e) {
      await git(integrationWorktree, ['reset', '--hard', preMergeSha]).catch(() => undefined);
      throw e;
    }
  });
}

/**
 * `git reset --hard <sha>` + `git clean -fd` (ignored files are kept) in the integration worktree.
 * Only ever use on Legion's own integration worktree.
 */
export async function resetIntegration(integrationWorktree: string, sha: string): Promise<void> {
  await withRepoLock(integrationWorktree, async () => {
    await git(integrationWorktree, ['merge', '--abort'], { okExitCodes: [0, 128] });
    await git(integrationWorktree, ['reset', '--hard', sha]);
    await git(integrationWorktree, ['clean', '-fd']);
  });
}

// ---------------------------------------------------------------------------------------------
// Task worktree operations (fix / conflict-resolution flows)
// ---------------------------------------------------------------------------------------------

export type MergeIntoTaskResult =
  | { status: 'up_to_date'; sha: string }
  /** Merged cleanly (fast-forward or merge commit). */
  | { status: 'merged'; sha: string }
  /** Conflicts left in the worktree with markers; MERGE_HEAD is set. Resolve then {@link finishMerge}. */
  | { status: 'conflict'; files: string[] };

/**
 * Merge `integrationRef` into the task worktree's branch. On conflict the markers and merge state are
 * left in place (so a resolver agent can work on them) and the conflicting files are returned.
 */
export async function mergeIntoTaskBranch(taskWorktree: string, integrationRef: string): Promise<MergeIntoTaskResult> {
  return withRepoLock(taskWorktree, async () => {
    await assertCleanWorktree(taskWorktree, 'merge into task branch');
    const before = await headSha(taskWorktree);
    const id = await identityArgs(taskWorktree);
    const r = await git(
      taskWorktree,
      [
        ...id,
        ...NO_HOOKS,
        ...RERERE,
        'merge',
        '--no-edit',
        '--no-gpg-sign',
        '-m',
        `Merge ${integrationRef} into task branch`,
        integrationRef,
      ],
      { okExitCodes: [0, 1] },
    );
    if (r.exitCode === 1) {
      const files = await unmergedFiles(taskWorktree);
      if (files.length > 0) return { status: 'conflict', files } as const;
      throw new GitError('git', ['merge', integrationRef], taskWorktree, 1, r.stderr, r.stdout);
    }
    const sha = await headSha(taskWorktree);
    return { status: sha === before ? 'up_to_date' : 'merged', sha } as const;
  });
}

export async function abortMerge(worktree: string): Promise<void> {
  await withRepoLock(worktree, async () => {
    await git(worktree, [...RERERE, 'merge', '--abort'], { okExitCodes: [0, 128] });
  });
}

/**
 * Conclude a conflicted merge after the files were edited: stages everything and commits. Refuses
 * (IntegrationError) while any path still has unmerged index entries *after staging* or while files
 * still contain `<<<<<<<` markers.
 */
export async function finishMerge(worktree: string, message?: string): Promise<{ sha: string }> {
  return withRepoLock(worktree, async () => {
    if (!(await isMergeInProgress(worktree))) throw new IntegrationError('no merge in progress');
    await git(worktree, ['add', '-A']);
    const stillUnmerged = await unmergedFiles(worktree);
    if (stillUnmerged.length > 0) throw new IntegrationError(`unresolved conflicts: ${stillUnmerged.join(', ')}`);
    const markers = await git(worktree, ['grep', '--cached', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', '--', '.'], {
      okExitCodes: [0, 1],
    });
    // Only flag files that are part of the merge (avoid false positives in unrelated fixtures/docs).
    const mergeFiles = new Set(splitZ((await git(worktree, ['diff', '--cached', '--name-only', '-z', 'HEAD'])).stdout));
    const flagged = markers.stdout
      .split('\n')
      .filter(Boolean)
      .filter((f) => mergeFiles.has(f));
    if (flagged.length > 0) throw new IntegrationError(`conflict markers remain in: ${flagged.join(', ')}`);
    const id = await identityArgs(worktree);
    await git(worktree, [
      ...id,
      ...NO_HOOKS,
      ...RERERE,
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      ...(message ? ['-m', message] : ['--no-edit']),
    ]);
    return { sha: await headSha(worktree) };
  });
}

// ---------------------------------------------------------------------------------------------
// Lockfile policy
// ---------------------------------------------------------------------------------------------

export interface LockfileResolution {
  /** Lockfile conflicts resolved by taking one side (staged). */
  resolved: string[];
  /** Conflicts that are not lockfiles (or could not be auto-resolved). Never hand-merged. */
  remaining: string[];
}

/**
 * Lockfiles are never LLM/hand-merged: take one side wholesale and stage it. The caller must then
 * re-run the install command so the lockfile is regenerated consistently. In a merge of integration
 * into a task branch, `ours` = the task's lockfile and `theirs` = integration's (usually what you want).
 */
export async function resolveLockfileConflicts(
  worktree: string,
  conflictFiles: readonly string[],
  side: 'ours' | 'theirs',
): Promise<LockfileResolution> {
  return withRepoLock(worktree, async () => {
    const resolved: string[] = [];
    const remaining: string[] = [];
    for (const f of conflictFiles) {
      if (!isLockfilePath(f)) {
        remaining.push(f);
        continue;
      }
      try {
        await git(worktree, ['checkout', `--${side}`, '--', f]);
        await git(worktree, ['add', '--', f]);
        resolved.push(f);
      } catch {
        remaining.push(f);
      }
    }
    return { resolved, remaining };
  });
}

/** Current branch tip of `ref` (convenience for recording `Merge.preSha`). */
export function refSha(repo: string, ref: string): Promise<string> {
  return gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
