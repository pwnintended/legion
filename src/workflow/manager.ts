/**
 * Owns the session's workflow runs: starts, resumes and cancels them, routes their gates, questions and tool
 * approvals to whoever answers (the TUI, the headless prompt), and re-broadcasts their progress. Runs execute
 * in-process; their journals make a run that dies with the process resumable (`resume`).
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { type Config, resolveAgentModel } from '../config.ts';
import type { AgentEngine, EngineKind, McpServer } from '../engine/types.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import type { GitOps, Interaction, InteractionAnswer, RunEvent, RunHost, ShellOptions, ShellResult } from './host.ts';
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
  approvals?: 'ask' | 'auto';
  /** The user's model settings per workflow (`[workflow.<name>]`), read at every agent start. */
  agentModels?: () => Config['workflow'];
  /** MCP servers for every agent of every run. */
  mcp?: () => Readonly<Record<string, McpServer>>;
  log?: Logger;
  sh?: (command: string, opts: ShellOptions) => Promise<ShellResult>;
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
  private nextInteraction = 1;
  private readonly log: Logger;

  constructor(opts: RunManagerOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** New defaults for runs started from now on. */
  configure(patch: Pick<RunManagerOptions, 'maxAgents' | 'approvals'>): void {
    this.opts = { ...this.opts, ...patch };
  }

  get repo(): string {
    return this.opts.repo;
  }

  /** Validates `input` and starts the workflow. Resolves with the run id once it is running. */
  async start(nameOrPath: string, input: unknown, opts: { owner?: string } = {}): Promise<string> {
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

  /** Re-executes a run that stopped (crash, cancel, failure) from its journal. */
  async resume(runId: string): Promise<string> {
    if (this.active.has(runId)) throw new Error(`Run ${runId} is still running`);
    const record = readRun(this.dir(runId));
    if (!record) throw new Error(`No run ${runId}`);
    if (record.status === 'done') throw new Error(`Run ${runId} already finished`);
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
    this.launch({ ...record, status: 'running', endedAt: null, error: null }, def.run);
    return runId;
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
    const waits = [...this.active.values()].map((r) => {
      r.controller.abort();
      return r.done.catch(() => {});
    });
    await Promise.all(waits);
  }

  private dir(runId: string): string {
    return join(runsDir(this.opts.repo), runId);
  }

  private launch(record: RunRecord, run: (input: unknown) => Promise<unknown>): void {
    const dir = this.dir(record.id);
    writeRun(dir, record);
    const journal = new Journal(dir);
    const controller = new AbortController();
    const host = this.host(record, controller.signal);
    this.emit('event', { type: 'run', runId: record.id, status: 'running' });
    const done = executeInRun({ runId: record.id, host, journal, signal: controller.signal }, () => run(record.input))
      .then(
        (result) => ({ ...record, status: 'done' as const, result: result ?? null }),
        (err: unknown) => {
          const cancelled = err instanceof WorkflowCancelled || controller.signal.aborted;
          const message = err instanceof Error ? err.message : String(err);
          if (!cancelled) this.log.error(`run ${record.id} failed`, err);
          return { ...record, status: cancelled ? ('cancelled' as const) : ('failed' as const), error: message };
        },
      )
      .then((final) => {
        const ended: RunRecord = { ...final, endedAt: Date.now() };
        writeRun(dir, ended);
        this.active.delete(record.id);
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
      repo: opts.repo,
      dryRun: false,
      maxAgents: opts.maxAgents ?? 4,
      approvals: opts.approvals ?? 'ask',
      mcp: () => opts.mcp?.() ?? {},
      agentModel: (req) => {
        const r = resolveAgentModel(opts.agentModels?.() ?? {}, { ...req, workflow: record.workflow });
        return { engine: r.engine as EngineKind, model: r.model, effort: r.effort };
      },
      git: opts.git,
      engine: (kind) => opts.engine(kind),
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
