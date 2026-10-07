/** Worktree helpers of the lifecycle: integration worktree, task worktree restore, run-level verify. */
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Run, Task, TaskNode, VerificationPhase } from '@shared/domain';
import {
  branchExists,
  type CommandResult,
  cleanWorktree,
  createWorktree,
  git,
  gitText,
  integrationBranchName,
  isAncestor,
  type LegionConfig,
  provisionFiles,
  reconcile,
  removeWorktree,
  resolveSha,
  runShellCommands,
  untrackedFiles,
  withRepoLock,
} from '../git';
import type { VerifyResultInput } from './core';
import { patchRunMeta, runMeta } from './meta';
import type { Orchestrator } from './orchestrator';

/**
 * Make sure `path` is a registered worktree with `branch` checked out. A missing worktree is restored
 * from the existing branch, or created at `startSha` when the branch does not exist either.
 */
export async function ensureWorktree(
  repo: string,
  path: string,
  branch: string,
  startSha: string | null,
): Promise<'present' | 'restored' | 'created'> {
  const state = await reconcile(repo, [{ path, branch }]);
  if (state.missing.length === 0) return 'present';
  await removeWorktree({ repo, path });
  await rm(path, { recursive: true, force: true });
  if (await branchExists(repo, branch)) {
    await mkdir(dirname(path), { recursive: true });
    await withRepoLock(repo, async () => {
      await git(repo, ['worktree', 'add', path, branch]);
      await git(repo, ['worktree', 'lock', '--reason', 'legion', path]);
    });
    return 'restored';
  }
  if (!startSha) throw new Error(`branch ${branch} no longer exists`);
  await createWorktree({ repo, path, branch, startSha });
  return 'created';
}

/** The run's integration worktree (`legion/<run>/integration` at the base sha). Returns its path. */
export async function ensureIntegrationWorktree(o: Orchestrator, run: Run): Promise<string> {
  const path = o.integrationPath(run);
  const meta = runMeta(o.store, run.id);
  let baseSha = meta.baseSha;
  if (!baseSha) {
    baseSha = await resolveSha(run.repoPath, run.baseRef);
    patchRunMeta(o.store, run.id, { baseSha });
  }
  await ensureWorktree(run.repoPath, path, integrationBranchName(run.id), baseSha);
  return path;
}

/**
 * Integration HEAD as of the last *finished* merge (or the base). A merge in flight may still be reverted
 * by its post-merge verify, so new task worktrees must not start from it.
 */
export async function confirmedIntegrationSha(o: Orchestrator, run: Run): Promise<string> {
  await ensureIntegrationWorktree(o, run);
  const merged = o.store
    .listMerges(run.id)
    .filter((m) => m.status === 'merged' && m.postSha)
    .at(-1);
  if (merged?.postSha) return merged.postSha;
  return runMeta(o.store, run.id).baseSha ?? resolveSha(run.repoPath, run.baseRef);
}

export function toVerifyInput(result: CommandResult): VerifyResultInput {
  return {
    command: result.command,
    exitCode: result.exitCode,
    outputTail: result.outputTail,
    durationMs: result.durationMs,
  };
}

/** Run commands in `cwd` (stopping at the first failure) and record each as a `Verification`. */
export async function runVerification(
  o: Orchestrator,
  input: {
    run: Run;
    task: Task | null;
    attemptId: string | null;
    phase: VerificationPhase;
    commands: readonly string[];
    cwd: string;
  },
): Promise<{ ok: boolean; results: VerifyResultInput[] }> {
  const outcome = await runShellCommands(input.commands, {
    cwd: input.cwd,
    env: { rootPath: input.run.repoPath, runId: input.run.id, taskId: input.task?.id ?? '_integration' },
  });
  o.assertOpen();
  for (const r of outcome.results) {
    o.store.insertVerification({
      runId: input.run.id,
      taskId: input.task?.id ?? null,
      attemptId: input.attemptId,
      phase: input.phase,
      command: r.command,
      exitCode: r.exitCode,
      outputTail: r.outputTail,
      durationMs: r.durationMs,
    });
  }
  return { ok: outcome.ok, results: outcome.results.map(toVerifyInput) };
}

/** Copy/symlink files and run `legion.json` setup in the integration worktree, once per run. */
export async function provisionIntegration(o: Orchestrator, run: Run, config: LegionConfig | null): Promise<void> {
  if (runMeta(o.store, run.id).integrationReady) return;
  const path = await ensureIntegrationWorktree(o, run);
  if (config) await provisionFiles(run.repoPath, path, config);
  const setup = config?.setup ?? [];
  if (setup.length > 0) {
    const outcome = await runVerification(o, {
      run,
      task: null,
      attemptId: null,
      phase: 'setup',
      commands: setup,
      cwd: path,
    });
    if (!outcome.ok) o.log.warn(`run ${run.id}: integration setup failed`);
  }
  // What provisioning left untracked (copies, setup output) stays; anything else setup changed is reset.
  const keep = await untrackedFiles(path);
  await cleanWorktree(path, keep);
  patchRunMeta(o.store, run.id, { integrationReady: true, integrationKeep: keep });
}

/** Untracked files Legion provisioned into the run's integration worktree (kept when it is cleaned). */
export function integrationKeep(o: Orchestrator, run: Pick<Run, 'id'>): string[] {
  return runMeta(o.store, run.id).integrationKeep;
}

/**
 * Where the task's own changes start: the merge-base of the task branch (`rev` in `cwd`) with the
 * integration branch. That is `startSha` until integration is merged into the task branch (post-merge fix
 * round, conflict resolution), then the merged integration commit, so diffs, the scope check and the
 * reviewer never blame the task for other tasks' code. Falls back to `startSha` when integration was reset
 * below it.
 */
export async function taskDiffBase(
  run: Pick<Run, 'id'>,
  task: Pick<Task, 'startSha'>,
  cwd: string,
  rev = 'HEAD',
): Promise<string | null> {
  const start = task.startSha;
  if (!start) return null;
  const base = await gitText(cwd, ['merge-base', rev, integrationBranchName(run.id)]).catch(() => null);
  if (!base || base === start) return start;
  return (await isAncestor(cwd, start, base)) ? base : start;
}

/** Task verify commands plus the repo-wide ones, deduplicated. */
export function verifyCommands(node: TaskNode, config: LegionConfig | null): string[] {
  return [...new Set([...node.verify.commands, ...(config?.verify ?? [])].map((c) => c.trim()).filter(Boolean))];
}
