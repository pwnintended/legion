/**
 * Human actions behind the RPC procedures: run controls (pause/resume/cancel), task controls
 * (retry/skip/setEngine/approveMerge/requestChanges) and `inbox.resolve` (the effect of every kind).
 */
import {
  type Effort,
  type EngineKind,
  type InboxItem,
  type InboxItemOf,
  type InboxResolution,
  isTerminal,
  RUN_TRANSITIONS,
  type Run,
  TASK_TRANSITIONS,
  type Task,
} from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { decideEscalation, decideHumanGate, SLOT_STATUSES, taskStatusPath } from './core';
import { createPr, enterPrReady } from './finalize';
import { patchRunMeta, patchTaskMeta, taskMeta } from './meta';
import { dismissal, type Orchestrator } from './orchestrator';
import { answerClarify, approvePlan, requestPlanRevision } from './planner';
import { releaseRepo } from './repo-gc';

// -- runs ------------------------------------------------------------------------------------------

function activeRun(o: Orchestrator, runId: string): Run {
  const run = o.store.requireRun(runId);
  if (isTerminal(RUN_TRANSITIONS, run.status)) throw new RpcError('conflict', `run ${runId} is ${run.status}`);
  return run;
}

export function pauseRun(o: Orchestrator, runId: string): Run {
  const run = activeRun(o, runId);
  return run.paused ? run : o.store.updateRun(runId, { paused: true });
}

export function resumeRun(o: Orchestrator, runId: string): Run {
  const run = activeRun(o, runId);
  const next = run.paused ? o.store.updateRun(runId, { paused: false }) : run;
  const runEscalation = o.store
    .listInbox({ runId, includeResolved: false })
    .some((i) => i.taskId === null && (i.kind === 'escalation' || i.kind === 'budget'));
  if ((next.status === 'integrating' || next.status === 'finalizing') && !runEscalation) o.startFinalize(runId);
  o.scheduleTick();
  return next;
}

/** Cancel: every open task/attempt/inbox item ends, live sessions are interrupted and closed. */
export async function cancelRun(o: Orchestrator, runId: string): Promise<Run> {
  const run = o.store.requireRun(runId);
  if (run.status === 'cancelled') return run;
  if (isTerminal(RUN_TRANSITIONS, run.status)) throw new RpcError('conflict', `run ${runId} is ${run.status}`);
  const next = o.store.transaction(() => {
    for (const task of o.store.listTasks(runId)) {
      if (!isTerminal(TASK_TRANSITIONS, task.status)) o.store.transitionTask(task.id, task.status, 'cancelled');
    }
    for (const attempt of o.store.listAttempts(runId)) {
      if (attempt.status === 'running' || attempt.status === 'interrupted' || attempt.status === 'pending') {
        o.store.transitionAttempt(attempt.id, attempt.status, 'cancelled', { error: 'run cancelled' });
      }
    }
    o.dismissOpen(runId, () => true, 'run cancelled');
    return o.store.transitionRun(runId, run.status, 'cancelled');
  });
  const live = [...o.live.values()].filter((session) => session.attempt.runId === runId);
  await Promise.allSettled(
    live.map(async (session) => {
      await session.session.interrupt().catch(() => undefined);
      await session.close();
    }),
  );
  for (const [attemptId, terminalId] of o.takeovers) {
    if (o.store.getAttempt(attemptId)?.runId === runId) o.terminals?.manager.close(terminalId);
  }
  await releaseRepo(o, next);
  return next;
}

// -- tasks -----------------------------------------------------------------------------------------

/** Close the task's live sessions (the human decided; the driver then sees the run/task moved on). */
async function stopTaskSessions(o: Orchestrator, taskId: string): Promise<void> {
  const live = [...o.live.values()].filter((s) => s.attempt.taskId === taskId);
  await Promise.allSettled(live.map((s) => o.finishAttempt(s, 'cancelled', 'stopped by a human')));
}

function resolveTaskItems(o: Orchestrator, task: Task, resolution: (item: InboxItem) => InboxResolution | null): void {
  for (const item of o.store.listInbox({ runId: task.runId, includeResolved: false })) {
    if (item.taskId !== task.id) continue;
    const res = resolution(item);
    if (res) o.store.resolveInboxItem(item.id, res);
  }
}

export function retryTask(o: Orchestrator, taskId: string, note: string | null): Task {
  const task = o.store.requireTask(taskId);
  if (task.status !== 'failed' && task.status !== 'awaiting_human') {
    throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}; only failed or awaiting_human tasks retry`);
  }
  activeRun(o, task.runId);
  const summary = [task.error, note?.trim() ? `Note from the human: ${note.trim()}` : null]
    .filter(Boolean)
    .join('\n\n');
  const next = o.store.transaction(() => {
    resolveTaskItems(o, task, (item) =>
      item.kind === 'escalation'
        ? { kind: 'escalation', action: 'retry', note }
        : item.kind === 'conflict'
          ? { kind: 'conflict', action: 'retry', note }
          : null,
    );
    return o.applyDecision(taskId, decideEscalation(task, 'retry'), { summary: summary || 'retried by a human' });
  });
  return next;
}

export async function skipTask(o: Orchestrator, taskId: string): Promise<Task> {
  const task = o.store.requireTask(taskId);
  activeRun(o, task.runId);
  if (isTerminal(TASK_TRANSITIONS, task.status))
    throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}`);
  if (task.status === 'merging') throw new RpcError('conflict', `task ${task.nodeId} is being merged`);
  await stopTaskSessions(o, taskId);
  return o.store.transaction(() => {
    const current = o.store.requireTask(taskId);
    const path = taskStatusPath(current.status, 'skipped', ['awaiting_human']);
    if (!path) throw new RpcError('conflict', `task ${current.nodeId} cannot be skipped from ${current.status}`);
    resolveTaskItems(o, current, (item) =>
      item.kind === 'escalation'
        ? { kind: 'escalation', action: 'skip', note: null }
        : item.kind === 'conflict'
          ? { kind: 'conflict', action: 'skip', note: null }
          : dismissal(item.kind, 'task skipped'),
    );
    const next = o.moveTask(taskId, path, { error: null });
    o.scheduleTick();
    return next;
  });
}

export function setTaskEngine(
  o: Orchestrator,
  taskId: string,
  engine: EngineKind,
  model: string | null,
  effort: Effort | null,
): Task {
  const task = o.store.requireTask(taskId);
  if (isTerminal(TASK_TRANSITIONS, task.status))
    throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}`);
  const usable = o.registry.usable(engine);
  if (!usable.ok) throw new RpcError('failed_precondition', usable.reason);
  const next = o.store.updateTask(taskId, { engineOverride: engine, modelOverride: model, effortOverride: effort });
  // A new engine cannot resume the old engine's coder session.
  if (o.nodeOf(task).agent.engine !== engine || task.engineOverride !== engine) {
    if (!SLOT_STATUSES.has(task.status)) patchTaskMeta(o.store, taskId, { coderSessionId: null });
  }
  o.scheduleTick();
  return next;
}

export function approveMerge(o: Orchestrator, taskId: string): Task {
  const task = o.store.requireTask(taskId);
  if (task.status !== 'awaiting_human') {
    throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}, not awaiting_human`);
  }
  activeRun(o, task.runId);
  return o.store.transaction(() => {
    resolveTaskItems(o, task, (item) =>
      item.kind === 'escalation'
        ? { kind: 'escalation', action: 'retry', note: 'approved for merge' }
        : item.kind === 'conflict'
          ? { kind: 'conflict', action: 'retry', note: 'approved for merge' }
          : null,
    );
    patchTaskMeta(o.store, taskId, { resolverAttempts: 0, resolverFailure: null });
    const next = o.moveTask(taskId, ['approved'], { error: null });
    o.scheduleTick();
    return next;
  });
}

export function requestChanges(o: Orchestrator, taskId: string, feedback: string): Task {
  const task = o.store.requireTask(taskId);
  if (task.status !== 'awaiting_human' && task.status !== 'approved') {
    throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}; changes can be requested before merging`);
  }
  activeRun(o, task.runId);
  if (!task.worktreePath) throw new RpcError('failed_precondition', `task ${task.nodeId} has no worktree`);
  return o.store.transaction(() => {
    resolveTaskItems(o, task, (item) =>
      item.kind === 'escalation' ? { kind: 'escalation', action: 'edit', note: feedback } : null,
    );
    const meta = taskMeta(o.store, taskId);
    patchTaskMeta(o.store, taskId, {
      fix: {
        findings: meta.fix?.findings ?? [],
        unmetCriteria: meta.fix?.unmetCriteria ?? [],
        failedVerify: [],
        humanNote: feedback,
        mergedIntegrationRef: null,
      },
    });
    return o.applyDecision(taskId, decideHumanGate(task, false));
  });
}

// -- inbox -----------------------------------------------------------------------------------------

function resolveIfOpen(o: Orchestrator, itemId: string, resolution: InboxResolution): void {
  const item = o.store.getInboxItem(itemId);
  if (item && item.resolvedAt === null) o.store.resolveInboxItem(itemId, resolution);
}

async function applyRunEscalation(
  o: Orchestrator,
  item: InboxItemOf<'escalation'>,
  resolution: Extract<InboxResolution, { kind: 'escalation' }>,
): Promise<void> {
  const run = o.store.requireRun(item.runId);
  resolveIfOpen(o, item.id, resolution);
  if (resolution.action === 'abort') {
    await cancelRun(o, run.id);
    return;
  }
  if (resolution.action === 'skip') {
    if (run.status === 'integrating') o.store.transitionRun(run.id, 'integrating', 'finalizing');
    else if (run.status === 'finalizing') {
      enterPrReady(o, run.id);
      return;
    }
  }
  o.startFinalize(run.id);
}

async function applyTaskEscalation(
  o: Orchestrator,
  item: InboxItemOf<'escalation'>,
  resolution: Extract<InboxResolution, { kind: 'escalation' }>,
): Promise<void> {
  const taskId = item.taskId as string;
  switch (resolution.action) {
    case 'retry':
    case 'edit':
      o.store.transaction(() => {
        resolveIfOpen(o, item.id, resolution);
        retryTask(o, taskId, resolution.note);
      });
      return;
    case 'skip': {
      const task = o.store.requireTask(taskId);
      if (isTerminal(TASK_TRANSITIONS, task.status) || task.status === 'merging') {
        throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}`);
      }
      resolveIfOpen(o, item.id, resolution);
      await skipTask(o, taskId);
      return;
    }
    case 'abort':
      resolveIfOpen(o, item.id, resolution);
      await cancelRun(o, item.runId);
      return;
  }
}

/** `inbox.resolve`: validate, apply the effect of the answer, record the resolution. */
export async function resolveInbox(o: Orchestrator, itemId: string, resolution: InboxResolution): Promise<InboxItem> {
  const item = o.store.getInboxItem(itemId);
  if (!item) throw new RpcError('not_found', `inbox item ${itemId} not found`);
  if (item.resolvedAt !== null) throw new RpcError('conflict', `inbox item ${itemId} is already resolved`);
  if (item.kind !== resolution.kind) {
    throw new RpcError('bad_request', `inbox item ${itemId} is a ${item.kind}, got a ${resolution.kind} resolution`);
  }

  switch (resolution.kind) {
    case 'plan_signoff': {
      const payload = (item as InboxItemOf<'plan_signoff'>).payload;
      if (resolution.approved) await approvePlan(o, item.runId, payload.planId);
      else {
        if (!resolution.feedback?.trim()) throw new RpcError('bad_request', 'rejecting a plan needs feedback');
        requestPlanRevision(o, item.runId, payload.planId, resolution.feedback);
      }
      resolveIfOpen(o, itemId, resolution);
      break;
    }
    case 'pr_ready':
      if (resolution.approved) await createPr(o, item.runId, resolution.title, resolution.body);
      resolveIfOpen(o, itemId, resolution);
      break;
    case 'question': {
      const question = item as InboxItemOf<'question'>;
      if (question.payload.source === 'clarify') {
        const resolved = o.store.resolveInboxItem(itemId, resolution);
        answerClarify(o, item.runId, resolution.answers, resolved);
      } else {
        o.store.resolveInboxItem(itemId, resolution);
        o.deliverResolution(itemId, resolution);
      }
      break;
    }
    case 'approval': {
      const payload = (item as InboxItemOf<'approval'>).payload;
      o.store.resolveInboxItem(itemId, resolution);
      if (!o.deliverResolution(itemId, resolution) && item.attemptId) {
        const live = o.live.get(item.attemptId);
        if (live) {
          await live.session.respond(payload.requestId, resolution.decision).catch((error: unknown) => {
            o.log.warn(`approval ${payload.requestId} could not be delivered: ${(error as Error).message}`);
          });
        }
      }
      break;
    }
    case 'escalation': {
      const escalation = item as InboxItemOf<'escalation'>;
      if (!escalation.payload.actions.includes(resolution.action)) {
        throw new RpcError('bad_request', `action ${resolution.action} is not offered for this escalation`);
      }
      if (item.taskId === null) await applyRunEscalation(o, escalation, resolution);
      else await applyTaskEscalation(o, escalation, resolution);
      break;
    }
    case 'conflict': {
      const taskId = item.taskId;
      if (resolution.action === 'abort') {
        resolveIfOpen(o, itemId, resolution);
        await cancelRun(o, item.runId);
      } else if (resolution.action === 'skip' && taskId) {
        await skipTask(o, taskId);
      } else if (taskId) {
        // Retry: back into the merge queue with a fresh resolver budget.
        approveMerge(o, taskId);
      }
      resolveIfOpen(o, itemId, resolution);
      break;
    }
    case 'budget': {
      if (resolution.action === 'stop') {
        resolveIfOpen(o, itemId, resolution);
        await cancelRun(o, item.runId);
        break;
      }
      const spent = o.runCost(item.runId);
      const limit = resolution.newLimitUsd ?? Math.ceil(Math.max(spent, 1) * 1.5);
      if (limit <= spent) throw new RpcError('bad_request', `the new limit must exceed the $${spent.toFixed(2)} spent`);
      resolveIfOpen(o, itemId, resolution);
      patchRunMeta(o.store, item.runId, { budgetLimitUsd: limit, budgetWarned: false });
      resumeRun(o, item.runId);
      break;
    }
  }
  return o.store.getInboxItem(itemId) as InboxItem;
}
