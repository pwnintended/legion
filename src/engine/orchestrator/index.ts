/**
 * The run lifecycle service (architecture §8). `createOrchestrator` wires the flows; the engine entry
 * (`engine/index.ts`) adds the MCP server, terminals, RPC handlers and recovery. See README.md.
 */
import type { PtyProcess, PtySpawn } from '../pty';
import { PR_POLL_MS, startPrPolling } from './cleanup';
import { finalize } from './finalize';
import { mergeQueue } from './merge';
import { Orchestrator, type OrchestratorOptions } from './orchestrator';
import { driveTask } from './tasks';

export * from './actions';
export { archiveRun, PR_POLL_MS, refreshPr, startPrPolling } from './cleanup';
export { DEMO_PLAN, demoScript } from './demo';
export { getDiff } from './diff';
export { createPr, enterPrReady, prText } from './finalize';
export { registerOrchestratorHandlers } from './handlers';
export { AgentRun, HANDBACK_PROMPT, type TurnResult } from './live-session';
export { type RunMeta, runMeta, type TaskMeta, taskMeta } from './meta';
export {
  AgentFailure,
  Closed,
  classifyFailure,
  MCP_TOOL_TIMEOUT_MS,
  Orchestrator,
  type OrchestratorOptions,
  RATE_LIMIT_PAUSE_PCT,
} from './orchestrator';
export * from './planner';
export { type DraftPrRequest, FakePrHost, ghPrHost, type PrHost, prNumberOf } from './pr-host';
export { recover } from './recovery';
export { EngineRegistry, type EngineRegistryOptions, FAKE_ENGINES_ENV } from './registry';
export { attemptTerminal, resolveAttemptTerminal, takeover } from './sessions';

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const o = new Orchestrator(options);
  o.flows = {
    driveTask: (taskId) => driveTask(o, taskId),
    mergeQueue: (runId) => mergeQueue(o, runId),
    finalize: (runId) => finalize(o, runId),
  };
  const pollMs = options.prPollMs ?? PR_POLL_MS;
  if (pollMs > 0) o.disposers.push(startPrPolling(o, pollMs));
  return o;
}

/**
 * Wrap a PTY spawn so the orchestrator can wait for a process's exit by pid (takeover hand-back)
 * without depending on how many exit listeners the PTY implementation supports.
 */
export function trackPtyExits(inner: PtySpawn): {
  spawn: PtySpawn;
  exitOf(pid: number): Promise<number | null> | null;
} {
  const exits = new Map<number, Promise<number | null>>();
  const spawn: PtySpawn = (cmd, args, options) => {
    const proc = inner(cmd, args, options);
    const listeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    exits.set(proc.pid, exited);
    proc.onExit((event) => {
      for (const listener of listeners) listener(event);
      resolveExit(event.exitCode);
      setTimeout(() => exits.delete(proc.pid), 60_000).unref?.();
    });
    const wrapped: PtyProcess = {
      get pid() {
        return proc.pid;
      },
      onData: (listener) => proc.onData(listener),
      onExit: (listener) => {
        listeners.push(listener);
      },
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      pause: () => proc.pause(),
      resume: () => proc.resume(),
      kill: (signal) => proc.kill(signal),
    };
    return wrapped;
  };
  return { spawn, exitOf: (pid) => exits.get(pid) ?? null };
}
