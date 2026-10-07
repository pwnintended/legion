/**
 * The implementation lead (architecture §8.4): one coordinating session per executing run, in `coordinate`
 * mode, that holds the approved plan as its ledger. The loop below opens it after plan approval, keeps its
 * process alive and idle between turns, and wakes it with one message per batch of news (coder questions,
 * board changes, amendment answers). It never injects into a running turn: a wake is sent only after the
 * previous turn ended. The lead's tools (`plan_status`, `add_task`, `amend_task`, `cancel_task`) are the
 * host functions at the bottom.
 */
import type { Plan, Run, Task, TaskNode } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import type { AmendmentResult, McpBinding, PlanStatus, TaskNodePatch } from '../mcp';
import type { deferred } from '../util/async-queue';
import { skipTask } from './actions';
import {
  AMENDABLE_STATUSES,
  amendmentNeedsSignoff,
  type BoardRow,
  type BoardSnapshot,
  boardChanges,
  boardSnapshot,
  buildLeadPrompt,
  buildLeadWakePrompt,
  messageLine,
  renderMessages,
  validatePlan,
} from './core';
import type { AgentRun } from './live-session';
import { patchRunMeta, runMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator, sleep } from './orchestrator';
import { acceptedOverlaps, validateOptions } from './planner';
import { ensureIntegrationWorktree } from './worktrees';

/** Consecutive failures to open or keep the lead session before the run continues without one. */
export const MAX_LEAD_FAILURES = 3;

export interface LeadLoop {
  /** Something happened: look at the board and the mailbox after the current turn. */
  wake(): void;
  stop(): void;
}

/** Whether runs get a lead at all (settings) and this run still can (not given up). */
export function leadEnabled(o: Orchestrator, runId: string): boolean {
  return o.settings().lead.enabled && !runMeta(o.store, runId).leadDisabled;
}

export function board(o: Orchestrator, runId: string): BoardRow[] {
  const nodes = new Map(o.approvedNodes(runId).map((n) => [n.id, n]));
  return o.store.listTasks(runId).map((task) => {
    const node = nodes.get(task.nodeId);
    return {
      nodeId: task.nodeId,
      title: node?.title ?? task.nodeId,
      status: task.status,
      dependsOn: node?.dependsOn ?? [],
      progress: task.progress,
      error: task.error,
      summary: task.report?.summary ?? null,
    };
  });
}

/** The lead loop of one run; returns when the run leaves `executing` or the lead is given up. */
export async function runLead(
  o: Orchestrator,
  runId: string,
  loop: { wake: ReturnType<typeof deferred<void>> },
): Promise<void> {
  let session: AgentRun | null = null;
  let snapshot: BoardSnapshot = boardSnapshot(board(o, runId));
  let seenAmendment: string | null = runMeta(o.store, runId).amendment?.status ?? null;
  const tools = o.toolNames(o.store.requireRun(runId).plannerEngine);
  try {
    for (;;) {
      o.assertOpen();
      // Captured before looking at the state: a wake that lands while we look still ends the wait below.
      const pending = loop.wake.promise;
      const run = o.store.requireRun(runId);
      if (run.status !== 'executing' || !leadEnabled(o, runId)) break;
      const meta = runMeta(o.store, runId);
      const current = board(o, runId);
      const changes = boardChanges(snapshot, current);
      const amendment = meta.amendment;
      if (amendment && amendment.status !== 'pending' && amendment.status !== seenAmendment) {
        changes.push(
          amendment.status === 'approved'
            ? `plan v${amendment.version} approved by the human: its tasks are on the board`
            : `plan v${amendment.version} rejected by the human: ${amendment.feedback ?? '(no feedback)'}`,
        );
      }
      const queued = session ? o.store.queuedMessagesFor(session.attempt.id) : [];

      if (!session) {
        if (run.paused) {
          await pending;
          continue;
        }
        session = await openLead(o, run, meta.leadSessionId, current, changes, tools);
        if (!session) break;
      } else if (queued.length > 0 || changes.length > 0) {
        if (run.paused && queued.length === 0) {
          await pending;
          continue;
        }
        o.store.markDelivered(queued.map((m) => m.id));
        const messages = renderMessages(queued.map((m) => messageLine(m, o.agentName(m.fromAttemptId))));
        const prompt = buildLeadWakePrompt({
          messages,
          changes,
          board: current,
          tools,
          parent: o.assistantAttemptId(runId) !== null,
        });
        try {
          await session.session.send(prompt.prompt, 'next');
        } catch (error) {
          o.log.warn(`run ${runId}: could not wake the lead: ${(error as Error).message}`);
          await o.finishAttempt(session, 'failed', (error as Error).message);
          session = null;
          continue;
        }
      } else {
        await pending;
        continue;
      }
      snapshot = boardSnapshot(current);
      seenAmendment = amendment?.status ?? null;

      let turn = await session.nextTurn();
      o.assertOpen();
      if (turn.kind === 'turn' && turn.isError) {
        // The exit (if any) follows the failed turn on the event stream: give it a moment to arrive.
        await sleep(50);
        if (session.ended) turn = await session.nextTurn();
      }
      if (turn.kind === 'exited') {
        const message = turn.error?.message ?? 'the lead process exited';
        await o.finishAttempt(session, 'failed', message);
        session = null;
        if (!(await noteLeadFailure(o, runId, message))) break;
      } else if (!turn.isError && runMeta(o.store, runId).leadFailures > 0) {
        // A completed turn: earlier failures no longer count towards giving the lead up.
        patchRunMeta(o.store, runId, { leadFailures: 0 });
      }
    }
  } catch (error) {
    if (o.closed || error instanceof Closed) return;
    o.log.error(`run ${runId}: lead loop failed`, error);
  } finally {
    if (session) await o.finishAttempt(session, 'succeeded').catch(() => undefined);
  }
}

async function openLead(
  o: Orchestrator,
  run: Run,
  resumeSessionId: string | null,
  current: BoardRow[],
  changes: string[],
  tools: ReturnType<Orchestrator['toolNames']>,
): Promise<AgentRun | null> {
  const engine = run.plannerEngine;
  const plan = o.approvedPlan(run.id);
  if (!plan) return null;
  await o.waitForEngine(engine);
  const cwd = await ensureIntegrationWorktree(o, run);
  const parentAttemptId = o.assistantAttemptId(run.id);
  const parent = parentAttemptId !== null;
  const prompt = resumeSessionId
    ? buildLeadWakePrompt({
        messages: null,
        changes: ['Legion resumed your session.', ...changes],
        board: current,
        tools,
        parent,
      })
    : buildLeadPrompt({ issue: o.issue(run), planMarkdown: plan.markdown, nodes: plan.dag.nodes, tools, parent });
  try {
    const session = await o.openSession({
      run,
      taskId: null,
      role: 'lead',
      engine,
      model: o.modelFor('lead', engine),
      effort: o.settings().roles.lead.effort,
      prompt,
      outputSchema: null,
      cwd,
      resumeSessionId,
      parentAttemptId,
      attachments: resumeSessionId ? null : o.runAttachments(run),
    });
    const previous = runMeta(o.store, run.id).leadAttemptId;
    if (previous && previous !== session.attempt.id) o.store.reparentAttempts(previous, session.attempt.id);
    patchRunMeta(o.store, run.id, {
      leadAttemptId: session.attempt.id,
      leadSessionId: session.sessionId || resumeSessionId,
    });
    o.scheduleTick();
    return session;
  } catch (error) {
    if (o.closed || error instanceof Closed) throw error;
    const failure = error instanceof AgentFailure ? error.failure : null;
    if (failure?.kind === 'rate_limited') {
      if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
      return openLead(o, run, resumeSessionId, current, changes, tools);
    }
    const message = failure?.message ?? (error as Error).message;
    if (resumeSessionId) patchRunMeta(o.store, run.id, { leadSessionId: null });
    return (await noteLeadFailure(o, run.id, message)) ? openLead(o, run, null, current, changes, tools) : null;
  }
}

/** Count a failure; false when the lead is given up for this run (dispatch then proceeds without it). */
async function noteLeadFailure(o: Orchestrator, runId: string, message: string): Promise<boolean> {
  const failures = runMeta(o.store, runId).leadFailures + 1;
  o.log.warn(`run ${runId}: lead failed (${failures}/${MAX_LEAD_FAILURES}): ${message}`);
  if (failures >= MAX_LEAD_FAILURES) {
    patchRunMeta(o.store, runId, { leadFailures: failures, leadDisabled: true });
    o.scheduleTick();
    return false;
  }
  patchRunMeta(o.store, runId, { leadFailures: failures });
  await sleep(o.leadBackoffMs);
  return true;
}

// -- lead tools (McpHost) --------------------------------------------------------------------------

function leadRun(o: Orchestrator, binding: McpBinding): Run {
  const run = o.store.requireRun(binding.runId);
  if (run.status !== 'executing') throw new Error(`the run is ${run.status}; the plan can only change while executing`);
  return run;
}

export function planStatus(o: Orchestrator, binding: McpBinding): PlanStatus {
  const run = o.store.requireRun(binding.runId);
  const meta = runMeta(o.store, run.id);
  const attempts = o.store.listAttempts(run.id);
  const tasks = board(o, run.id).map((row) => {
    const task = o.store.listTasks(run.id).find((t) => t.nodeId === row.nodeId) as Task;
    const coder = attempts
      .filter((a) => a.taskId === task.id && (a.role === 'coder' || a.role === 'resolver') && a.status === 'running')
      .at(-1);
    return { ...row, dependsOn: [...row.dependsOn], coderAttemptId: coder?.id ?? null };
  });
  const pending = meta.amendment?.status === 'pending' ? meta.amendment : null;
  return {
    runStatus: run.status,
    paused: run.paused,
    tasks,
    pendingAmendment: pending ? { version: pending.version, reason: pending.reason } : null,
  };
}

/** Validate `nodes` as the plan's next version and apply it, or park it for the human. */
async function amend(
  o: Orchestrator,
  run: Run,
  nodes: readonly TaskNode[],
  changed: TaskNode,
  description: string,
): Promise<AmendmentResult> {
  const approved = o.approvedPlan(run.id);
  if (!approved) throw new Error('the run has no approved plan');
  const meta = runMeta(o.store, run.id);
  if (meta.amendment?.status === 'pending') {
    throw new Error(`plan v${meta.amendment.version} is still waiting for the human; wait for that answer first`);
  }
  const options = await validateOptions(o, run);
  const annotations = approved.dag.annotations;
  const result = validatePlan({ nodes, annotations }, { ...options, acceptedOverlaps: acceptedOverlaps(annotations) });
  if (!result.ok) throw new Error(`the amended plan is invalid: ${result.errors.map((e) => e.message).join(' ')}`);
  const reason = amendmentNeedsSignoff(approved.dag.nodes, changed);
  const plan = o.store.transaction(() =>
    o.store.insertPlan({
      runId: run.id,
      markdown: `${approved.markdown.trimEnd()}\n\n## Amendment v${approved.version + 1} (by the lead)\n\n${description}\n`,
      dag: result.dag,
      source: 'agent',
      feedback: description,
    }),
  );
  if (reason === null) {
    applyAmendment(o, run.id, plan);
    return { outcome: 'applied', planVersion: plan.version, reason: null };
  }
  o.store.transaction(() => {
    patchRunMeta(o.store, run.id, {
      amendment: { planId: plan.id, version: plan.version, reason, status: 'pending', feedback: null },
    });
    o.store.insertInboxItem({
      runId: run.id,
      taskId: null,
      attemptId: meta.leadAttemptId,
      kind: 'plan_signoff',
      payload: { planId: plan.id, version: plan.version },
    });
  });
  return { outcome: 'pending', planVersion: plan.version, reason };
}

/** Make `plan` the approved version: tasks for its new nodes, the old sign-off resolved, dispatch. */
export function applyAmendment(o: Orchestrator, runId: string, plan: Plan): Plan {
  const approved = o.store.transaction(() => {
    const approved = o.store.approvePlan(plan.id);
    const existing = new Set(o.store.listTasks(runId).map((t) => t.nodeId));
    for (const node of approved.dag.nodes) {
      if (!existing.has(node.id)) o.store.insertTask({ runId, nodeId: node.id, status: 'blocked' });
    }
    const meta = runMeta(o.store, runId);
    if (meta.amendment?.planId === plan.id) {
      patchRunMeta(o.store, runId, { amendment: { ...meta.amendment, status: 'approved' } });
    }
    for (const item of o.store.listInbox({ runId, includeResolved: false })) {
      if (item.kind === 'plan_signoff' && item.payload.planId === plan.id) {
        o.store.resolveInboxItem(item.id, { kind: 'plan_signoff', approved: true, feedback: null });
      }
    }
    return approved;
  });
  o.scheduleTick();
  o.wakeLead(runId);
  return approved;
}

/** The human rejected a pending amendment: record the feedback for the lead's next wake. */
export function rejectAmendment(o: Orchestrator, runId: string, plan: Plan, feedback: string): void {
  o.store.transaction(() => {
    const meta = runMeta(o.store, runId);
    if (meta.amendment?.planId === plan.id) {
      patchRunMeta(o.store, runId, { amendment: { ...meta.amendment, status: 'rejected', feedback } });
    }
    for (const item of o.store.listInbox({ runId, includeResolved: false })) {
      if (item.kind === 'plan_signoff' && item.payload.planId === plan.id) {
        o.store.resolveInboxItem(item.id, { kind: 'plan_signoff', approved: false, feedback });
      }
    }
  });
  o.wakeLead(runId);
}

export async function addTask(o: Orchestrator, binding: McpBinding, node: TaskNode): Promise<AmendmentResult> {
  const run = leadRun(o, binding);
  const nodes = o.approvedNodes(run.id);
  if (nodes.some((n) => n.id === node.id)) throw new Error(`${node.id} exists already; use amend_task or a new id`);
  return amend(o, run, [...nodes, node], node, `Added ${node.id}: ${node.title}.`);
}

export async function amendTask(
  o: Orchestrator,
  binding: McpBinding,
  nodeId: string,
  patch: TaskNodePatch,
): Promise<AmendmentResult> {
  const run = leadRun(o, binding);
  const nodes = o.approvedNodes(run.id);
  const current = nodes.find((n) => n.id === nodeId);
  if (!current) throw new Error(`unknown task ${nodeId}`);
  const task = o.store.listTasks(run.id).find((t) => t.nodeId === nodeId);
  if (task && !AMENDABLE_STATUSES.has(task.status)) {
    throw new Error(
      `${nodeId} is ${task.status}: only blocked or queued tasks can be amended; message its coder instead`,
    );
  }
  const changed: TaskNode = { ...current, ...patch, id: current.id };
  const next = nodes.map((n) => (n.id === nodeId ? changed : n));
  return amend(o, run, next, changed, `Amended ${nodeId}: ${Object.keys(patch).join(', ')}.`);
}

export async function cancelTask(
  o: Orchestrator,
  binding: McpBinding,
  nodeId: string,
  reason: string,
): Promise<AmendmentResult> {
  const run = leadRun(o, binding);
  const task = o.store.listTasks(run.id).find((t) => t.nodeId === nodeId);
  if (!task) throw new Error(`unknown task ${nodeId}`);
  if (!AMENDABLE_STATUSES.has(task.status)) {
    throw new Error(`${nodeId} is ${task.status}: only blocked or queued tasks can be cancelled`);
  }
  try {
    await skipTask(o, task.id);
  } catch (error) {
    throw new Error(error instanceof RpcError ? error.message : String(error));
  }
  o.store.updateTask(task.id, { error: `cancelled by the lead: ${reason}` });
  const version = o.approvedPlan(run.id)?.version ?? 0;
  return { outcome: 'applied', planVersion: version, reason: null };
}
