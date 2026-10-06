/**
 * A renderer-only stand-in for the engine connection: answers RPCs from the fixture world, replays transcript
 * history as `agent.event`s on subscribe and keeps a few agents "working" with a slow live script.
 * Mutating procedures (inbox.resolve, runs.pause/resume, runs.approvePlan) update the world and push the
 * resulting events, so the UI behaves as it would against the real engine.
 */
import {
  type Attempt,
  applySettingsPatch,
  type EngineKind,
  type InboxItem,
  type QuestionAnswer,
  type Run,
  type SettingsPatch,
  type Task,
} from '@shared/domain';
import type { AgentEvent, ServerEvent, ServerEventBody } from '@shared/events';
import type { ProcedureName, RepoInspection, RpcInput, RpcOutput, TranscriptEntry } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { isArchived } from '../compat';
import type { ConnectionState } from '../engine-connection';
import type { EngineClient } from '../sync';
import { createDemoWorld, type DemoWorld, LIVE_SCRIPT, snapshotOf } from './fixtures';
import { extra, withLifecycleDemo } from './lifecycle';
import { type DemoRpcContext, extendDemoWorld, handlePlanReviewRpc, isHandled } from './plan-review';
import { withSessionLive } from './sessions';

const SCRIPT = withSessionLive(LIVE_SCRIPT);

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
  private created = 0;

  constructor(options: { live?: boolean; now?: number } = {}) {
    const now = options.now ?? Date.now();
    const world = createDemoWorld(now);
    extendDemoWorld(world, now);
    this.world = withLifecycleDemo(world, now);
    // Transcript history gets seqs below the snapshot seq (it happened before the snapshot was read).
    let seq = 100;
    for (const [attemptId, events] of Object.entries(this.world.transcripts)) {
      const span = events.length;
      this.history[attemptId] = events.map((event, i) => ({
        seq: seq++,
        ts: now - (span - i) * Math.min(40_000, (30 * 60_000) / span),
        event,
      }));
    }
    this.headSeq = Math.max(SNAPSHOT_SEQ, seq);
    queueMicrotask(() => this.setState({ status: 'connected', generation: 1 }));
    if (options.live !== false) this.timer = setInterval(() => this.tick(), 4000);
  }

  /**
   * Replay history the way the engine does for subscribe({ sinceSeq: 0 }), once someone listens (the client
   * may be created before the store subscribes, e.g. when demo mode is loaded lazily).
   */
  private replayed = false;
  private replay(): void {
    if (this.replayed) return;
    this.replayed = true;
    {
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
    }
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
    queueMicrotask(() => this.replay());
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
        return structuredClone(w.engines);
      case 'engines.probe': {
        const kind = input.kind as EngineKind | null;
        for (const engine of w.engines) if (kind === null || engine.kind === kind) engine.probedAt = Date.now();
        return structuredClone(w.engines.filter((e) => kind === null || e.kind === kind));
      }
      case 'settings.get':
        return structuredClone(w.settings);
      case 'settings.set': {
        try {
          w.settings = applySettingsPatch(w.settings, input as SettingsPatch);
        } catch (error) {
          throw new RpcError('bad_request', error instanceof Error ? error.message : String(error));
        }
        this.emit([{ type: 'settings.updated', settings: structuredClone(w.settings) }]);
        return structuredClone(w.settings);
      }
      case 'subscribe':
        return { headSeq: this.headSeq, replayed: true };
      case 'runs.list':
        return w.runs
          .filter((run) => input.includeArchived === true || !isArchived(run))
          .map((run) => {
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
      case 'runs.archive' as ProcedureName: {
        const run = w.runs.find((r) => r.id === input.runId);
        if (!run) throw new RpcError('not_found', 'run not found');
        if (!['done', 'failed', 'cancelled'].includes(run.status))
          throw new RpcError('failed_precondition', `run is ${run.status}; archive it once it is finished`);
        extra(run, { archived: true });
        return this.updateRun(run.id, {});
      }
      case 'runs.refreshPr' as ProcedureName: {
        const run = w.runs.find((r) => r.id === input.runId);
        if (!run?.prUrl) throw new RpcError('failed_precondition', 'no pull request yet');
        // The demo's reviewers are quick: a refreshed draft PR has been merged on GitHub.
        const pr = (run as { pr?: { number?: number } }).pr;
        extra(run, { pr: { url: run.prUrl, number: pr?.number ?? 412, state: 'merged', isDraft: false } });
        return this.updateRun(run.id, {});
      }
      case 'runs.pause':
      case 'runs.resume':
        return this.updateRun(input.runId as string, { paused: method === 'runs.pause' });
      case 'runs.approvePlan':
        return this.approvePlan(input.runId as string);
      case 'repos.recent':
        return [
          { path: '/Users/dev/src/erudiet/app', name: 'app', lastUsedAt: Date.now() - 60_000 },
          { path: '/Users/dev/src/erudiet/web', name: 'web', lastUsedAt: Date.now() - 3_600_000 },
          { path: '/Users/dev/src/erudiet/api', name: 'api', lastUsedAt: Date.now() - 86_400_000 },
        ];
      case 'repos.inspect':
        return inspectDemoRepo(input.path as string);
      case 'runs.create':
        return this.createRun(input as unknown as RpcInput<'runs.create'>);
      case 'runs.answerClarify':
        return this.answerClarify(input.runId as string, input.answers as QuestionAnswer[]);
      case 'sessions.send':
        return this.steer(input.attemptId as string, input.text as string, input.priority as 'now' | 'next');
      case 'sessions.interrupt':
        return this.interruptSession(input.attemptId as string);
      case 'sessions.takeover':
        throw new RpcError('not_implemented', 'Takeover needs the real engine; demo mode has no agent processes.');
      case 'tasks.setEngine':
        return this.updateTask(input.taskId as string, {
          engineOverride: input.engine as Task['engineOverride'],
          modelOverride: (input.model as string | null) ?? null,
        });
      case 'tasks.retry':
        return this.updateTask(input.taskId as string, { status: 'queued', error: null });
      case 'tasks.skip':
        return this.updateTask(input.taskId as string, { status: 'skipped' });
      default: {
        const handled = handlePlanReviewRpc(this.extraContext, method, input);
        if (isHandled(handled)) return handled;
        throw new RpcError('not_implemented', `${method} is not available in demo mode`);
      }
    }
  }

  /** World access for the plan/review/PR demo procedures (plan-review.ts). */
  private get extraContext(): DemoRpcContext {
    return {
      world: this.world,
      emit: (bodies) => this.emit(bodies),
      later: (ms, fn) => {
        setTimeout(fn, ms);
      },
    };
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
    const index = this.scriptIndex;
    const step =
      index < SCRIPT.intro.length
        ? SCRIPT.intro[index]
        : SCRIPT.loop[(index - SCRIPT.intro.length) % SCRIPT.loop.length];
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
    if (item.kind === 'escalation' && item.taskId) {
      const action = (resolution as { action?: string }).action;
      const taskId = item.taskId;
      queueMicrotask(() => {
        if (action === 'retry' || action === 'edit') this.updateTask(taskId, { status: 'queued', error: null });
        else if (action === 'skip') this.updateTask(taskId, { status: 'skipped' });
        else if (action === 'abort') this.updateRun(item.runId, { status: 'cancelled' });
      });
    }
    if (item.kind === 'plan_signoff') {
      const approved = (resolution as { approved?: boolean }).approved;
      if (approved) queueMicrotask(() => this.approvePlan(item.runId));
    }
    this.emit(bodies);
    return structuredClone(item);
  }

  private attemptEvent(attempt: Attempt, event: AgentEvent): ServerEventBody {
    return { type: 'agent.event', runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id, event };
  }

  private steer(attemptId: string, text: string, priority: 'now' | 'next'): { ok: true } {
    const attempt = this.world.attempts.find((a) => a.id === attemptId);
    if (attempt?.status !== 'running') throw new RpcError('conflict', 'session is not running');
    setTimeout(() => {
      const reply =
        priority === 'now' ? `Stopping here to follow your note: "${text}".` : `Noted for the next step: "${text}".`;
      // The current turn ends (or is cut short) before the agent picks the note up.
      this.emit([
        this.attemptEvent(attempt, {
          type: 'turn_complete',
          structuredOutput: null,
          isError: false,
          reason: priority === 'now' ? 'interrupted' : null,
        }),
        this.attemptEvent(attempt, { type: 'message', text: reply }),
      ]);
    }, 900);
    return { ok: true };
  }

  private interruptSession(attemptId: string): { ok: true } {
    const attempt = this.world.attempts.find((a) => a.id === attemptId);
    if (attempt?.status !== 'running') throw new RpcError('conflict', 'session is not running');
    this.emit([
      this.attemptEvent(attempt, {
        type: 'turn_complete',
        structuredOutput: null,
        isError: false,
        reason: 'interrupted',
      }),
    ]);
    return { ok: true };
  }

  private updateTask(taskId: string, patch: Partial<Task>): Task {
    const task = this.world.tasks.find((t) => t.id === taskId);
    if (!task) throw new RpcError('not_found', 'task not found');
    const from = task.status;
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.emit([{ type: 'task.updated', task: structuredClone(task), from }]);
    return structuredClone(task);
  }

  private createRun(input: RpcInput<'runs.create'>): Run {
    const now = Date.now();
    const firstLine = input.issueText.trim().split('\n')[0] ?? '';
    const fromUrl = input.issueUrl ? /\/issues\/(\d+)|([A-Z]+-\d+)/.exec(input.issueUrl) : null;
    const title =
      input.title ??
      (firstLine
        ? firstLine.length > 64
          ? `${firstLine.slice(0, 63)}…`
          : firstLine
        : fromUrl
          ? `Issue ${fromUrl[1] ? `#${fromUrl[1]}` : fromUrl[2]}`
          : 'New run');
    const run: Run = {
      id: `run_demonew${String(++this.created).padStart(5, '0')}`,
      repoPath: input.repoPath,
      baseRef: input.baseRef ?? 'main',
      title,
      issueText: input.issueText,
      issueUrl: input.issueUrl ?? null,
      status: input.skipClarify ? 'planning' : 'clarifying',
      paused: false,
      plannerEngine: input.plannerEngine,
      plannerModel: input.plannerModel ?? null,
      integrationBranch: null,
      prUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.world.runs.push(run);
    this.emit([{ type: 'run.updated', run: structuredClone(run), from: null }]);
    return structuredClone(run);
  }

  private answerClarify(runId: string, answers: QuestionAnswer[]): Run {
    const item = this.world.inbox.find(
      (i) => i.runId === runId && i.kind === 'question' && i.payload.source === 'clarify' && i.resolvedAt === null,
    );
    if (!item) throw new RpcError('conflict', 'no open clarify questions');
    Object.assign(item, { resolvedAt: Date.now(), resolution: { answers } });
    const bodies: ServerEventBody[] = [{ type: 'inbox.updated', item: structuredClone(item) }];
    const planner = this.world.attempts.find(
      (a) => a.runId === runId && a.role === 'planner' && a.status === 'running',
    );
    if (planner)
      bodies.push(
        this.attemptEvent(planner, {
          type: 'message',
          text: `Thanks. Drafting the plan with ${answers.filter((a) => a.answer.trim()).length} answers.`,
        }),
      );
    this.emit(bodies);
    return this.updateRun(runId, { status: 'planning' });
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

/** A plausible `repos.inspect` answer; paths containing "not-a-repo" are rejected. */
function inspectDemoRepo(path: string): RepoInspection {
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  const ok = !path.includes('not-a-repo');
  return {
    path,
    exists: true,
    isGitRepo: ok,
    root: ok ? path : null,
    currentBranch: ok ? 'main' : null,
    headSha: ok ? 'a1f3c9e4b2d8' : null,
    defaultBranch: ok ? 'main' : null,
    remotes: ok ? [{ name: 'origin', url: `https://github.com/erudiet/${name}.git` }] : [],
    github: ok ? { owner: 'erudiet', name } : null,
    dirty: false,
    hasGh: true,
    legionConfig: null,
    error: ok ? null : 'Not a git repository',
  };
}
