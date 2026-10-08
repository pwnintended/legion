/**
 * Direct sessions (`runs.session`, ⌘⇧N): one agent (role `session`) the human talks to, working in the project's
 * checkout itself. No worktree, no plan, no review: the run stays in `session` until it is archived or stopped.
 * The agent's process lives only while it works: when its turn ends the loop below stops it (the attempt
 * succeeds), and the human's next `sessions.send` resumes the engine session with that message, as a new
 * attempt. A turn cut off by a crash or an engine restart is resumed at once; an idle session is not woken.
 * The loop gives up after `MAX_SESSION_FAILURES` failures in a row.
 */
import { basename } from 'node:path';
import type { AttachmentRef } from '@shared/attachments';
import type { Run } from '@shared/domain';
import type { SessionAttachment } from '@shared/engine';
import type { RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import type { AgentPrompt } from './core';
import type { AgentRun } from './live-session';
import { patchRunMeta, runMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator, type SessionLoopHandle, sleep } from './orchestrator';
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

type HumanSend = SessionLoopHandle['sends'][number];

/** What the agent's process opens with. */
interface SessionInput {
  text: string;
  attachments: readonly SessionAttachment[] | null;
  /** The text is the human's: recorded in the transcript as theirs. */
  human: { text: string; attachments: readonly AttachmentRef[] } | null;
}

/** The first prompt, the human's next message, or the turn a restart cut off; null = wait for the human. */
function nextInput(o: Orchestrator, run: Run, loop: SessionLoopHandle): SessionInput | null {
  const meta = runMeta(o.store, run.id);
  if (!meta.sessionAttemptId) {
    const human = { text: run.issueText, attachments: run.attachments ?? [] };
    return { text: run.issueText, attachments: o.runAttachments(run), human };
  }
  const send = loop.sends.shift();
  if (send) return { text: send.text, attachments: o.attachments.forSession(send.attachments), human: send };
  if (meta.sessionTurnOpen) {
    return {
      text: 'Legion restarted this session in the middle of your turn. Continue where you left off.',
      attachments: null,
      human: null,
    };
  }
  return null;
}

/** The session loop of one run; returns when the run is no longer in `session` or the session is given up. */
export async function runSession(o: Orchestrator, runId: string, loop: SessionLoopHandle): Promise<void> {
  let session: AgentRun | null = null;
  try {
    for (;;) {
      o.assertOpen();
      const woken = loop.wake.promise;
      const run = o.store.requireRun(runId);
      if (run.status !== 'session') break;
      if (!session) {
        const input = nextInput(o, run, loop);
        if (!input) {
          await woken;
          continue;
        }
        session = await openSession(o, run, input);
        if (!session) break;
        // Sent while it opened.
        for (const send of loop.sends.splice(0)) await deliver(o, session, send, 'next');
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
        continue;
      }
      if (!turn.isError && runMeta(o.store, runId).sessionFailures > 0) {
        patchRunMeta(o.store, runId, { sessionFailures: 0 });
      }
      // Nothing more for it to do: stop the process until the human writes again.
      if (!session.inTurn && session.sending === 0) {
        patchRunMeta(o.store, runId, { sessionTurnOpen: false });
        const failed = turn.isError && turn.reason !== 'interrupted';
        await o.finishAttempt(session, failed ? 'failed' : 'succeeded', failed ? (turn.error?.message ?? null) : null);
        session = null;
      }
    }
  } catch (error) {
    if (o.closed || error instanceof Closed) return;
    o.log.error(`run ${runId}: session loop failed`, error);
  } finally {
    if (session && !session.ended) await o.finishAttempt(session, 'succeeded').catch(() => undefined);
  }
}

/** A message of the human's into the session's running process. */
async function deliver(o: Orchestrator, session: AgentRun, send: HumanSend, priority: 'now' | 'next') {
  patchRunMeta(o.store, session.attempt.runId, { sessionTurnOpen: true });
  session.record({ type: 'user_message', text: send.text, attachments: send.attachments, priority });
  await session.steer(send.text, priority, send.attachments.length ? o.attachments.forSession(send.attachments) : null);
}

/**
 * `sessions.send` to a direct session (whichever of its attempts the human addressed): into the running turn, or
 * the session's process reopens with it.
 */
export async function sendToDirectSession(
  o: Orchestrator,
  runId: string,
  send: HumanSend,
  priority: 'now' | 'next',
): Promise<void> {
  const run = o.store.requireRun(runId);
  if (run.status !== 'session') throw new RpcError('failed_precondition', `the session is ${run.status}`);
  const live = [...o.live.values()].find((s) => s.attempt.runId === runId && s.attempt.role === 'session' && !s.closed);
  if (live?.takenOver) throw new RpcError('failed_precondition', 'the session is taken over in a terminal');
  if (live) return deliver(o, live, send, priority);
  o.startSession(runId);
  const loop = o.sessionLoops.get(runId);
  if (!loop) throw new RpcError('failed_precondition', 'the engine is shutting down');
  loop.sends.push(send);
  o.wakeSession(runId);
}

async function openSession(o: Orchestrator, run: Run, input: SessionInput): Promise<AgentRun | null> {
  const engine = run.plannerEngine;
  const meta = runMeta(o.store, run.id);
  const resumeSessionId = meta.sessionSessionId;
  await o.waitForEngine(engine);
  const prompt = sessionPrompt(run, input.text);
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
      attachments: input.attachments,
      humanMessage: input.human,
    });
    patchRunMeta(o.store, run.id, {
      sessionAttemptId: session.attempt.id,
      sessionSessionId: session.sessionId || resumeSessionId,
      sessionTurnOpen: true,
    });
    return session;
  } catch (error) {
    if (o.closed || error instanceof Closed) throw error;
    const failure = error instanceof AgentFailure ? error.failure : null;
    if (failure?.kind === 'rate_limited') {
      if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
      return openSession(o, run, input);
    }
    const message = failure?.message ?? (error as Error).message;
    if (resumeSessionId) patchRunMeta(o.store, run.id, { sessionSessionId: null });
    return (await noteFailure(o, run.id, message)) ? openSession(o, o.store.requireRun(run.id), input) : null;
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
  o.wakeSession(runId);
  const live = [...o.live.values()].filter((session) => session.attempt.runId === runId);
  await Promise.allSettled(
    live.map(async (session) => {
      await session.session.interrupt().catch(() => undefined);
      await session.close();
    }),
  );
  return next;
}
