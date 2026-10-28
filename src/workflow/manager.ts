/**
 * Owns the session's workflow runs: starts, resumes and cancels them, routes their gates, questions and tool
 * approvals to whoever answers (the TUI, the headless prompt), and re-broadcasts their progress. Runs execute
 * in-process; their journals make a run that dies with the process resumable (`resume`).
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { type Config, DEFAULT_MODELS, resolveAgentModel } from '../config.ts';
import type { AgentEngine, AgentSession, EngineKind, McpServer } from '../engine/types.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import { Semaphore } from '../util/semaphore.ts';
import {
  type AgentModelRequest,
  type GitOps,
  type Interaction,
  type InteractionAnswer,
  type RunEvent,
  type RunHost,
  type ShellOptions,
  type ShellResult,
  withDefaultBase,
} from './host.ts';
import { Journal, listRuns, newRunId, type RunRecord, readRun, runsDir, writeRun } from './journal.ts';
import { findWorkflow, loadWorkflow } from './loader.ts';
import { executeInRun, WorkflowCancelled } from './runtime.ts';
import { runShell } from './shell.ts';

export interface PendingInteraction {
  id: string;
  interaction: Interaction;
}

export interface RunManagerOptions {
  repo: string;
  /** The session's engine for a kind; asked at every agent start, so a profile switch applies to new steps. */
  engine: (kind: EngineKind) => AgentEngine;
  /** Profile name per kind right now (recorded on runs). */
  profiles: () => Record<string, string>;
  git: GitOps;
  maxAgents?: number;
  /** Agent sessions alive at once across all runs. Default: no limit beyond each run's own. */
  maxAgentsTotal?: number;
  approvals?: 'ask' | 'auto';
  /** The user's tiers and model settings (`[models]`, `[workflow.<name>]`), read at every agent start. */
  agentModels?: () => Pick<Config, 'workflow' | 'models'>;
  /** MCP servers for every agent of every run. */
  mcp?: () => Readonly<Record<string, McpServer>>;
  log?: Logger;
  sh?: (command: string, opts: ShellOptions) => Promise<ShellResult>;
  /** Wraps each run's host (remote mode sends worktree steps to boxes: `remote/remote.ts`). */
  wrapHost?: (host: RunHost, run: RunRecord) => RunHost;
  /** Called when a run has ended (not when it was only interrupted), after its worktrees are gone. */
  onRunEnded?: (runId: string) => Promise<void>;
}

interface ActiveRun {
  record: RunRecord;
  controller: AbortController;
  done: Promise<RunRecord>;
}

export interface RunManagerEvents {
  event: [RunEvent];
  interaction: [PendingInteraction];
  resolved: [string];
  finished: [RunRecord];
}

export class RunManager extends EventEmitter<RunManagerEvents> {
  private opts: RunManagerOptions;
  private readonly active = new Map<string, ActiveRun>();
  private readonly pending = new Map<string, { item: PendingInteraction; resolve: (answer: unknown) => void }>();
  /** Live agent sessions per run, by step key (for steering). */
  private readonly sessions = new Map<string, Map<string, AgentSession>>();
  /** Notes for a resumed run's next agent attempt (or a given step's). */
  private readonly notes = new Map<string, { step: string | null; text: string }>();
  private nextInteraction = 1;
  private readonly log: Logger;
  /** The session-wide agent limit; reads the setting at every acquire, so a change applies as slots free up. */
  private readonly agentSlots = new Semaphore(() => this.opts.maxAgentsTotal ?? Number.MAX_SAFE_INTEGER);
  /** Set while the session shuts down: runs stopped by it are `interrupted` (resumed next time), not cancelled. */
  private shuttingDown = false;

  constructor(opts: RunManagerOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** New defaults for runs started from now on. */
  configure(patch: Pick<RunManagerOptions, 'maxAgents' | 'approvals' | 'maxAgentsTotal'>): void {
    this.opts = { ...this.opts, ...patch };
  }

  get repo(): string {
    return this.opts.repo;
  }

  /** Validates `input` and starts the workflow. Resolves with the run id once it is running. */
  async start(
    nameOrPath: string,
    input: unknown,
    opts: { owner?: string; base?: string; cwd?: string } = {},
  ): Promise<string> {
    const found = findWorkflow(this.opts.repo, nameOrPath);
    if (!found) throw new Error(`No workflow named "${nameOrPath}"`);
    const def = await loadWorkflow(found.file);
    const parsed = def.input.safeParse(input ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid input for ${found.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      );
    }
    const id = newRunId();
    const record: RunRecord = {
      id,
      workflow: found.name,
      file: found.file,
      input: parsed.data,
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      status: 'running',
      profiles: this.opts.profiles(),
      repo: this.opts.repo,
      startedAt: Date.now(),
      endedAt: null,
      result: null,
      error: null,
    };
    this.launch(record, def.run);
    return id;
  }

  /**
   * Picks up runs an earlier session left unfinished: interrupted by its exit, or still marked running after a
   * crash. Returns the ids resumed.
   */
  async resumeInterrupted(): Promise<string[]> {
    const resumed: string[] = [];
    for (const r of listRuns(this.opts.repo)) {
      if ((r.status !== 'interrupted' && r.status !== 'running') || this.active.has(r.id)) continue;
      // "running" in another live Legion session is not ours to take over.
      if (r.status === 'running' && r.pid && r.pid !== process.pid && processAlive(r.pid)) continue;
      try {
        await this.resume(r.id);
        resumed.push(r.id);
      } catch (err) {
        this.log.warn(`could not resume run ${r.id}`, err);
      }
    }
    return resumed;
  }

  /**
   * Re-executes a run that stopped (crash, cancel, failure) from its journal. `notes` go into the prompt of the
   * agent step that runs first (or of `step`); `rewind` makes the finished `step` run again, and everything after
   * it. A rewound run may be one that finished.
   */
  async resume(
    runId: string,
    opts: { notes?: string | null; step?: string | null; rewind?: boolean } = {},
  ): Promise<string> {
    if (this.active.has(runId)) throw new Error(`Run ${runId} is still running`);
    const record = readRun(this.dir(runId));
    if (!record) throw new Error(`No run ${runId}`);
    if (opts.rewind) {
      if (!opts.step) throw new Error('rewind needs the step to go back to');
      const reset = this.journal(runId).rewind(opts.step);
      this.emit('event', { type: 'log', runId, message: `Rewound to ${opts.step}: ${reset.length} step(s) run again` });
    } else if (record.status === 'done') throw new Error(`Run ${runId} already finished (rewind a step to redo it)`);
    if (opts.notes) this.notes.set(runId, { step: opts.step ?? null, text: opts.notes });
    const def = await loadWorkflow(record.file);
    const now = this.opts.profiles();
    for (const [kind, profile] of Object.entries(record.profiles)) {
      if (now[kind] && now[kind] !== profile) {
        this.emit('event', {
          type: 'log',
          runId,
          message: `Run started on ${kind} profile "${profile}", this session uses "${now[kind]}": interrupted ${kind} steps restart instead of resuming their sessions.`,
        });
      }
    }
    this.launch({ ...record, status: 'running', endedAt: null, error: null, result: null }, def.run);
    return runId;
  }

  /** Agent steps of a run whose sessions are live, by full key. */
  liveAgents(runId: string): string[] {
    return [...(this.sessions.get(runId)?.keys() ?? [])];
  }

  /** Sends a message into a running agent step's session: it takes it into its current turn or the next one. */
  async messageAgent(runId: string, step: string, text: string): Promise<void> {
    const session = this.sessions.get(runId)?.get(step);
    if (!session) {
      const live = this.liveAgents(runId);
      throw new Error(
        `No running agent ${step} in run ${runId}${live.length ? ` (running: ${live.join(', ')})` : ' (none is running)'}`,
      );
    }
    await session.send(text, 'next');
    this.emit('event', {
      type: 'log',
      runId,
      message: `Message to ${step}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`,
    });
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /** Waits for a run to end. */
  wait(runId: string): Promise<RunRecord> | null {
    return this.active.get(runId)?.done ?? null;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  activeRuns(): RunRecord[] {
    return [...this.active.values()].map((r) => r.record);
  }

  runs(): RunRecord[] {
    return listRuns(this.opts.repo);
  }

  run(runId: string): RunRecord | null {
    return this.active.get(runId)?.record ?? readRun(this.dir(runId));
  }

  journal(runId: string): Journal {
    return new Journal(this.dir(runId));
  }

  pendingInteractions(): PendingInteraction[] {
    return [...this.pending.values()].map((p) => p.item);
  }

  answer<I extends Interaction>(id: string, answer: InteractionAnswer<I>): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(answer);
    const run = this.active.get(entry.item.interaction.runId);
    if (run) this.updateStatus(run.record);
    this.emit('resolved', id);
    return true;
  }

  /** Cancels every active run and waits for them to settle (session shutdown). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const waits = [...this.active.values()].map((r) => {
      r.controller.abort();
      return r.done.catch(() => {});
    });
    await Promise.all(waits);
  }

  private dir(runId: string): string {
    return join(runsDir(this.opts.repo), runId);
  }

  private launch(started: RunRecord, run: (input: unknown) => Promise<unknown>): void {
    const record: RunRecord = { ...started, pid: process.pid };
    const dir = this.dir(record.id);
    writeRun(dir, record);
    const journal = new Journal(dir);
    const controller = new AbortController();
    const base = this.host(record, controller.signal);
    const host = this.opts.wrapHost ? this.opts.wrapHost(base, record) : base;
    this.emit('event', { type: 'run', runId: record.id, status: 'running' });
    const done = executeInRun({ runId: record.id, host, journal, signal: controller.signal }, () => run(record.input))
      .then(
        (result) => ({ ...record, status: 'done' as const, result: result ?? null }),
        (err: unknown) => {
          const cancelled = err instanceof WorkflowCancelled || controller.signal.aborted;
          const message = err instanceof Error ? err.message : String(err);
          if (!cancelled) this.log.error(`run ${record.id} failed`, err);
          const status = cancelled ? (this.shuttingDown ? 'interrupted' : 'cancelled') : 'failed';
          return { ...record, status: status as RunRecord['status'], error: message };
        },
      )
      .then(async (final) => {
        const ended: RunRecord = { ...final, endedAt: Date.now() };
        writeRun(dir, ended);
        // Worktrees are gigabytes each: drop the directories of a run that ended (its branches stay; a resume
        // re-creates them). An interrupted run keeps them for the next session.
        if (ended.status !== 'interrupted' && this.opts.git.release) {
          await this.opts.git
            .release(record.id)
            .catch((err) => this.log.warn(`run ${record.id}: worktree cleanup`, err));
        }
        if (ended.status !== 'interrupted' && this.opts.onRunEnded) {
          await this.opts.onRunEnded(record.id).catch((err) => this.log.warn(`run ${record.id}: cleanup`, err));
        }
        this.active.delete(record.id);
        this.sessions.delete(record.id);
        this.notes.delete(record.id);
        // Interactions of a run that ended can no longer be answered.
        for (const [id, p] of this.pending) {
          if (p.item.interaction.runId === record.id) {
            this.pending.delete(id);
            this.emit('resolved', id);
          }
        }
        this.emit('event', {
          type: 'run',
          runId: record.id,
          status: ended.status,
          error: ended.error,
          result: ended.result,
        });
        this.emit('finished', ended);
        return ended;
      });
    this.active.set(record.id, { record, controller, done });
  }

  private host(record: RunRecord, signal: AbortSignal): RunHost {
    const manager = this;
    const opts = this.opts;
    return {
      repo: record.cwd ?? opts.repo,
      dryRun: false,
      maxAgents: opts.maxAgents ?? 4,
      acquireAgent: () => manager.agentSlots.acquire(),
      approvals: opts.approvals ?? 'auto',
      mcp: () => opts.mcp?.() ?? {},
      // Without the user's settings, agents run as the code says.
      ...(opts.agentModels
        ? {
            agentModel: (req: AgentModelRequest) => {
              const r = resolveAgentModel(opts.agentModels?.() ?? { workflow: {}, models: DEFAULT_MODELS }, {
                ...req,
                workflow: record.workflow,
              });
              return { engine: r.engine as EngineKind, model: r.model, effort: r.effort };
            },
          }
        : {}),
      git: record.base ? withDefaultBase(opts.git, record.base) : opts.git,
      engine: (kind) => opts.engine(kind),
      agentSession: (step, session) => {
        let live = manager.sessions.get(record.id);
        if (!live) {
          live = new Map();
          manager.sessions.set(record.id, live);
        }
        if (session) live.set(step, session);
        else live.delete(step);
      },
      notes: (step) => {
        const n = manager.notes.get(record.id);
        if (!n || (n.step !== null && n.step !== step)) return null;
        manager.notes.delete(record.id);
        return n.text;
      },
      emit: (event) => manager.emit('event', event),
      sh: opts.sh ?? runShell,
      interact<I extends Interaction>(interaction: I): Promise<InteractionAnswer<I>> {
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new WorkflowCancelled());
            return;
          }
          const id = `i${manager.nextInteraction++}`;
          const item: PendingInteraction = { id, interaction };
          manager.pending.set(id, { item, resolve: resolve as (answer: unknown) => void });
          signal.addEventListener(
            'abort',
            () => {
              if (manager.pending.delete(id)) {
                manager.emit('resolved', id);
                reject(new WorkflowCancelled());
              }
            },
            { once: true },
          );
          manager.emit('interaction', item);
          manager.updateStatus(record);
        });
      },
    };
  }

  /** `waiting` while a run has an open interaction, for listings. */
  private updateStatus(record: RunRecord): void {
    const waiting = [...this.pending.values()].some((p) => p.item.interaction.runId === record.id);
    record.status = waiting ? 'waiting' : 'running';
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
