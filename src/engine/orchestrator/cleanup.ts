/**
 * After the PR (§8 step 9): PR status refresh (`runs.refreshPr` + polling of open PRs) and cleanup
 * (`runs.archive`, also run when the PR is merged): worktrees and local branches go unless they hold work that
 * exists nowhere else, `gc.auto` is restored, the run is hidden from `runs.list`.
 */
import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { isTerminal, type PullRequest, RUN_TRANSITIONS, type Run } from '@shared/domain';
import type { ArchiveReport } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import {
  branchExists,
  forecastMerge,
  git,
  gitText,
  integrationBranchName,
  isAncestor,
  listWorktrees,
  removeWorktree,
  repoHash,
  runDir,
  uncommittedPaths,
} from '../git';
import { cancelRun } from './actions';
import { prInFlight } from './finalize';
import { runMeta, taskMeta } from './meta';
import type { Orchestrator } from './orchestrator';
import { releaseRepo } from './repo-gc';
import { endSession } from './session-run';

/** How often open PRs are re-read from the host. */
export const PR_POLL_MS = 3 * 60 * 1000;

export type ArchivedRun = Run & { archiveReport: ArchiveReport };

const archiving = new Map<string, Promise<ArchivedRun>>();
const refreshing = new Map<string, Promise<Run>>();

const isOpenPr = (run: Run): boolean =>
  !run.archived && run.integrationBranch !== null && (run.pr ? run.pr.state === 'open' : run.prUrl !== null);

/**
 * Re-read the run's PR. A merged PR moves a still-open run to `done` and archives it; a closed (not merged)
 * one only finishes the run: its branches and worktrees stay (the PR may be reopened, the work is not in
 * the base). Concurrent calls for one run share the work.
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
  if (pr.state !== 'open' && next.status === 'pr_ready') next = o.store.transitionRun(runId, 'pr_ready', 'done');
  if (pr.state === 'merged' && !next.archived) {
    o.notify('Pull request merged', `${next.title}: #${pr.number}; cleaning up the run`, runId);
    next = await archiveRun(o, runId);
  } else if (pr.state === 'closed' && changed) {
    o.notify('Pull request closed', `${next.title}: #${pr.number}; the run's branches are kept`, runId);
  }
  return next;
}

/**
 * `runs.archive`: idempotent; concurrent calls for one run share the work. A run that is still active is
 * refused unless `force` (then it is cancelled first). `discard` (implies `force`) also removes what is kept
 * otherwise, the integration branch included; the remote is never touched.
 */
export function archiveRun(
  o: Orchestrator,
  runId: string,
  opts: { force?: boolean; discard?: boolean } = {},
): Promise<ArchivedRun> {
  const inFlight = archiving.get(runId);
  if (inFlight) return inFlight;
  const discard = opts.discard === true;
  const job = doArchive(o, runId, opts.force === true || discard, discard).finally(() => archiving.delete(runId));
  archiving.set(runId, job);
  return job;
}

/** True when `branch` holds commits or content found neither in `integration` nor in `base`. */
async function hasUniqueWork(repo: string, branch: string, integration: string | null, base: string | null) {
  const exclude = [integration, base].filter((r): r is string => r !== null);
  const count = await gitText(repo, ['rev-list', '--count', branch, '--not', ...exclude, '--']).catch(() => null);
  if (count === '0') return false;
  if (count === null || integration === null) return true;
  // Squash merges leave the task's commits unreachable from integration: compare content instead.
  const forecast = await forecastMerge(repo, integration, branch).catch(() => null);
  if (!forecast?.clean) return true;
  const tree = await gitText(repo, ['rev-parse', `${integration}^{tree}`]).catch(() => null);
  return forecast.tree !== tree;
}

/** The branch's tip is contained in its upstream (as last fetched or pushed). */
async function fullyPushed(repo: string, branch: string): Promise<boolean> {
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
    okExitCodes: [0, 128],
  });
  if (upstream.exitCode !== 0) return false;
  return isAncestor(repo, branch, upstream.stdout.trim());
}

async function isRegisteredWorktree(repo: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const target = await realpath(path).catch(() => path);
  for (const w of await listWorktrees(repo).catch(() => [])) {
    if ((await realpath(w.path).catch(() => w.path)) === target) return true;
  }
  return false;
}

async function doArchive(o: Orchestrator, runId: string, force: boolean, discard: boolean): Promise<ArchivedRun> {
  let run = o.store.requireRun(runId);
  if (prInFlight.has(runId)) throw new RpcError('conflict', 'a pull request is being created for this run');
  // A direct session has nothing unfinished to lose: archiving it ends it.
  if (run.status === 'session') run = await endSession(o, runId);
  if (!isTerminal(RUN_TRANSITIONS, run.status)) {
    if (!force) {
      throw new RpcError(
        'failed_precondition',
        `run ${runId} is ${run.status}; cancel it first, or archive with force: true to cancel and archive it`,
      );
    }
    run = await cancelRun(o, runId);
  }

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

  const report: ArchiveReport = { kept: [], problems: [] };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      report.problems.push(`${what}: ${(error as Error).message}`);
    }
  };
  const repo = run.repoPath;
  const integrationRef = run.integrationBranch ?? integrationBranchName(run.id);
  const integration = (await branchExists(repo, integrationRef).catch(() => false)) ? integrationRef : null;
  const base =
    runMeta(o.store, run.id).baseSha ?? (await gitText(repo, ['rev-parse', '--verify', run.baseRef]).catch(() => null));

  /** Remove a worktree unless it has uncommitted work (kept, unless forced); returns whether it is gone. */
  const dropWorktree = async (path: string, allowUntracked: readonly string[], branch: string | null) => {
    if (!force && (await isRegisteredWorktree(repo, path))) {
      const dirty = await uncommittedPaths(path, allowUntracked).catch(() => []);
      if (dirty.length > 0) {
        const shown = dirty.slice(0, 3).join(', ') + (dirty.length > 3 ? ', ...' : '');
        report.kept.push({ kind: 'worktree', name: path, reason: `uncommitted changes (${shown})` });
        if (branch) report.kept.push({ kind: 'branch', name: branch, reason: 'checked out in a kept worktree' });
        return false;
      }
    }
    await removeWorktree({ repo, path, branch });
    return true;
  };

  for (const task of o.store.listTasks(runId)) {
    const path = task.worktreePath ?? o.taskPath(run, task.id);
    let branch = task.branch && (await branchExists(repo, task.branch).catch(() => false)) ? task.branch : null;
    if (branch && !force && (await hasUniqueWork(repo, branch, integration, base))) {
      report.kept.push({
        kind: 'branch',
        name: branch,
        reason: 'has work that is in neither the integration branch nor the base',
      });
      branch = null;
    }
    await attempt(`task ${task.nodeId}`, async () => {
      await dropWorktree(path, taskMeta(o.store, task.id).provisioned, branch);
    });
  }

  // The integration branch exists from planning on (the planner works in its worktree). It goes only when
  // its work is safe elsewhere: the PR was merged, or it was closed and the branch is fully pushed, or it
  // was merged locally and the base branch still has it, or it has nothing beyond the base. `force` never
  // deletes it; `discard` always does (locally).
  let deleteIntegration = discard;
  if (integration && !discard) {
    const state = run.pr?.state ?? (run.prUrl ? 'open' : null);
    if (state === 'merged') deleteIntegration = true;
    else if (run.merged && (await isAncestor(repo, integration, `refs/heads/${run.merged.into}`).catch(() => false))) {
      deleteIntegration = true;
    } else if (state === 'closed' && (await fullyPushed(repo, integration))) deleteIntegration = true;
    else if (state === null && base && (await isAncestor(repo, integration, base).catch(() => false))) {
      deleteIntegration = true;
    }
    if (!deleteIntegration) {
      const reason =
        state === 'open'
          ? 'the pull request is open'
          : state === 'closed'
            ? 'the pull request was closed and the branch is not fully pushed'
            : run.merged
              ? `${run.merged.into} no longer has its work`
              : 'its work is not merged anywhere (no pull request)';
      report.kept.push({ kind: 'branch', name: integration, reason });
    }
  }
  await attempt('integration worktree', async () => {
    await dropWorktree(
      o.integrationPath(run),
      runMeta(o.store, run.id).integrationKeep,
      deleteIntegration ? integration : null,
    );
  });

  if (!report.kept.some((k) => k.kind === 'worktree')) {
    await attempt('run directory', () =>
      rm(runDir(o.ctx.dataDir, repoHash(repo), run.id), { recursive: true, force: true }),
    );
  }
  await releaseRepo(o, run);
  if (report.problems.length > 0) o.log.warn(`archive ${runId}: ${report.problems.join('; ')}`);
  if (report.kept.length > 0) {
    o.log.info(`archive ${runId} kept ${report.kept.map((k) => `${k.name} (${k.reason})`).join('; ')}`);
  }
  o.assertOpen();
  const current = o.store.requireRun(runId);
  const archived = current.archived ? current : o.store.updateRun(runId, { archived: true });
  return { ...archived, archiveReport: report };
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
