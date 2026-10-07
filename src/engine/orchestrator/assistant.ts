/**
 * The assistant (architecture §8.6): the human's conversation partner for a run, in `coordinate` mode. A run
 * starts as a conversation (`runs.chat`, status `chatting`); the assistant answers, spawns research, and turns
 * the request into work with `start_implementation`, after which it sits above the lead for the run's life.
 * Its process stays alive and idle between turns: the human talks to it with `sessions.send`, and the loop below
 * wakes it with news (messages from its agents, run status changes, things waiting for the human). A wake is
 * sent only after the previous turn ended.
 */
import { basename } from 'node:path';
import { type InboxItem, isTerminal, RUN_TRANSITIONS, type Run, type RunStatus } from '@shared/domain';
import type { RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import type { AssistantRunStatus, McpBinding, StartImplementationRequest } from '../mcp';
import { buildAssistantPrompt, buildAssistantWakePrompt, messageLine, renderMessages } from './core';
import { board } from './lead';
import type { AgentRun } from './live-session';
import { patchRunMeta, runMeta } from './meta';
import { AgentFailure, Closed, type LeadLoopHandle, type Orchestrator, sleep } from './orchestrator';
import { insertRun, startPlanner } from './planner';

/** Consecutive failures to open or keep the assistant session before the run continues without one. */
export const MAX_ASSISTANT_FAILURES = 3;

export function assistantEnabled(o: Orchestrator, runId: string): boolean {
  return o.settings().assistant.enabled && !runMeta(o.store, runId).assistantDisabled;
}

/** `runs.chat`: a run in `chatting` whose first message is the prompt; its assistant opens at once. */
export async function createChat(o: Orchestrator, input: RpcInput<'runs.chat'>): Promise<Run> {
  if (!o.settings().assistant.enabled)
    throw new RpcError('failed_precondition', 'the assistant is disabled in settings');
  const run = await insertRun(
    o,
    {
      repoPath: input.repoPath,
      baseRef: input.baseRef,
      title: null,
      issueText: input.prompt,
      issueUrl: null,
      plannerEngine: input.engine,
      plannerModel: input.model,
      attachmentIds: input.attachmentIds,
    },
    'chatting',
  );
  o.startAssistant(run.id);
  return run;
}

const HUMAN_ITEM_LINES: Partial<Record<InboxItem['kind'], (item: InboxItem) => string>> = {
  question: (item) =>
    item.kind === 'question' && item.payload.source === 'clarify'
      ? `the planner asks the human ${item.payload.questions.length} clarifying question(s) (inbox)`
      : 'an agent asks the human a question (inbox)',
  plan_signoff: (item) =>
    item.kind === 'plan_signoff' ? `plan v${item.payload.version} waits for the human's sign-off (inbox)` : '',
  escalation: (item) => (item.kind === 'escalation' ? `needs the human: ${item.payload.summary} (inbox)` : ''),
  pr_ready: () => 'the work is ready for a pull request; the human opens it from the inbox',
  conflict: () => 'a merge conflict waits for the human (inbox)',
  budget: () => 'the budget was reached; the human decides in the inbox',
};

const STATUS_LINE: Partial<Record<RunStatus, string>> = {
  clarifying: 'the planner is looking at the brief',
  planning: 'the planner is exploring the repository and drafting the plan',
  awaiting_approval: 'the plan is ready for the human to sign off',
  executing: 'the plan was approved; coders are working under the implementation lead',
  integrating: 'every task is merged; the integration branch is being verified',
  finalizing: 'final review',
  pr_ready: 'ready for a pull request',
  done: 'done',
  failed: 'the run failed',
  cancelled: 'the run was cancelled',
};

function conversationChanges(previous: RunStatus, run: Run, newItems: readonly InboxItem[]): string[] {
  const lines: string[] = [];
  if (previous !== run.status) {
    const detail = STATUS_LINE[run.status];
    lines.push(
      `run status ${previous} → ${run.status}${detail ? `: ${detail}` : ''}${run.error ? ` (${run.error})` : ''}`,
    );
  }
  for (const item of newItems) {
    const line = HUMAN_ITEM_LINES[item.kind]?.(item);
    if (line) lines.push(line);
  }
  return lines;
}

/** The assistant loop of one run; returns when the run ends or the assistant is given up. */
export async function runAssistant(o: Orchestrator, runId: string, loop: LeadLoopHandle): Promise<void> {
  let session: AgentRun | null = null;
  let lastStatus = o.store.requireRun(runId).status;
  let seenItems = new Set(o.store.listInbox({ runId, includeResolved: false }).map((i) => i.id));
  const tools = o.toolNames(o.store.requireRun(runId).plannerEngine);
  try {
    for (;;) {
      o.assertOpen();
      const pending = loop.wake.promise;
      const run = o.store.requireRun(runId);
      if (isTerminal(RUN_TRANSITIONS, run.status) || !assistantEnabled(o, runId)) break;
      const meta = runMeta(o.store, runId);
      const open = o.store.listInbox({ runId, includeResolved: false });
      const changes = conversationChanges(
        lastStatus,
        run,
        open.filter((i) => !seenItems.has(i.id)),
      );
      const queued = session ? o.store.queuedMessagesFor(session.attempt.id) : [];

      if (!session) {
        session = await openAssistant(o, run, meta.assistantSessionId, changes, tools);
        if (!session) break;
      } else if (queued.length > 0 || changes.length > 0) {
        o.store.markDelivered(queued.map((m) => m.id));
        const messages = renderMessages(queued.map((m) => messageLine(m, o.agentName(m.fromAttemptId))));
        const prompt = buildAssistantWakePrompt({ messages, changes, tools }, basename(run.repoPath));
        try {
          await session.session.send(prompt.prompt, 'next');
        } catch (error) {
          o.log.warn(`run ${runId}: could not wake the assistant: ${(error as Error).message}`);
          await o.finishAttempt(session, 'failed', (error as Error).message);
          session = null;
          continue;
        }
      } else {
        await pending;
        continue;
      }
      lastStatus = run.status;
      seenItems = new Set(open.map((i) => i.id));

      let turn = await session.nextTurn();
      o.assertOpen();
      if (turn.kind === 'turn' && turn.isError) {
        await sleep(50);
        if (session.ended) turn = await session.nextTurn();
      }
      if (turn.kind === 'exited') {
        const message = turn.error?.message ?? 'the assistant process exited';
        await o.finishAttempt(session, 'failed', message);
        session = null;
        if (!(await noteAssistantFailure(o, runId, message))) break;
      } else if (!turn.isError && runMeta(o.store, runId).assistantFailures > 0) {
        patchRunMeta(o.store, runId, { assistantFailures: 0 });
      }
    }
  } catch (error) {
    if (o.closed || error instanceof Closed) return;
    o.log.error(`run ${runId}: assistant loop failed`, error);
  } finally {
    if (session) await o.finishAttempt(session, 'succeeded').catch(() => undefined);
  }
}

async function openAssistant(
  o: Orchestrator,
  run: Run,
  resumeSessionId: string | null,
  changes: string[],
  tools: ReturnType<Orchestrator['toolNames']>,
): Promise<AgentRun | null> {
  const engine = run.plannerEngine;
  await o.waitForEngine(engine);
  const config = await o.config(run);
  const projectName = basename(run.repoPath);
  const prompt = resumeSessionId
    ? buildAssistantWakePrompt(
        { messages: null, changes: ['Legion resumed your session.', ...changes], tools },
        projectName,
      )
    : buildAssistantPrompt({ message: run.issueText, repo: o.repoInput(run, config), projectName, tools });
  try {
    const session = await o.openSession({
      run,
      taskId: null,
      role: 'assistant',
      engine,
      model: run.plannerModel ?? o.modelFor('assistant', engine),
      effort: o.settings().roles.assistant.effort,
      prompt,
      outputSchema: null,
      cwd: run.repoPath,
      resumeSessionId,
      parentAttemptId: null,
      attachments: resumeSessionId ? null : o.runAttachments(run),
    });
    const previous = runMeta(o.store, run.id).assistantAttemptId;
    if (previous && previous !== session.attempt.id) o.store.reparentAttempts(previous, session.attempt.id);
    patchRunMeta(o.store, run.id, {
      assistantAttemptId: session.attempt.id,
      assistantSessionId: session.sessionId || resumeSessionId,
    });
    return session;
  } catch (error) {
    if (o.closed || error instanceof Closed) throw error;
    const failure = error instanceof AgentFailure ? error.failure : null;
    if (failure?.kind === 'rate_limited') {
      if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
      return openAssistant(o, run, resumeSessionId, changes, tools);
    }
    const message = failure?.message ?? (error as Error).message;
    if (resumeSessionId) patchRunMeta(o.store, run.id, { assistantSessionId: null });
    return (await noteAssistantFailure(o, run.id, message)) ? openAssistant(o, run, null, changes, tools) : null;
  }
}

/** Count a failure; false when the assistant is given up (a conversation that never became work then fails). */
async function noteAssistantFailure(o: Orchestrator, runId: string, message: string): Promise<boolean> {
  const failures = runMeta(o.store, runId).assistantFailures + 1;
  o.log.warn(`run ${runId}: assistant failed (${failures}/${MAX_ASSISTANT_FAILURES}): ${message}`);
  if (failures >= MAX_ASSISTANT_FAILURES) {
    patchRunMeta(o.store, runId, { assistantFailures: failures, assistantDisabled: true });
    const run = o.store.requireRun(runId);
    if (run.status === 'chatting') {
      o.store.transitionRun(runId, 'chatting', 'failed', { error: `the assistant failed: ${message}` });
    }
    return false;
  }
  patchRunMeta(o.store, runId, { assistantFailures: failures });
  await sleep(o.leadBackoffMs);
  return true;
}

// -- assistant tools (McpHost) ---------------------------------------------------------------------

export function startImplementation(
  o: Orchestrator,
  binding: McpBinding,
  request: StartImplementationRequest,
): { runId: string; status: string } {
  const run = o.store.requireRun(binding.runId);
  if (run.status !== 'chatting') {
    throw new Error(`the work was already started (run is ${run.status}); use run_status, or message the lead`);
  }
  const usable = o.registry.usable(run.plannerEngine);
  if (!usable.ok) throw new Error(usable.reason);
  const next = o.store.transaction(() => {
    o.store.updateRun(run.id, { title: request.title.trim() || run.title, issueText: request.brief });
    return o.store.transitionRun(run.id, 'chatting', request.clarify ? 'clarifying' : 'planning');
  });
  startPlanner(o, run.id);
  return { runId: run.id, status: next.status };
}

export function runStatus(o: Orchestrator, binding: McpBinding): AssistantRunStatus {
  const run = o.store.requireRun(binding.runId);
  const plan = o.store.latestPlan(run.id);
  const waiting = o.store
    .listInbox({ runId: run.id, includeResolved: false })
    .map((item) => HUMAN_ITEM_LINES[item.kind]?.(item) ?? '')
    .filter(Boolean);
  return {
    runId: run.id,
    title: run.title,
    status: run.status,
    paused: run.paused,
    plan: plan ? { version: plan.version, approved: plan.approvedAt !== null } : null,
    tasks: board(o, run.id).map((row) => ({
      nodeId: row.nodeId,
      title: row.title,
      status: row.status,
      summary: row.summary,
      error: row.error,
    })),
    waitingForHuman: waiting,
    prUrl: run.prUrl,
    error: run.error,
  };
}
