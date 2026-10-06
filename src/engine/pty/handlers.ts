import { statSync } from 'node:fs';
import type { TerminalTarget } from '@shared/rpc';
import { RpcError, toEndpoint } from '@shared/rpc-transport';
import type { EngineContext } from '../context';
import type { EngineRpcServer } from '../rpc/server';
import { PtyManager, type PtyOpenOptions } from './manager';
import { createNodePtySpawn } from './node-pty';
import type { PtySpawn } from './types';

export interface TerminalHandlerOptions {
  /** Inject a fake (tests). Defaults to node-pty, loaded lazily. */
  spawn?: PtySpawn;
  /**
   * Map an `attempt` target to the command that resumes it interactively. The default resumes the
   * attempt's CLI session (`claude --resume <id>` / `codex resume <id>`) in the task's worktree; the
   * orchestrator may replace it (e.g. to stop the structured session first).
   */
  resolveAttempt?: (attemptId: string) => Omit<PtyOpenOptions, 'cols' | 'rows'>;
  /** Kill a detached shell after this long (ms, default 10 min). Takeover sessions are kept. */
  shellDetachedTtlMs?: number;
}

export interface TerminalService {
  readonly manager: PtyManager;
  /** Kill every session (engine shutdown). */
  dispose(): void;
}

/** Environment every pty gets on top of the engine's (login-shell PATH etc.). */
export function ptyEnv(
  base: Readonly<Record<string, string>>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = { ...base, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Legion';
  return env;
}

/**
 * Implements `terminals.open | resize | close`. Wire it from `startEngine`:
 * `const terminals = registerTerminalHandlers(server, ctx);` and call `terminals.dispose()` on close.
 */
export function registerTerminalHandlers(
  server: EngineRpcServer,
  ctx: EngineContext,
  options: TerminalHandlerOptions = {},
): TerminalService {
  const manager = new PtyManager({
    spawn: options.spawn ?? createNodePtySpawn(),
    onExit: (terminalId, code) => ctx.log.info(`terminal ${terminalId} exited (${code ?? 'signal'})`),
    log: (message) => ctx.log.warn(message),
  });
  const shellTtl = options.shellDetachedTtlMs ?? 10 * 60_000;

  const resolveTarget = (target: TerminalTarget): Omit<PtyOpenOptions, 'cols' | 'rows'> => {
    if (target.kind === 'shell') {
      assertDirectory(target.cwd);
      const shell = ctx.env.SHELL || process.env.SHELL || '/bin/zsh';
      return { cmd: shell, args: ['-l'], cwd: target.cwd, env: ptyEnv(ctx.env), detachedTtlMs: shellTtl };
    }
    return (options.resolveAttempt ?? defaultResolveAttempt(ctx))(target.attemptId);
  };

  server.implement('terminals.open', (input, call) => {
    const port = call.ports[0];
    if (!port) throw new RpcError('bad_request', 'terminals.open needs a MessagePort in the transfer list');
    const endpoint = toEndpoint(port as Parameters<typeof toEndpoint>[0]);
    try {
      const opened = manager.open({ ...resolveTarget(input.target), cols: input.cols, rows: input.rows });
      manager.attach(opened.terminalId, endpoint);
      return { terminalId: opened.terminalId, pid: opened.pid };
    } catch (error) {
      endpoint.close();
      if (error instanceof RpcError) throw error;
      throw new RpcError('failed_precondition', `could not open terminal: ${(error as Error).message}`);
    }
  });

  server.implement('terminals.resize', ({ terminalId, cols, rows }) => {
    if (!manager.resize(terminalId, cols, rows)) throw new RpcError('not_found', `unknown terminal ${terminalId}`);
    return { ok: true };
  });

  server.implement('terminals.close', ({ terminalId }) => {
    manager.close(terminalId);
    return { ok: true };
  });

  return { manager, dispose: () => manager.dispose() };
}

function assertDirectory(path: string): void {
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // fall through
  }
  throw new RpcError('bad_request', `not a directory: ${path}`);
}

function defaultResolveAttempt(ctx: EngineContext): (attemptId: string) => Omit<PtyOpenOptions, 'cols' | 'rows'> {
  return (attemptId) => {
    const attempt = ctx.store.getAttempt(attemptId);
    if (!attempt) throw new RpcError('not_found', `unknown attempt ${attemptId}`);
    if (!attempt.sessionId) throw new RpcError('failed_precondition', 'the attempt has no resumable session yet');
    const task = attempt.taskId ? ctx.store.getTask(attempt.taskId) : null;
    const cwd = task?.worktreePath;
    if (!cwd) throw new RpcError('failed_precondition', 'the attempt has no worktree to open');
    assertDirectory(cwd);
    if (attempt.engine === 'fake') throw new RpcError('failed_precondition', 'fake sessions cannot be resumed');
    const args = attempt.engine === 'claude' ? ['--resume', attempt.sessionId] : ['resume', attempt.sessionId];
    return { cmd: attempt.engine, args, cwd, env: ptyEnv(ctx.env), key: `attempt:${attemptId}` };
  };
}
