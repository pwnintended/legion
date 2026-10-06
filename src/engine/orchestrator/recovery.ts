/**
 * Crash recovery on engine start (architecture §9). Nothing survives a restart but the DB and the git
 * state, so:
 * - attempts still `running` → `interrupted` (coder ones are resumed by the task driver; others fail and
 *   their step simply runs again with a fresh session);
 * - approval / agent-question inbox items die with their sessions → dismissed;
 * - a `pending` merge was cut off mid-merge or mid-verify → integration reset to its pre-merge sha;
 * - worktrees are reconciled with the DB (restored from their branch, or the task is re-queued);
 * - planner / finalize jobs and task drivers are restarted.
 */
import { join } from 'node:path';
import {
  type InboxItemOf,
  isTerminal,
  RUN_TRANSITIONS,
  type Run,
  TASK_TRANSITIONS,
  type TaskStatus,
} from '@shared/domain';
import {
  abortMerge,
  branchExists,
  integrationBranchName,
  isMergeInProgress,
  reconcile,
  repoHash,
  resetIntegration,
} from '../git';
import { SLOT_STATUSES, taskStatusPath } from './core';
import { taskMeta } from './meta';
import type { Orchestrator } from './orchestrator';
import { type PlanRevision, startPlanner } from './planner';
import { ensureIntegrationWorktree, ensureWorktree, integrationKeep } from './worktrees';

const WORKTREE_STATUSES: ReadonlySet<TaskStatus> = new Set([...SLOT_STATUSES, 'approved', 'awaiting_human', 'merging']);

export async function recover(o: Orchestrator): Promise<void> {
  const store = o.store;
  store.transaction(() => {
    for (const attempt of store.listAttemptsByStatus('pending')) {
      store.transitionAttempt(attempt.id, 'pending', 'failed', { error: 'the engine stopped before it started' });
    }
    for (const attempt of store.listAttemptsByStatus('running')) {
      store.transitionAttempt(attempt.id, 'running', 'interrupted', {
        error: 'the engine stopped during this attempt',
      });
    }
    for (const attempt of store.listAttemptsByStatus('interrupted')) {
      const task = attempt.taskId ? store.getTask(attempt.taskId) : null;
      const resumable =
        attempt.role === 'coder' &&
        task !== null &&
        (task.status === 'running' || task.status === 'fixing') &&
        attempt.sessionId !== null &&
        taskMeta(store, task.id).coderSessionId === attempt.sessionId;
      if (!resumable) {
        store.transitionAttempt(attempt.id, 'interrupted', 'failed', { error: attempt.error ?? 'interrupted' });
      }
    }
    for (const item of store.listInbox({ runId: null, includeResolved: false })) {
      if (item.kind === 'approval' || (item.kind === 'question' && item.payload.source === 'agent')) {
        o.dismissOpen(item.runId, (i) => i.id === item.id, 'the agent session ended with an engine restart');
      }
    }
  });

  for (const run of store.listRuns()) {
    if (isTerminal(RUN_TRANSITIONS, run.status)) continue;
    try {
      await recoverRun(o, run);
    } catch (error) {
      o.log.error(`recovery of run ${run.id} failed`, error);
    }
  }
  o.scheduleTick();
}

async function recoverRun(o: Orchestrator, run: Run): Promise<void> {
  const open = o.store.listInbox({ runId: run.id, includeResolved: false });
  switch (run.status) {
    case 'clarifying':
      if (!open.some((i) => i.kind === 'question' && i.payload.source === 'clarify')) startPlanner(o, run.id);
      return;
    case 'planning': {
      // A revision in flight: the feedback is on the latest rejected sign-off.
      const rejected = o.store
        .listInbox({ runId: run.id, includeResolved: true })
        .filter((i): i is InboxItemOf<'plan_signoff'> => i.kind === 'plan_signoff' && i.resolution !== null)
        .at(-1);
      const latest = o.store.latestPlan(run.id);
      const resolution = rejected?.resolution as { approved: boolean; feedback: string | null } | null | undefined;
      const feedback = resolution && !resolution.approved ? resolution.feedback : null;
      const revision: PlanRevision | null = feedback && latest ? { feedback, previous: latest } : null;
      startPlanner(o, run.id, revision);
      return;
    }
    case 'executing':
      await recoverExecution(o, run);
      return;
    case 'integrating':
    case 'finalizing':
      await rollBackMerges(o, run);
      if (!open.some((i) => i.taskId === null && (i.kind === 'escalation' || i.kind === 'budget'))) {
        o.startFinalize(run.id);
      }
      return;
    default:
      return;
  }
}

/** Reset integration to the pre-merge sha of every merge that never finished. */
async function rollBackMerges(o: Orchestrator, run: Run): Promise<void> {
  const pending = o.store.listMerges(run.id).filter((m) => m.status === 'pending');
  if (pending.length === 0) return;
  const integration = await ensureIntegrationWorktree(o, run);
  for (const merge of pending.reverse()) {
    await resetIntegration(integration, merge.preSha, integrationKeep(o, run));
    o.store.finishMerge(merge.id, 'reverted', { error: 'the engine stopped during this merge; rolled back' });
  }
}

async function recoverExecution(o: Orchestrator, run: Run): Promise<void> {
  await rollBackMerges(o, run);
  const integration = await ensureIntegrationWorktree(o, run);
  const tasks = o.store.listTasks(run.id).filter((t) => t.worktreePath && WORKTREE_STATUSES.has(t.status));
  const state = await reconcile(
    run.repoPath,
    [
      { path: integration, branch: integrationBranchName(run.id) },
      ...tasks.map((t) => ({ path: t.worktreePath as string, branch: t.branch })),
    ],
    { managedRoot: join(o.ctx.dataDir, 'worktrees', repoHash(run.repoPath)) },
  );
  for (const orphan of state.orphaned) {
    o.log.warn(`run ${run.id}: worktree ${orphan.path} is not tracked by Legion (left alone)`);
  }
  const missing = new Set(state.missing.map((m) => m.path));
  for (const task of tasks) {
    const path = task.worktreePath as string;
    if (missing.has(path)) {
      if (task.branch && (await branchExists(run.repoPath, task.branch))) {
        await ensureWorktree(run.repoPath, path, task.branch, null);
      } else if (!isTerminal(TASK_TRANSITIONS, task.status)) {
        // Nothing left to resume from: start the task over without charging the lost attempt.
        const route = taskStatusPath(task.status, 'queued', ['failed']);
        if (route) o.moveTask(task.id, route, { attemptCount: Math.max(0, task.attemptCount - 1), error: null });
        continue;
      }
    }
    // A conflict resolution cut off mid-merge: start it again from a clean task branch.
    if (task.status === 'merging' && (await isMergeInProgress(path))) await abortMerge(path);
  }
}
