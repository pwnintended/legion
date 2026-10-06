/**
 * A renderer-only stand-in for the engine connection: answers RPCs from the fixture world, replays transcript
 * history as `agent.event`s on subscribe and keeps a few agents "working" with a slow live script.
 * Mutating procedures (inbox.resolve, runs.pause/resume, runs.approvePlan) update the world and push the
 * resulting events, so the UI behaves as it would against the real engine.
 */
import type { InboxItem, Run, Task } from '@shared/domain';
import type { ServerEvent, ServerEventBody } from '@shared/events';
import type { ProcedureName, RpcInput, RpcOutput, TranscriptEntry } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import type { ConnectionState } from '../engine-connection';
import type { EngineClient } from '../sync';
import { createDemoWorld, type DemoWorld, LIVE_SCRIPT, snapshotOf } from './fixtures';

const SNAPSHOT_SEQ = 1000;

export class DemoClient implements EngineClient {
  private readonly world: DemoWorld;
  private readonly history: Record<string, TranscriptEntry[]> = {};
  private headSeq = SNAPSHOT_SEQ;
  private lastDelivered = 0;
  private state: ConnectionState = { status: 'connecting', generation: 0 };
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(events: ServerEvent[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scriptIndex = 0;

  constructor(options: { live?: boolean; now?: number } = {}) {
    const now = options.now ?? Date.now();
    this.world = createDemoWorld(now);
    // Transcript history gets seqs below the snapshot seq (it happened before the snapshot was read).
    let seq = 100;
    for (const [attemptId, events] of Object.entries(this.world.transcripts)) {
      const span = events.length;
      this.history[attemptId] = events.map((event, i) => ({ seq: seq++, ts: now - (span - i) * 40_000, event }));
    }
    queueMicrotask(() => {
      this.setState({ status: 'connected', generation: 1 });
      // Replay history the way the engine does for subscribe({ sinceSeq: 0 }).
      const replay: ServerEvent[] = [];
      for (const [attemptId, entries] of Object.entries(this.history)) {
        const attempt = this.world.attempts.find((a) => a.id === attemptId);
        for (const entry of entries)
          replay.push({
            type: 'agent.event',
            runId: attempt?.runId ?? '',
            taskId: attempt?.taskId ?? null,
            attemptId,
            event: entry.event,
            seq: entry.seq,
            ts: entry.ts,
          });
      }
      this.deliver(replay.sort((a, b) => a.seq - b.seq));
    });
    if (options.live !== false) this.timer = setInterval(() => this.tick(), 4000);
  }

  getState = (): ConnectionState => this.state;

  get seq(): number {
    return this.lastDelivered;
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvents(listener: (events: ServerEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onReset(): () => void {
    return () => {};
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async call<P extends ProcedureName>(method: P, input: RpcInput<P>): Promise<RpcOutput<P>> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return this.handle(method, input) as RpcOutput<P>;
  }

  private handle(method: ProcedureName, raw: unknown): unknown {
    const w = this.world;
    const input = raw as Record<string, unknown>;
    switch (method) {
      case 'app.info':
        return {
          name: 'Legion',
          version: '0.1.0',
          engineVersion: 'demo',
          runtime: { node: '24', electron: null, platform: 'darwin', arch: 'arm64' },
          pid: 0,
          dataDir: '(demo)',
          dbPath: '(demo)',
          schemaVersion: 1,
          startedAt: Date.now(),
          headSeq: this.headSeq,
        };
      case 'engines.list':
      case 'engines.probe':
        return structuredClone(w.engines);
      case 'settings.get':
        return structuredClone(w.settings);
      case 'subscribe':
        return { headSeq: this.headSeq, replayed: true };
      case 'runs.list':
        return w.runs.map((run) => {
          const tasks = w.tasks.filter((t) => t.runId === run.id);
          const taskCounts: Partial<Record<Task['status'], number>> = {};
          for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
          return {
            run: structuredClone(run),
            taskCounts,
            openInbox: w.inbox.filter((i) => i.runId === run.id && i.resolvedAt === null).length,
            costUsd: w.attempts.filter((a) => a.runId === run.id).reduce((s, a) => s + (a.costUsd ?? 0), 0),
          };
        });
      case 'runs.get': {
        const snapshot = snapshotOf(w, input.runId as string, this.headSeq);
        if (!snapshot) throw new RpcError('not_found', `run ${String(input.runId)} not found`);
        return snapshot;
      }
      case 'inbox.list':
        return structuredClone(
          w.inbox.filter(
            (i) =>
              (input.runId === null || i.runId === input.runId) && (input.includeResolved || i.resolvedAt === null),
          ),
        );
      case 'attempts.get': {
        const attempt = w.attempts.find((a) => a.id === input.attemptId);
        if (!attempt) throw new RpcError('not_found', 'attempt not found');
        return structuredClone(attempt);
      }
      case 'attempts.transcript': {
        const entries = (this.history[input.attemptId as string] ?? []).filter(
          (e) => e.seq > (input.sinceSeq as number),
        );
        const limit = input.limit as number;
        return { entries: structuredClone(entries.slice(0, limit)), hasMore: entries.length > limit };
      }
      case 'inbox.resolve':
        return this.resolve(input.itemId as string, input.resolution as { kind: string });
      case 'runs.pause':
      case 'runs.resume':
        return this.updateRun(input.runId as string, { paused: method === 'runs.pause' });
      case 'runs.approvePlan':
        return this.approvePlan(input.runId as string);
      default:
        throw new RpcError('not_implemented', `${method} is not available in demo mode`);
    }
  }

  private emit(bodies: ServerEventBody[]): void {
    const events = bodies.map((body) => ({ ...body, seq: ++this.headSeq, ts: Date.now() }) as ServerEvent);
    this.deliver(events);
  }

  private deliver(events: ServerEvent[]): void {
    const fresh = events.filter((e) => e.seq > this.lastDelivered);
    const last = fresh.at(-1);
    if (!last) return;
    this.lastDelivered = last.seq;
    for (const event of fresh) {
      if (event.type !== 'agent.event') continue;
      const list = this.history[event.attemptId] ?? [];
      if (!list.some((e) => e.seq === event.seq)) list.push({ seq: event.seq, ts: event.ts, event: event.event });
      this.history[event.attemptId] = list;
    }
    for (const listener of this.eventListeners) listener(fresh);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.statusListeners) listener();
  }

  private tick(): void {
    const step = LIVE_SCRIPT[this.scriptIndex % LIVE_SCRIPT.length];
    this.scriptIndex++;
    if (!step) return;
    const attempt = this.world.attempts.find((a) => a.id === step.attemptId);
    if (attempt?.status !== 'running') return;
    const run = this.world.runs.find((r) => r.id === attempt.runId);
    if (run?.paused) return;
    this.emit([
      { type: 'agent.event', runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id, event: step.event },
    ]);
  }

  private updateRun(runId: string, patch: Partial<Run>): Run {
    const run = this.world.runs.find((r) => r.id === runId);
    if (!run) throw new RpcError('not_found', 'run not found');
    const from = run.status;
    Object.assign(run, patch, { updatedAt: Date.now() });
    this.emit([{ type: 'run.updated', run: structuredClone(run), from }]);
    return structuredClone(run);
  }

  private resolve(itemId: string, resolution: { kind: string }): InboxItem {
    const item = this.world.inbox.find((i) => i.id === itemId);
    if (!item) throw new RpcError('not_found', 'inbox item not found');
    if (item.resolvedAt !== null) throw new RpcError('conflict', 'already resolved');
    Object.assign(item, { resolvedAt: Date.now(), resolution });
    const bodies: ServerEventBody[] = [{ type: 'inbox.updated', item: structuredClone(item) }];
    if (item.kind === 'approval' && item.attemptId && item.taskId) {
      const allowed = (resolution as { decision?: { behavior?: string } }).decision?.behavior === 'allow';
      bodies.push({
        type: 'agent.event',
        runId: item.runId,
        taskId: item.taskId,
        attemptId: item.attemptId,
        event: allowed
          ? {
              type: 'message',
              text: 'Installed @simplewebauthn/browser 13.1.0; wiring startRegistration() into PasskeyList.',
            }
          : {
              type: 'message',
              text: 'Understood: writing a thin wrapper around navigator.credentials.create() instead.',
            },
      });
    }
    if (item.kind === 'plan_signoff') {
      const approved = (resolution as { approved?: boolean }).approved;
      if (approved) queueMicrotask(() => this.approvePlan(item.runId));
    }
    this.emit(bodies);
    return structuredClone(item);
  }

  private approvePlan(runId: string): Run {
    const w = this.world;
    const plan = w.plans.filter((p) => p.runId === runId).at(-1);
    if (!plan) throw new RpcError('not_found', 'no plan');
    plan.approvedAt = Date.now();
    const bodies: ServerEventBody[] = [{ type: 'plan.updated', plan: structuredClone(plan) }];
    for (const n of plan.dag.nodes) {
      if (w.tasks.some((t) => t.runId === runId && t.nodeId === n.id)) continue;
      const now = Date.now();
      const task: Task = {
        id: `task_${runId.slice(4, 12)}${n.id.toLowerCase()}`,
        runId,
        nodeId: n.id,
        status: n.dependsOn.length === 0 ? 'queued' : 'blocked',
        branch: null,
        worktreePath: null,
        startSha: null,
        attemptCount: 0,
        fixRounds: 0,
        mergedSha: null,
        engineOverride: null,
        modelOverride: null,
        effortOverride: null,
        progress: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      w.tasks.push(task);
      bodies.push({ type: 'task.updated', task: structuredClone(task), from: null });
    }
    for (const item of w.inbox) {
      if (item.runId === runId && item.kind === 'plan_signoff' && item.resolvedAt === null) {
        Object.assign(item, { resolvedAt: Date.now(), resolution: { approved: true, feedback: null } });
        bodies.push({ type: 'inbox.updated', item: structuredClone(item) });
      }
    }
    this.emit(bodies);
    return this.updateRun(runId, {
      status: 'executing',
      integrationBranch: `legion/${runId.slice(4, 12)}/integration`,
    });
  }
}

/** Demo mode: `?demo=1` (or `#demo`), `localStorage['legion.demo'] = '1'`, or `LEGION_DEMO=1` via the bridge. */
export function isDemoMode(): boolean {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1' || location.hash.includes('demo')) return true;
  } catch {
    // ignore
  }
  try {
    const bridge = (window as unknown as { legion?: { env?: Record<string, string | undefined> } }).legion;
    if (bridge?.env?.LEGION_DEMO === '1') return true;
  } catch {
    // ignore
  }
  try {
    return localStorage.getItem('legion.demo') === '1';
  } catch {
    return false;
  }
}

/** `?live=0` freezes the demo agents (stable screenshots). */
export function demoLive(): boolean {
  try {
    return new URLSearchParams(location.search).get('live') !== '0' && localStorage.getItem('legion.demo.live') !== '0';
  } catch {
    return true;
  }
}
