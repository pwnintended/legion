/**
 * `diff.get`: task = its diff base (`taskDiffBase`: `startSha`, or the integration commit last merged into
 * the task branch) → the task worktree including uncommitted and untracked changes (staged
 * into a throwaway index, so the worktree's own index is never touched); run = `base...integration`;
 * range = `from..to` in the run's repo.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffResult, DiffTarget } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { branchExists, git, parseUnifiedDiff } from '../git';
import { runMeta } from './meta';
import type { Orchestrator } from './orchestrator';
import { taskDiffBase } from './worktrees';

const DIFF_FLAGS = ['diff', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

function checkRev(rev: string): string {
  if (!rev || rev.startsWith('-') || /\s/.test(rev)) throw new RpcError('bad_request', `invalid revision "${rev}"`);
  return rev;
}

async function diffRange(repo: string, range: string, contextLines: number): Promise<string> {
  return (await git(repo, [...DIFF_FLAGS, `-U${contextLines}`, range, '--'])).stdout;
}

/** `from` → working tree of `worktree`, untracked files included. */
async function diffWorktree(worktree: string, from: string, contextLines: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'legion-diff-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await git(worktree, ['read-tree', 'HEAD'], { env });
    await git(worktree, ['add', '-A'], { env });
    return (await git(worktree, [...DIFF_FLAGS, `-U${contextLines}`, '--cached', from, '--'], { env })).stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function getDiff(
  o: Orchestrator,
  target: Exclude<DiffTarget, { kind: 'commit' }>,
  contextLines: number,
): Promise<DiffResult> {
  if (target.kind === 'task') {
    const task = o.store.requireTask(target.taskId);
    const run = o.store.requireRun(task.runId);
    if (!task.startSha) return { from: '', to: '', files: [] };
    if (task.worktreePath && existsSync(task.worktreePath)) {
      const from = (await taskDiffBase(run, task, task.worktreePath)) ?? task.startSha;
      const text = await diffWorktree(task.worktreePath, from, contextLines);
      return { from, to: 'WORKTREE', files: parseUnifiedDiff(text) };
    }
    if (task.branch && (await branchExists(run.repoPath, task.branch))) {
      const from = (await taskDiffBase(run, task, run.repoPath, task.branch)) ?? task.startSha;
      const text = await diffRange(run.repoPath, `${from}..${task.branch}`, contextLines);
      return { from, to: task.branch, files: parseUnifiedDiff(text) };
    }
    return { from: task.startSha, to: task.startSha, files: [] };
  }
  const run = o.store.requireRun(target.runId);
  if (target.kind === 'run') {
    if (!run.integrationBranch) return { from: run.baseRef, to: run.baseRef, files: [] };
    const base = (await branchExists(run.repoPath, run.baseRef))
      ? run.baseRef
      : (runMeta(o.store, run.id).baseSha ?? run.baseRef);
    const text = await diffRange(run.repoPath, `${base}...${run.integrationBranch}`, contextLines);
    return { from: base, to: run.integrationBranch, files: parseUnifiedDiff(text) };
  }
  const from = checkRev(target.from);
  const to = checkRev(target.to);
  const text = await diffRange(run.repoPath, `${from}..${to}`, contextLines);
  return { from, to, files: parseUnifiedDiff(text) };
}
