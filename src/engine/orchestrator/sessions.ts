/**
 * Live session plumbing: `sessions.send/interrupt/takeover` and the command that resumes an attempt's
 * engine session interactively in a PTY (`claude --resume <id>` / `codex resume <id>` with Legion's
 * CODEX_HOME). Takeover hand-back: when the PTY exits, the adapter session is resumed (`AgentRun`).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { type PtyOpenOptions, ptyEnv } from '../pty';
import type { Orchestrator } from './orchestrator';

function liveSession(o: Orchestrator, attemptId: string) {
  o.store.requireAttempt(attemptId);
  const session = o.live.get(attemptId);
  if (!session || session.ended || session.takenOver) {
    throw new RpcError('failed_precondition', `attempt ${attemptId} has no live session`);
  }
  return session;
}

export async function sendToSession(
  o: Orchestrator,
  attemptId: string,
  text: string,
  priority: 'now' | 'next',
  attachmentIds: readonly string[] | null = null,
): Promise<void> {
  const session = liveSession(o, attemptId);
  const refs = o.attachments.refs(attachmentIds);
  if (refs.length) o.attachments.claim(refs, session.attempt.runId);
  session.record({ type: 'user_message', text, attachments: refs, priority });
  await session.steer(text, priority, refs.length ? o.attachments.forSession(refs) : null);
}

/** Stop the current turn; the session then waits for a human message (`sessions.send`). */
export async function interruptSession(o: Orchestrator, attemptId: string): Promise<void> {
  const session = liveSession(o, attemptId);
  session.humanInterrupt = true;
  await session.session.interrupt();
}

function isDirectory(path: string | null): path is string {
  try {
    return path !== null && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** PTY command resuming the attempt's engine session in its working directory. */
export function attemptTerminal(o: Orchestrator, attempt: Attempt): Omit<PtyOpenOptions, 'cols' | 'rows'> {
  if (attempt.engine === 'fake') {
    throw new RpcError('failed_precondition', 'scripted fake sessions cannot be resumed in a terminal');
  }
  if (!attempt.sessionId) throw new RpcError('failed_precondition', 'the attempt has no resumable session yet');
  const run = o.store.requireRun(attempt.runId);
  const task = attempt.taskId ? o.store.getTask(attempt.taskId) : null;
  const cwd = task?.worktreePath ?? o.integrationPath(run);
  if (!isDirectory(cwd)) throw new RpcError('failed_precondition', `the attempt's worktree is gone: ${cwd}`);
  const info = o.registry.info(attempt.engine);
  if (attempt.engine === 'claude') {
    return {
      cmd: info?.path ?? 'claude',
      args: ['--resume', attempt.sessionId],
      cwd,
      env: ptyEnv(o.ctx.env),
      key: `attempt:${attempt.id}`,
    };
  }
  // Codex threads live in Legion's CODEX_HOME (when it is in use, i.e. it holds the auth link).
  const home = o.registry.codexHome;
  const extra: Record<string, string> = existsSync(join(home, 'auth.json')) ? { CODEX_HOME: home } : {};
  return {
    cmd: info?.path ?? 'codex',
    args: ['resume', attempt.sessionId],
    cwd,
    env: ptyEnv(o.ctx.env, extra),
    key: `attempt:${attempt.id}`,
  };
}

/** `terminals.open` with an attempt target: refuse while the structured session is live. */
export function resolveAttemptTerminal(o: Orchestrator, attemptId: string): Omit<PtyOpenOptions, 'cols' | 'rows'> {
  const attempt = o.store.getAttempt(attemptId);
  if (!attempt) throw new RpcError('not_found', `unknown attempt ${attemptId}`);
  const live = o.live.get(attemptId);
  if (live && !live.ended && !live.takenOver) {
    throw new RpcError('failed_precondition', 'the session is live: take it over first (sessions.takeover)');
  }
  return attemptTerminal(o, attempt);
}

/**
 * `sessions.takeover`: interrupt + close the adapter session, mark the attempt interrupted ("taken
 * over"), open a PTY resuming it. When the PTY exits the adapter session is resumed and the lifecycle
 * continues where it was waiting.
 */
export async function takeover(
  o: Orchestrator,
  attemptId: string,
  cols: number,
  rows: number,
): Promise<{ terminalId: string }> {
  const attempt = o.store.requireAttempt(attemptId);
  const terminals = o.terminals;
  if (!terminals) throw new RpcError('failed_precondition', 'terminals are not available in this engine');
  const existing = o.takeovers.get(attemptId);
  if (existing && terminals.manager.has(existing)) return { terminalId: existing };
  const command = attemptTerminal(o, attempt);
  const live = o.live.get(attemptId);
  if (live && !live.ended) await live.beginTakeover();
  let opened: { terminalId: string; pid: number };
  try {
    opened = terminals.manager.open({ ...command, cols, rows });
  } catch (error) {
    live?.endTakeover();
    throw new RpcError('failed_precondition', `could not open the terminal: ${(error as Error).message}`);
  }
  o.takeovers.set(attemptId, opened.terminalId);
  const exit = o.ptyExit?.(opened.pid) ?? null;
  if (exit) {
    void exit.then(() => {
      o.takeovers.delete(attemptId);
      live?.endTakeover();
    });
  }
  return { terminalId: opened.terminalId };
}
