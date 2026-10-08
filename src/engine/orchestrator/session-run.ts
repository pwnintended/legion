/**
 * Direct sessions (`runs.session`, ⌘⇧N): one agent (role `session`) the human talks to, working in the project's
 * checkout itself. No worktree, no plan, no review: the run stays in `session` while the agent's process lives,
 * idle between turns, and the human talks to it with `sessions.send` like any live session. The loop below only
 * keeps that process open: it resumes the engine session after a crash or an engine restart, and gives up after
 * `MAX_SESSION_FAILURES` failures in a row. Stopping the run (`runs.cancel`) or archiving it ends it.
 */
import { basename } from 'node:path';
import type { Run } from '@shared/domain';
import type { RpcInput } from '@shared/rpc';
import type { AgentPrompt } from './core';
import type { AgentRun } from './live-session';
import { patchRunMeta, runMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator, sleep } from './orchestrator';
import { insertRun } from './planner';

/** Consecutive failures to open or keep the session before the run fails. */
export const MAX_SESSION_FAILURES = 3;

/** `runs.session`: a run in `session` whose first message is the prompt; its agent opens at once. */
export async function createSession(o: Orchestrator, input: RpcInput<'runs.session'>): Promise<Run> {
  const run = await insertRun(
    o,
    {
      repoPath: input.repoPath,
      baseRef: null,
      title: null,
      issueText: input.prompt,
      issueUrl: null,
      plannerEngine: input.engine,
      plannerModel: input.model,
      attachmentIds: input.attachmentIds,
    },
    'session',
  );
  o.startSession(run.id);
  return run;
}

function sessionPrompt(run: Run, text: string): AgentPrompt {
  const project = basename(run.repoPath);
  return {
    systemPrompt: [
      `You are working directly in the human's own checkout of ${project} (branch ${run.baseRef}), in a conversation with them.`,
      'Do what they ask here, and answer their questions. Your edits land in their working tree as they are.',
      "Don't commit or push: the human does that.",
    ].join(' '),
    prompt: text,
  };
}

/** The session loop of one run; returns when the run is no longer in `session` or the session is given up. */
export async function runSession(o: Orchestrator, runId: string): Promise<void> {
  let session: AgentRun | null = null;
  try {
    for (;;) {
      o.assertOpen();
      if (o.store.requireRun(runId).status !== 'session') break;
      if (!session) {
        session = await openSession(o, o.store.requireRun(runId));
        if (!session) break;
      }
      const turn = await session.nextTurn();
      o.assertOpen();
      if (turn.kind === 'exited') {
        // Stopped or archived: the run moved on and closed the session.
        if (o.store.requireRun(runId).status !== 'session') {
          session = null;
          break;
        }
        const message = turn.error?.message ?? 'the session process exited';
        await o.finishAttempt(session, 'failed', message);
        session = null;
        if (!(await noteFailure(o, runId, message))) break;
      } else if (!turn.isError && runMeta(o.store, runId).sessionFailures > 0) {
        patchRunMeta(o.store, runId, { sessionFailures: 0 });
      }
    }
  } catch (error) {
    if (o.closed || error instanceof Closed) return;
    o.log.error(`run ${runId}: session loop failed`, error);
  } finally {
    if (session && !session.ended) await o.finishAttempt(session, 'succeeded').catch(() => undefined);
  }
}

async function openSession(o: Orchestrator, run: Run): Promise<AgentRun | null> {
  const engine = run.plannerEngine;
  const meta = runMeta(o.store, run.id);
  const resumeSessionId = meta.sessionSessionId;
  await o.waitForEngine(engine);
  const prompt = resumeSessionId
    ? sessionPrompt(run, 'Legion restarted this session. Continue where you left off, or wait for the human.')
    : sessionPrompt(run, run.issueText);
  try {
    const session = await o.openSession({
      run,
      taskId: null,
      role: 'session',
      engine,
      model: run.plannerModel ?? o.modelFor('session', engine),
      effort: o.settings().roles.session.effort,
      prompt,
      outputSchema: null,
      cwd: run.repoPath,
      resumeSessionId,
      parentAttemptId: null,
      attachments: resumeSessionId ? null : o.runAttachments(run),
      // The first message is the human's; a resumed session's wake is Legion's own.
      humanMessage:
        resumeSessionId || meta.sessionAttemptId ? null : { text: run.issueText, attachments: run.attachments ?? [] },
    });
    patchRunMeta(o.store, run.id, {
      sessionAttemptId: session.attempt.id,
      sessionSessionId: session.sessionId || resumeSessionId,
    });
    return session;
  } catch (error) {
    if (o.closed || error instanceof Closed) throw error;
    const failure = error instanceof AgentFailure ? error.failure : null;
    if (failure?.kind === 'rate_limited') {
      if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
      return openSession(o, run);
    }
    const message = failure?.message ?? (error as Error).message;
    if (resumeSessionId) patchRunMeta(o.store, run.id, { sessionSessionId: null });
    return (await noteFailure(o, run.id, message)) ? openSession(o, o.store.requireRun(run.id)) : null;
  }
}

/** Count a failure; false when the session is given up (the run then fails). */
async function noteFailure(o: Orchestrator, runId: string, message: string): Promise<boolean> {
  const failures = runMeta(o.store, runId).sessionFailures + 1;
  o.log.warn(`run ${runId}: session failed (${failures}/${MAX_SESSION_FAILURES}): ${message}`);
  patchRunMeta(o.store, runId, { sessionFailures: failures });
  if (failures >= MAX_SESSION_FAILURES) {
    if (o.store.requireRun(runId).status === 'session') {
      o.store.transitionRun(runId, 'session', 'failed', { error: `the session failed: ${message}` });
    }
    return false;
  }
  await sleep(o.leadBackoffMs);
  return true;
}

/** End a direct session for good (archiving it): close its agent, the run is `done`. */
export async function endSession(o: Orchestrator, runId: string): Promise<Run> {
  const run = o.store.requireRun(runId);
  if (run.status !== 'session') return run;
  const next = o.store.transaction(() => {
    for (const attempt of o.store.listAttempts(runId)) {
      if (attempt.status === 'running') o.store.transitionAttempt(attempt.id, 'running', 'succeeded');
      else if (attempt.status === 'interrupted' || attempt.status === 'pending') {
        o.store.transitionAttempt(attempt.id, attempt.status, 'cancelled', { error: 'session ended' });
      }
    }
    o.dismissOpen(runId, () => true, 'session ended');
    return o.store.transitionRun(runId, 'session', 'done');
  });
  const live = [...o.live.values()].filter((session) => session.attempt.runId === runId);
  await Promise.allSettled(
    live.map(async (session) => {
      await session.session.interrupt().catch(() => undefined);
      await session.close();
    }),
  );
  return next;
}
