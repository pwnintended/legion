/**
 * After the PR (§8 step 9): PR status refresh (`runs.refreshPr` + polling of open PRs) and cleanup
 * (`runs.archive`, also run when the PR is merged or closed): worktrees and local branches go, `gc.auto` is
 * restored, the run is hidden from `runs.list`.
 */
import { rm } from 'node:fs/promises';
import { isTerminal, type PullRequest, RUN_TRANSITIONS, type Run } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { integrationBranchName, removeWorktree, repoHash, runDir } from '../git';
import { cancelRun } from './actions';
import { prInFlight } from './finalize';
import type { Orchestrator } from './orchestrator';
import { releaseRepo } from './repo-gc';

/** How often open PRs are re-read from the host. */
export const PR_POLL_MS = 3 * 60 * 1000;

const archiving = new Map<string, Promise<Run>>();
const refreshing = new Map<string, Promise<Run>>();

const isOpenPr = (run: Run): boolean =>
  !run.archived && run.integrationBranch !== null && (run.pr ? run.pr.state === 'open' : run.prUrl !== null);

/**
 * Re-read the run's PR. A merged or closed PR moves a still-open run to `done` and archives it.
 * Concurrent calls for one run share the work.
 */
export function refreshPr(o: Orchestrator, runId: string): Promise<Run> {
  const inFlight = refreshing.get(runId);
  if (inFlight) return inFlight;
  const job = doRefreshPr(o, runId).finally(() => refreshing.delete(runId));
  refreshing.set(runId, job);
  return job;
}

async function doRefreshPr(o: Orchestrator, runId: string): Promise<Run> {
  const run = o.store.requireRun(runId);
  if (!run.integrationBranch || (!run.pr && !run.prUrl)) {
    throw new RpcError('failed_precondition', `run ${runId} has no pull request`);
  }
  if (prInFlight.has(runId)) throw new RpcError('conflict', 'the pull request is still being created');
  let pr: PullRequest | null;
  try {
    pr = await o.prHost.prStatus(run.repoPath, run.integrationBranch);
  } catch (error) {
    throw new RpcError('failed_precondition', `could not read the pull request: ${(error as Error).message}`);
  }
  o.assertOpen();
  if (!pr) return o.store.requireRun(runId);
  const current = o.store.requireRun(runId);
  const changed = JSON.stringify(current.pr ?? null) !== JSON.stringify(pr) || current.prUrl !== pr.url;
  let next = changed ? o.store.updateRun(runId, { pr, prUrl: pr.url }) : current;
  if (pr.state !== 'open') {
    if (next.status === 'pr_ready') next = o.store.transitionRun(runId, 'pr_ready', 'done');
    if (!next.archived) {
      o.notify(`Pull request ${pr.state}`, `${next.title}: #${pr.number}; cleaning up the run`, runId);
      next = await archiveRun(o, runId);
    }
  }
  return next;
}

/** `runs.archive`: idempotent; concurrent calls for one run share the work. */
export function archiveRun(o: Orchestrator, runId: string): Promise<Run> {
  const inFlight = archiving.get(runId);
  if (inFlight) return inFlight;
  const job = doArchive(o, runId).finally(() => archiving.delete(runId));
  archiving.set(runId, job);
  return job;
}

async function doArchive(o: Orchestrator, runId: string): Promise<Run> {
  let run = o.store.requireRun(runId);
  if (prInFlight.has(runId)) throw new RpcError('conflict', 'a pull request is being created for this run');
  if (!isTerminal(RUN_TRANSITIONS, run.status)) run = await cancelRun(o, runId);

  // Anything still attached to the run: sessions (a terminal run should have none) and takeover terminals.
  const live = [...o.live.values()].filter((session) => session.attempt.runId === runId);
  await Promise.allSettled(
    live.map(async (session) => {
      await session.session.interrupt().catch(() => undefined);
      await session.close();
    }),
  );
  for (const [attemptId, terminalId] of [...o.takeovers]) {
    if (o.store.getAttempt(attemptId)?.runId !== runId) continue;
    o.terminals?.manager.close(terminalId);
    o.takeovers.delete(attemptId);
  }

  o.dismissOpen(runId, () => true, 'run archived');

  const problems: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${(error as Error).message}`);
    }
  };
  for (const task of o.store.listTasks(runId)) {
    await attempt(`task ${task.nodeId}`, () =>
      removeWorktree({ repo: run.repoPath, path: task.worktreePath ?? o.taskPath(run, task.id), branch: task.branch }),
    );
  }
  // The integration branch exists from planning on (the planner works in its worktree).
  const keepIntegrationBranch = run.pr ? run.pr.state === 'open' : run.prUrl !== null;
  await attempt('integration worktree', () =>
    removeWorktree({
      repo: run.repoPath,
      path: o.integrationPath(run),
      branch: keepIntegrationBranch ? null : (run.integrationBranch ?? integrationBranchName(run.id)),
    }),
  );
  await attempt('run directory', () =>
    rm(runDir(o.ctx.dataDir, repoHash(run.repoPath), run.id), { recursive: true, force: true }),
  );
  await releaseRepo(o, run);
  if (problems.length > 0) o.log.warn(`archive ${runId}: ${problems.join('; ')}`);
  o.assertOpen();
  const current = o.store.requireRun(runId);
  return current.archived ? current : o.store.updateRun(runId, { archived: true });
}

/** Refresh every open PR now and then (errors are logged; `gh` may be offline). */
export function startPrPolling(o: Orchestrator, intervalMs = PR_POLL_MS): () => void {
  let running = false;
  const poll = async () => {
    if (running || o.closed) return;
    running = true;
    try {
      for (const run of o.store.listRuns().filter(isOpenPr)) {
        if (o.closed) return;
        await refreshPr(o, run.id).catch((error: unknown) => {
          if (!o.closed) o.log.warn(`PR refresh of run ${run.id} failed: ${(error as Error).message}`);
        });
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
