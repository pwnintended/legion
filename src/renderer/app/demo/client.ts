/**
 * A renderer-only stand-in for the engine connection: answers RPCs from the fixture world, replays transcript
 * history as `agent.event`s on subscribe and keeps a few agents "working" with a slow live script.
 * Mutating procedures (inbox.resolve, runs.pause/resume, runs.approvePlan) update the world and push the
 * resulting events, so the UI behaves as it would against the real engine.
 */
import { type AttachmentRef, cleanName, extensionOf, sizeProblem, sniffAttachment } from '@shared/attachments';
import {
  type Attempt,
  applySettingsPatch,
  type EngineKind,
  type InboxItem,
  type Project,
  type QuestionAnswer,
  type Run,
  type SettingsPatch,
  type Task,
} from '@shared/domain';
import type { AgentEvent, ServerEvent, ServerEventBody } from '@shared/events';
import type {
  DiscoveredRepo,
  ProcedureName,
  RepoBranches,
  RepoInspection,
  RpcInput,
  RpcOutput,
  TranscriptEntry,
} from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { isArchived } from '../compat';
import { demoScale } from '../demo-mode';
import type { ConnectionState } from '../engine-connection';
import type { EngineClient } from '../sync';
import { withBoardDemo } from './board';
import { DEMO_FILES, drawDemoShot, withConversationDemo } from './conversation';
import { createDemoWorld, type DemoWorld, LIVE_SCRIPT, snapshotOf } from './fixtures';
import { extra, withLifecycleDemo } from './lifecycle';
import { type DemoRpcContext, extendDemoWorld, handlePlanReviewRpc, isHandled } from './plan-review';
import {
  createDemoProjects,
  type DemoProjects,
  demoFind,
  demoInfo,
  demoListDir,
  demoLog,
  demoPrs,
  demoReadFile,
  demoSearch,
  demoShow,
  demoStatFile,
  demoStatus,
  demoWriteFile,
} from './projects';
import { withScaleDemo } from './scale';
import { withSessionLive } from './sessions';

const SCRIPT = withSessionLive(LIVE_SCRIPT);

const SNAPSHOT_SEQ = 1000;

export class DemoClient implements EngineClient {
  private readonly world: DemoWorld;
  private readonly projects: DemoProjects;
  private readonly now: number;
  private readonly history: Record<string, TranscriptEntry[]> = {};
  private headSeq = SNAPSHOT_SEQ;
  private lastDelivered = 0;
  private state: ConnectionState = { status: 'connecting', generation: 0 };
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(events: ServerEvent[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scriptIndex = 0;
  private created = 0;
  /** Attachments added in this demo session (in memory). */
  private readonly attachments = new Map<string, { ref: AttachmentRef; dataBase64: string | null }>();

  constructor(options: { live?: boolean; now?: number } = {}) {
    const now = options.now ?? Date.now();
    const world = createDemoWorld(now);
    extendDemoWorld(world, now);
    const base = withBoardDemo(withConversationDemo(withLifecycleDemo(world, now), now), now);
    this.world = demoScale() ? withScaleDemo(base, now) : base;
    this.now = now;
    this.projects = createDemoProjects(this.world.runs, now);
    // Transcript history gets seqs below the snapshot seq (it happened before the snapshot was read).
    let seq = 100;
    for (const [attemptId, events] of Object.entries(this.world.transcripts)) {
      const span = events.length;
      const times = this.world.transcriptTimes?.[attemptId];
      this.history[attemptId] = events.map((event, i) => ({
        seq: seq++,
        ts: times?.[i] ?? now - (span - i) * Math.min(40_000, (30 * 60_000) / span),
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
          homeDir: DEMO_HOME,
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
      case 'skills.list':
        return [
          { name: 'tdd', description: 'Test-driven development, red-green-refactor.', scope: 'user' },
          { name: 'code-review', description: 'Review the current diff for bugs.', scope: 'user' },
          { name: 'release-notes', description: 'Draft release notes from merged PRs.', scope: 'project' },
        ];
      case 'mcpServers.discover':
        return [
          {
            name: 'linear',
            server: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {} },
            source: '~/.claude.json',
          },
          {
            name: 'docs',
            server: { type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'], env: {} },
            source: '.mcp.json',
          },
        ];
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
        const force = input.force === true;
        const active = !['done', 'failed', 'cancelled'].includes(run.status);
        if (active && !force)
          throw new RpcError('failed_precondition', `run is ${run.status}; archive it once it is finished`);
        // Like the engine: work found nowhere else is kept (unless forced); the integration branch stays
        // while its pull request isn't merged.
        const kept: { kind: 'branch' | 'worktree'; name: string; reason: string }[] = [];
        if (!force)
          for (const task of w.tasks.filter((t) => t.runId === run.id && t.branch)) {
            if (['failed', 'awaiting_human'].includes(task.status))
              kept.push({
                kind: 'branch',
                name: task.branch as string,
                reason: 'has commits in neither integration nor base',
              });
          }
        const pr = (run as { pr?: { state?: string } }).pr;
        if (run.integrationBranch && pr?.state !== 'merged')
          kept.push({ kind: 'branch', name: run.integrationBranch, reason: 'its pull request is not merged' });
        extra(run, { archived: true });
        const row = this.updateRun(run.id, active ? { status: 'cancelled' } : {});
        return { ...row, archiveReport: { kept, problems: [] } };
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
      case 'runs.cancel':
        return this.updateRun(input.runId as string, { status: 'cancelled', paused: false });
      case 'runs.approvePlan':
        return this.approvePlan(input.runId as string);
      case 'projects.list':
        return structuredClone(
          [...this.projects.list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.addedAt - b.addedAt),
        );
      case 'projects.add':
        return this.addProject(input.path as string);
      case 'projects.touch':
      case 'projects.pin': {
        const project = this.project(input.projectId as string);
        if (method === 'projects.pin') project.pinned = input.pinned === true;
        else project.lastOpenedAt = Date.now();
        this.emit([{ type: 'project.updated', project: structuredClone(project), removed: false }]);
        return structuredClone(project);
      }
      case 'projects.remove': {
        const project = this.project(input.projectId as string);
        this.projects.list.splice(this.projects.list.indexOf(project), 1);
        this.projects.byId.delete(project.id);
        this.emit([{ type: 'project.updated', project: structuredClone(project), removed: true }]);
        return { ok: true };
      }
      case 'projects.status':
        return (input.projectId ? [this.project(input.projectId as string)] : this.projects.list).map(demoStatus);
      case 'projects.info':
        return demoInfo(this.project(input.projectId as string), this.now);
      case 'projects.checkouts':
        return this.demoCheckouts(input.projectId as string);
      case 'files.list':
        return demoListDir(this.project(input.projectId as string), input.dir as string);
      case 'files.read':
        return demoReadFile(this.project(input.projectId as string), input.path as string);
      case 'files.stat':
        return demoStatFile(this.project(input.projectId as string), input.path as string);
      case 'files.write':
        return demoWriteFile(
          this.project(input.projectId as string),
          input.path as string,
          input.text as string,
          input.expectedVersion as string,
        );
      case 'files.find':
        return demoFind(this.project(input.projectId as string), input.query as string, input.limit as number);
      case 'files.search':
        return demoSearch(
          this.project(input.projectId as string),
          input.query as string,
          input.regex === true,
          input.caseSensitive === true,
          input.limit as number,
        );
      case 'git.log':
        return demoLog(this.project(input.projectId as string), this.now, input.limit as number);
      case 'git.show':
        return demoShow(this.project(input.projectId as string), this.now, input.sha as string);
      case 'prs.list':
        return demoPrs(this.project(input.projectId as string), this.now);
      case 'diff.get': {
        const target = input.target as { kind: string; projectId?: string; sha?: string };
        if (target.kind === 'commit')
          return demoShow(this.project(target.projectId as string), this.now, target.sha as string);
        const handled = handlePlanReviewRpc(this.extraContext, method, input);
        if (isHandled(handled)) return handled;
        throw new RpcError('not_implemented', `${method} is not available in demo mode`);
      }
      case 'repos.recent':
        return [
          { path: '/Users/dev/src/erudiet/app', name: 'app', lastUsedAt: Date.now() - 60_000 },
          { path: '/Users/dev/src/erudiet/web', name: 'web', lastUsedAt: Date.now() - 3_600_000 },
          { path: '/Users/dev/src/erudiet/api', name: 'api', lastUsedAt: Date.now() - 86_400_000 },
        ];
      case 'repos.inspect':
        return inspectDemoRepo(input.path as string);
      case 'repos.initialCommit':
        demoCommitted.add(input.path as string);
        return inspectDemoRepo(input.path as string);
      case 'repos.discover':
        return discoverDemoRepos();
      case 'repos.branches':
        return demoBranches(input.path as string);
      case 'runs.create':
        return this.createRun(input as unknown as RpcInput<'runs.create'>);
      case 'runs.chat': {
        // Demo mode has no assistant: the prompt goes straight to the scripted planner.
        const chat = input as unknown as RpcInput<'runs.chat'>;
        return this.createRun({
          repoPath: chat.repoPath,
          baseRef: chat.baseRef,
          title: null,
          issueText: chat.prompt,
          issueUrl: null,
          plannerEngine: chat.engine,
          plannerModel: chat.model,
          skipClarify: false,
          attachmentIds: chat.attachmentIds,
        });
      }
      case 'runs.answerClarify':
        return this.answerClarify(
          input.runId as string,
          input.answers as QuestionAnswer[],
          this.attachmentRefs(input.attachmentIds),
        );
      case 'tasks.revertHunk':
        // Demo worktrees are not on disk: the revert is acknowledged, the diff stays as it is.
        return { committed: false };
      case 'sessions.send':
        return this.steer(
          input.attemptId as string,
          input.text as string,
          input.priority as 'now' | 'next',
          this.attachmentRefs(input.attachmentIds),
        );
      case 'attachments.add':
        return this.addAttachment(input as unknown as RpcInput<'attachments.add'>);
      case 'attachments.get':
        return this.getAttachment(input.id as string);
      case 'sessions.interrupt':
        return this.interruptSession(input.attemptId as string);
      case 'sessions.takeover':
        throw new RpcError('not_implemented', 'Takeover needs the real engine; demo mode has no agent processes.');
      case 'tasks.retry':
      case 'tasks.restart':
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

  /** Demo checkouts: the task worktrees of the project's runs (and their integration branches). */
  private demoCheckouts(projectId: string) {
    const project = this.project(projectId);
    const w = this.world;
    const runs = w.runs.filter((r) => r.projectId === projectId || r.repoPath === project.path);
    return runs.flatMap((run) => [
      ...w.tasks
        .filter((t) => t.runId === run.id && t.worktreePath)
        .map((t) => ({
          path: t.worktreePath as string,
          branch: t.branch,
          kind: 'task' as const,
          runId: run.id,
          taskId: t.id,
        })),
      ...(run.integrationBranch
        ? [
            {
              path: `/Users/dev/Library/Application Support/Legion/worktrees/${run.id}/integration`,
              branch: run.integrationBranch,
              kind: 'integration' as const,
              runId: run.id,
              taskId: null,
            },
          ]
        : []),
    ]);
  }

  private project(projectId: string): Project {
    const project = this.projects.byId.get(projectId);
    if (!project) throw new RpcError('not_found', `project ${projectId} not found`);
    return project;
  }

  private addProject(path: string): Project {
    const inspection = inspectDemoRepo(path);
    if (!inspection.isGitRepo || !inspection.root) throw new RpcError('bad_request', 'not a git repository');
    const root = inspection.root;
    const existing = this.projects.list.find((p) => p.path === root);
    const project: Project = existing ?? {
      id: `prj_demoadd${String(this.projects.list.length).padStart(5, '0')}`,
      path: root,
      name: root.split('/').filter(Boolean).at(-1) ?? root,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
      pinned: false,
    };
    if (!existing) {
      this.projects.list.push(project);
      this.projects.byId.set(project.id, project);
    } else project.lastOpenedAt = Date.now();
    this.emit([{ type: 'project.updated', project: structuredClone(project), removed: false }]);
    return structuredClone(project);
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
        if (action === 'retry' || action === 'edit' || action === 'restart')
          this.updateTask(taskId, { status: 'queued', error: null });
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

  /**
   * Demo `attachments.add`: the same validation as the engine (sniffed bytes, size limits), kept in memory.
   * A picked path has no bytes here: it is accepted by its extension, without a preview.
   */
  private addAttachment(input: RpcInput<'attachments.add'>): AttachmentRef {
    const name = cleanName(input.name);
    let ref: Omit<AttachmentRef, 'id'>;
    let dataBase64: string | null = null;
    if (input.dataBase64) {
      const binary = atob(input.dataBase64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const sniffed = sniffAttachment(bytes, name);
      if (!sniffed.ok) throw new RpcError('bad_request', sniffed.reason);
      const tooBig = sizeProblem(name, sniffed.kind, bytes.length);
      if (tooBig) throw new RpcError('bad_request', tooBig);
      ref = {
        name,
        mime: sniffed.mime,
        kind: sniffed.kind,
        size: bytes.length,
        sha256: `demo${this.attachments.size}`,
      };
      dataBase64 = sniffed.kind === 'file' ? null : input.dataBase64;
    } else {
      const ext = extensionOf(name);
      const image = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
      ref = {
        name,
        mime: image ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : ext === 'pdf' ? 'application/pdf' : 'text/plain',
        kind: image ? 'image' : ext === 'pdf' ? 'file' : 'text',
        size: 48_213,
        sha256: `demo${this.attachments.size}`,
      };
    }
    const full: AttachmentRef = { id: `file_demo${String(this.attachments.size + 1).padStart(8, '0')}`, ...ref };
    this.attachments.set(full.id, { ref: full, dataBase64 });
    return structuredClone(full);
  }

  private getAttachment(id: string): RpcOutput<'attachments.get'> {
    const demo = DEMO_FILES[id];
    if (demo) {
      if ('text' in demo) return { attachment: demo.ref, dataBase64: null, text: demo.text, truncated: false };
      return { attachment: demo.ref, dataBase64: drawDemoShot(demo.draw), text: null, truncated: false };
    }
    const stored = this.attachments.get(id);
    if (!stored) throw new RpcError('not_found', `attachment ${id} not found`);
    const { ref, dataBase64 } = stored;
    if (ref.kind === 'text') {
      const text = dataBase64
        ? new TextDecoder().decode(Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0)))
        : '(demo mode: picked files are not read)';
      return { attachment: ref, dataBase64: null, text, truncated: false };
    }
    return { attachment: ref, dataBase64: ref.kind === 'image' ? dataBase64 : null, text: null, truncated: false };
  }

  private attachmentRefs(ids: unknown): AttachmentRef[] {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => {
      const stored = this.attachments.get(String(id));
      if (!stored) throw new RpcError('not_found', `attachment ${String(id)} not found`);
      return structuredClone(stored.ref);
    });
  }

  private steer(
    attemptId: string,
    text: string,
    priority: 'now' | 'next',
    attachments: AttachmentRef[] = [],
  ): { ok: true } {
    const attempt = this.world.attempts.find((a) => a.id === attemptId);
    if (attempt?.status !== 'running') throw new RpcError('conflict', 'session is not running');
    // Like the engine: the human's message is in the transcript before the agent answers it.
    this.emit([this.attemptEvent(attempt, { type: 'user_message', text, attachments, priority })]);
    if (attempt.role === 'assistant') {
      setTimeout(() => {
        this.emit([
          this.attemptEvent(attempt, {
            type: 'message',
            text: `Noted. I've passed that to the lead: “${text.replace(/[.!?]+$/, '')}”${attachments.length ? ', with your files' : ''}.`,
          }),
          this.attemptEvent(attempt, { type: 'turn_complete', structuredOutput: null, isError: false, reason: null }),
        ]);
      }, 1400);
      return { ok: true };
    }
    setTimeout(() => {
      const files = attachments.length
        ? ` I have ${attachments.map((a) => `\`${a.name}\``).join(', ')} open as well.`
        : '';
      const reply =
        (priority === 'now' ? `Stopping here to follow your note: "${text}".` : `Noted for the next step: "${text}".`) +
        files;
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
      attachments: this.attachmentRefs(input.attachmentIds),
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const project = this.projects.list.find((p) => p.path === input.repoPath) ?? this.addProject(input.repoPath);
    run.projectId = project.id;
    this.world.runs.push(run);
    this.emit([{ type: 'run.updated', run: structuredClone(run), from: null }]);
    return structuredClone(run);
  }

  private answerClarify(runId: string, answers: QuestionAnswer[], attachments: AttachmentRef[] = []): Run {
    const item = this.world.inbox.find(
      (i) => i.runId === runId && i.kind === 'question' && i.payload.source === 'clarify' && i.resolvedAt === null,
    );
    if (!item) throw new RpcError('conflict', 'no open clarify questions');
    Object.assign(item, {
      resolvedAt: Date.now(),
      resolution: { answers, ...(attachments.length ? { attachments } : {}) },
    });
    const bodies: ServerEventBody[] = [{ type: 'inbox.updated', item: structuredClone(item) }];
    const planner = this.world.attempts.find(
      (a) => a.runId === runId && a.role === 'planner' && a.status === 'running',
    );
    if (planner)
      bodies.push(
        this.attemptEvent(planner, {
          type: 'message',
          text: `Thanks. Drafting the plan with ${answers.filter((a) => a.answer.trim()).length} answers${
            attachments.length
              ? ` and ${attachments.length} attachment${attachments.length === 1 ? '' : 's'} (${attachments.map((a) => a.name).join(', ')})`
              : ''
          }.`,
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

const DEMO_HOME = '/Users/dev';

/** What a scan of ~/Projects, ~/src, ... finds on the demo Mac (the recent repos are in it too). */
function discoverDemoRepos(): DiscoveredRepo[] {
  const now = Date.now();
  const repo = (path: string, branch: string | null, dirty: boolean, ageMin: number): DiscoveredRepo => ({
    path,
    name: path.split('/').at(-1) ?? path,
    branch,
    dirty,
    lastCommitAt: now - ageMin * 60_000,
  });
  return [
    repo('/Users/dev/src/erudiet/app', 'main', true, 12),
    repo('/Users/dev/Projects/legion', 'build/v1', false, 40),
    repo('/Users/dev/src/erudiet/web', 'feat/checkout', false, 95),
    repo('/Users/dev/Projects/design-tokens', 'main', false, 60 * 20),
    repo('/Users/dev/src/erudiet/api', 'main', false, 60 * 26),
    repo('/Users/dev/Developer/playground/rust-raytracer', 'main', true, 60 * 24 * 9),
    repo('/Users/dev/code/dotfiles', 'master', false, 60 * 24 * 40),
  ];
}

function demoBranches(path: string): RepoBranches {
  if (path.includes('not-a-repo')) return { current: null, default: null, local: [], remote: [] };
  return {
    current: 'main',
    default: 'main',
    local: ['main', 'feat/passkeys', 'fix/session-timeout'],
    remote: ['origin/main', 'origin/release/2026.10', 'origin/feat/passkeys'],
  };
}

/** Demo repos given their first commit (`repos.initialCommit`). */
const demoCommitted = new Set<string>();

/**
 * A plausible `repos.inspect` answer; paths containing "not-a-repo" are rejected, ones containing
 * "no-commits" have no commit until `repos.initialCommit`, and ones containing "no-remote" have no remote.
 */
function inspectDemoRepo(path: string): RepoInspection {
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  const ok = !path.includes('not-a-repo');
  const committed = ok && (!path.includes('no-commits') || demoCommitted.has(path));
  const remote = ok && !path.includes('no-remote');
  return {
    path,
    exists: true,
    isGitRepo: ok,
    root: ok ? path : null,
    currentBranch: ok ? 'main' : null,
    headSha: committed ? 'a1f3c9e4b2d8' : null,
    defaultBranch: ok ? 'main' : null,
    remotes: remote ? [{ name: 'origin', url: `https://github.com/erudiet/${name}.git` }] : [],
    github: remote ? { owner: 'erudiet', name } : null,
    dirty: false,
    hasGh: true,
    ghAuthenticated: true,
    legionConfig: null,
    error: ok ? null : 'not a git repository',
  };
}
