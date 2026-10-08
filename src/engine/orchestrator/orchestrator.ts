/**
 * The run lifecycle service (architecture §8): shared state and plumbing. The flows live next to it —
 * `planner.ts` (clarify / plan / approval), `tasks.ts` (per-task driver: provision → code → verify →
 * review → fix), `merge.ts` (serialized merge queue), `finalize.ts` (integration verify, final review,
 * PR), `recovery.ts` (§9), `actions.ts` (human actions behind the RPC procedures).
 *
 * Every decision comes from `core/` (pure); this layer applies them with CAS transitions through the
 * Store, runs git through `engine/git`, and drives agents through `AgentRun`s.
 */
import { homedir } from 'node:os';
import type { AttachmentRef } from '@shared/attachments';
import type {
  AgentMessage,
  Attempt,
  Effort,
  EngineKind,
  InboxItem,
  InboxKind,
  InboxResolution,
  Role,
  Run,
  Settings,
  Task,
  TaskNode,
  TaskStatus,
} from '@shared/domain';
import { isTerminal, RUN_TRANSITIONS, TASK_TRANSITIONS } from '@shared/domain';
import {
  type AgentEngine,
  type Approvals,
  COORDINATOR_ROLES,
  type JsonSchema,
  permissionProfileFor,
  type SessionAttachment,
  type SessionOptions,
} from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import type { EngineToMainMessage } from '@shared/host-protocol';
import type { z } from 'zod';
import { resolveAccess } from '../access';
import { AttachmentService } from '../attachments';
import type { EngineContext, Logger } from '../context';
import type { NewMessage, Store } from '../db';
import { integrationWorktreePath, type LegionConfig, loadLegionConfig, repoHash, taskWorktreePath } from '../git';
import {
  type AgentPeer,
  type AmendmentResult,
  type ApproveResult,
  type AssistantRunStatus,
  CLAUDE_TOOL_NAMES,
  type McpBinding,
  type McpHost,
  type McpServerHandle,
  type PlanStatus,
  type PresentRequest,
  type SpawnResearchRequest,
  type StartImplementationRequest,
  type TaskNodePatch,
} from '../mcp';
import type { TerminalService } from '../pty';
import { deferred } from '../util/async-queue';
import {
  type AgentPrompt,
  canMessage,
  coderEngine,
  DEFAULT_TOOL_NAMES,
  type EnabledEngines,
  enabledEngines,
  type Failure,
  fallbackReviewModel,
  type IssueInput,
  LIVE_MESSAGE_NOTE,
  type Limits,
  messageLine,
  messageRefusal,
  PLANNER_STEER_NOTE,
  peerLabel,
  planDispatch,
  planDocument,
  type RateLimit,
  type RepoInput,
  type ResumeStep,
  renderMessages,
  resolveGates,
  SLOT_STATUSES,
  type TaskDecision,
  type ToolNames,
} from './core';
import { AgentRun, type AgentRunHooks, type TurnResult } from './live-session';
import { freshAttemptMeta, patchTaskMeta, runMeta } from './meta';
import type { PrHost } from './pr-host';
import { present } from './present';
import type { EngineRegistry } from './registry';

/** `usedPct` at or above which a `rate_limit` event pauses new sessions on that engine until the reset. */
export const RATE_LIMIT_PAUSE_PCT = 95;
/** Pause after a retryable 429 without a known reset time. */
export const RATE_LIMIT_BACKOFF_MS = 60_000;
/** Roles whose working directory holds content other agents wrote (§6 trust boundary). */
const UNTRUSTED_WORKDIR_ROLES: ReadonlySet<Role> = new Set<Role>([
  'reviewer',
  'finalizer',
  'researcher',
  'research_lead',
]);
/** Claude Code's MCP tool-call timeout (ms): `request_human_input` may wait for hours. */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface OrchestratorOptions {
  ctx: EngineContext;
  registry: EngineRegistry;
  prHost: PrHost;
  /** Engine → main messages (notify, badge, power). */
  host?: (message: EngineToMainMessage) => void;
  /** Interval of the open-PR status poll (default 3 min; 0 = off). */
  prPollMs?: number;
  /** Attachment storage (default: `<dataDir>/attachments`). */
  attachments?: AttachmentService;
}

/** An agent session could not do its job; `failure.kind` feeds the retry policy. */
export class AgentFailure extends Error {
  override readonly name = 'AgentFailure';
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

/** The orchestrator was closed (engine shutdown) while a flow was running: stop silently. */
export class Closed extends Error {
  override readonly name = 'Closed';
}

export type ParkReason = { kind: 'paused' } | { kind: 'rate'; engine: EngineKind };

export interface OpenSessionParams {
  run: Run;
  taskId: string | null;
  role: Role;
  /** Nominal engine (the registry maps it to an instance; may be a fake). */
  engine: EngineKind;
  model: string | null;
  effort: Effort | null;
  prompt: AgentPrompt;
  outputSchema: JsonSchema | null;
  cwd: string;
  allowedCommands?: readonly string[];
  /** Resume this engine-native session instead of starting a new one. */
  resumeSessionId?: string | null;
  /** Re-use this `interrupted` attempt row (recovery) instead of inserting a new one. */
  reuseAttemptId?: string | null;
  /** Files sent with the prompt (`runAttachments` for a session's first message). */
  attachments?: readonly SessionAttachment[] | null;
  /**
   * The attempt this session reports to (`core/messaging.ts`). Absent: inherited from the attempt whose engine
   * session is resumed, else top level.
   */
  parentAttemptId?: string | null;
  /** The prompt is (or starts with) this message of the human's: recorded in the transcript as theirs. */
  humanMessage?: { text: string; attachments: readonly AttachmentRef[] } | null;
}

type Waiter = {
  attemptId: string | null;
  resolve: (resolution: InboxResolution) => void;
  reject: (error: Error) => void;
};

/** The lead loop's wake signal: `wake` is replaced after each wake, so a loop awaits the one it captured. */
export interface LeadLoopHandle {
  wake: ReturnType<typeof deferred<void>>;
}

/** A blocked `wait_for_reply` / `ask_lead` of one attempt. */
type MessageWaiter = {
  replyTo: string | null;
  resolve: (message: AgentMessage) => void;
  reject: (error: Error) => void;
};

const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|usage limit|quota exceeded/i;
const AUTH_RE = /not logged in|unauthori[sz]ed|\b401\b|authenticat|login required|\blog ?in\b/i;

export function classifyFailure(message: string): Failure {
  if (RATE_LIMIT_RE.test(message)) return { kind: 'rate_limited', message };
  if (AUTH_RE.test(message)) return { kind: 'auth', message };
  return { kind: 'agent_error', message };
}

/** A resolution for an item nobody will answer any more (run cancelled, session gone). */
export function dismissal(kind: InboxKind, note: string): InboxResolution {
  switch (kind) {
    case 'approval':
      return { kind, decision: { behavior: 'deny', message: note, interrupt: false } };
    case 'question':
      return { kind, answers: [] };
    case 'plan_signoff':
      return { kind, approved: false, feedback: note };
    case 'escalation':
      return { kind, action: 'abort', note };
    case 'pr_ready':
      return { kind, approved: false, title: null, body: null };
    case 'conflict':
      return { kind, action: 'abort', note };
    case 'budget':
      return { kind, action: 'stop', newLimitUsd: null };
  }
}

/** Legion MCP tool names as Claude Code exposes them (prompts name them exactly). */
export const CLAUDE_PROMPT_TOOLS: ToolNames = {
  markTaskDone: CLAUDE_TOOL_NAMES.markTaskDone,
  requestHumanInput: CLAUDE_TOOL_NAMES.requestHumanInput,
  reportProgress: CLAUDE_TOOL_NAMES.reportProgress,
  askLead: CLAUDE_TOOL_NAMES.askLead,
  listAgents: CLAUDE_TOOL_NAMES.listAgents,
  sendMessage: CLAUDE_TOOL_NAMES.sendMessage,
  planStatus: CLAUDE_TOOL_NAMES.planStatus,
  readPlan: CLAUDE_TOOL_NAMES.readPlan,
  addTask: CLAUDE_TOOL_NAMES.addTask,
  amendTask: CLAUDE_TOOL_NAMES.amendTask,
  cancelTask: CLAUDE_TOOL_NAMES.cancelTask,
  spawnResearch: CLAUDE_TOOL_NAMES.spawnResearch,
  waitForReply: CLAUDE_TOOL_NAMES.waitForReply,
  startImplementation: CLAUDE_TOOL_NAMES.startImplementation,
  runStatus: CLAUDE_TOOL_NAMES.runStatus,
  present: CLAUDE_TOOL_NAMES.present,
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

export class Orchestrator {
  readonly store: Store;
  readonly log: Logger;
  readonly ctx: EngineContext;
  readonly registry: EngineRegistry;
  readonly prHost: PrHost;
  readonly attachments: AttachmentService;
  mcp: McpServerHandle | null = null;
  terminals: TerminalService | null = null;
  /** Resolves with the exit code of a PTY process by pid (set by the engine wiring). */
  ptyExit: ((pid: number) => Promise<number | null> | null) | null = null;

  /** Live agent processes by attempt id. */
  readonly live = new Map<string, AgentRun>();
  /** Tasks with a running driver. */
  readonly drivers = new Set<string>();
  /** Slot-holding tasks whose driver stopped until the run resumes / a rate limit resets. */
  readonly parked = new Map<string, ParkReason>();
  readonly mergeLoops = new Set<string>();
  /** Runs whose merge queue stopped until the run resumes / a rate limit resets (a resolver must wait). */
  readonly mergeParked = new Map<string, ParkReason>();
  /** Runs with a planner or finalize job in flight. */
  readonly runJobs = new Set<string>();
  /** Takeover terminals by attempt id. */
  readonly takeovers = new Map<string, string>();
  /** Implementation lead loops by run id (`lead.ts`). */
  readonly leadLoops = new Map<string, LeadLoopHandle>();
  /** Assistant loops by run id (`assistant.ts`). */
  readonly assistantLoops = new Map<string, LeadLoopHandle>();
  closed = false;
  /** Stopped on close (timers set up by the wiring, e.g. PR polling). */
  readonly disposers: (() => void)[] = [];

  private readonly tokens = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter>();
  /** Blocked message waits by recipient attempt id. */
  private readonly messageWaiters = new Map<string, MessageWaiter[]>();
  private readonly usageBaselines = new WeakMap<
    AgentRun,
    { cost: number; input: number; output: number; decided: boolean }
  >();
  private rateLimits: RateLimit[] = [];
  private readonly jobs = new Set<Promise<unknown>>();
  private tickPending = false;
  private tickChain: Promise<void> = Promise.resolve();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt: number | null = null;
  private poweredOn = false;
  private readonly host: (message: EngineToMainMessage) => void;
  private readonly offEvents: () => void;

  constructor(options: OrchestratorOptions) {
    this.ctx = options.ctx;
    this.store = options.ctx.store;
    this.log = options.ctx.log;
    this.registry = options.registry;
    this.prHost = options.prHost;
    this.attachments =
      options.attachments ??
      new AttachmentService({ dataDir: options.ctx.dataDir, store: options.ctx.store, log: options.ctx.log });
    this.host = options.host ?? (() => {});
    this.offEvents = this.store.onEvents((events) => {
      let inboxChanged = false;
      for (const event of events) {
        if (event.type === 'settings.updated') this.applyApprovals(event.settings.permissions.approvals);
        // The assistant hears about status changes and new inbox items (§8.6).
        if (event.type === 'run.updated' && event.from !== null) this.wakeAssistant(event.run.id);
        if (event.type !== 'inbox.updated') continue;
        inboxChanged = true;
        this.wakeAssistant(event.item.runId);
        if (event.item.resolvedAt === null) this.notifyItem(event.item);
      }
      if (inboxChanged) this.host({ type: 'badge', count: this.openInboxCount() });
    });
  }

  // -- small accessors ---------------------------------------------------------------------------

  now(): number {
    return Date.now();
  }

  settings(): Settings {
    return this.store.getSettings();
  }

  limits(): Limits {
    return this.settings().limits;
  }

  openInboxCount(): number {
    return this.store.listInbox({ runId: null, includeResolved: false }).length;
  }

  async config(run: Pick<Run, 'repoPath'>): Promise<LegionConfig | null> {
    try {
      return await loadLegionConfig(run.repoPath);
    } catch (error) {
      this.log.warn(`legion.json in ${run.repoPath}: ${(error as Error).message}`);
      return null;
    }
  }

  repoInput(run: Run, config: LegionConfig | null): RepoInput {
    return {
      baseRef: run.baseRef,
      // The repo-level gate commands. Synchronous, so without detected gates (detection reads the worktree).
      verifyCommands: resolveGates({ config, detected: [], taskCommands: [] }).map((g) => g.command),
      setupCommands: config?.setup ?? [],
      installCommand: config?.installCommand ?? null,
    };
  }

  issue(run: Run): IssueInput {
    const attachments = this.attachmentRefs(run).map(({ name, kind, mime }) => ({ name, kind, mime }));
    return { title: run.title, text: run.issueText, url: run.issueUrl, ...(attachments.length ? { attachments } : {}) };
  }

  /** Files attached to the run: at creation, then to the clarify answers. */
  attachmentRefs(run: Run): AttachmentRef[] {
    const all = [...(run.attachments ?? []), ...runMeta(this.store, run.id).answerAttachments];
    return all.filter((ref, i) => all.findIndex((other) => other.id === ref.id) === i);
  }

  /** The run's attachments as sent with a session's first message (planner, coders, reviewers). */
  runAttachments(run: Run): SessionAttachment[] {
    return this.attachments.forSession(this.attachmentRefs(run));
  }

  integrationPath(run: Pick<Run, 'id' | 'repoPath'>): string {
    return integrationWorktreePath(this.ctx.dataDir, repoHash(run.repoPath), run.id);
  }

  taskPath(run: Pick<Run, 'id' | 'repoPath'>, taskId: string): string {
    return taskWorktreePath(this.ctx.dataDir, repoHash(run.repoPath), run.id, taskId);
  }

  /** Nodes of the approved plan (latest approved version). */
  approvedNodes(runId: string): TaskNode[] {
    const plan = this.store
      .listPlans(runId)
      .filter((p) => p.approvedAt !== null)
      .at(-1);
    return plan ? plan.dag.nodes : [];
  }

  approvedPlan(runId: string) {
    return (
      this.store
        .listPlans(runId)
        .filter((p) => p.approvedAt !== null)
        .at(-1) ?? null
    );
  }

  nodeOf(task: Pick<Task, 'runId' | 'nodeId'>): TaskNode {
    const node = this.approvedNodes(task.runId).find((n) => n.id === task.nodeId);
    if (!node) throw new Error(`no approved plan node ${task.nodeId} for run ${task.runId}`);
    return node;
  }

  toolNames(engine: EngineKind): ToolNames {
    return this.registry.get(engine).kind === 'claude' ? CLAUDE_PROMPT_TOOLS : DEFAULT_TOOL_NAMES;
  }

  /** The engine every coder runs on: the coder role in settings. */
  coderEngine(): EngineKind {
    return coderEngine(this.settings());
  }

  modelFor(role: keyof Settings['roles'], engine: EngineKind): string | null {
    if (engine === 'fake') return null;
    return this.settings().roles[role].models[engine];
  }

  /** Engines a new session can use right now: enabled in settings and usable per the last probe. */
  availableEngines(): EnabledEngines {
    const enabled = enabledEngines(this.settings());
    return {
      claude: enabled.claude && this.registry.usable('claude').ok,
      codex: enabled.codex && this.registry.usable('codex').ok,
    };
  }

  /**
   * Model of a reviewer/finalizer on `engine` judging work coded on `coderEngine` with `coderModel`: the
   * role's configured model, or — same engine (the other one is unavailable) — a different model.
   */
  reviewModel(
    role: 'reviewer' | 'finalizer',
    engine: EngineKind,
    coderEngine: EngineKind,
    coderModel: string | null,
  ): string | null {
    if (engine === 'fake') return null;
    if (engine !== coderEngine) return this.modelFor(role, engine);
    const model = fallbackReviewModel(
      engine,
      coderModel ?? this.modelFor('coder', engine),
      this.settings().engines[engine].fallbackReviewModel,
      this.registry.info(engine)?.models ?? [],
    );
    if (model === null) this.log.warn(`no second ${engine} model known for a same-engine ${role}; using the default`);
    return model;
  }

  /** Track a background job (awaited on close); errors are logged unless the orchestrator is closing. */
  background(name: string, job: () => Promise<unknown>): void {
    if (this.closed) return;
    const promise = job()
      .catch((error: unknown) => {
        if (this.closed || error instanceof Closed) return;
        this.log.error(`${name} failed`, error);
      })
      .finally(() => this.jobs.delete(promise));
    this.jobs.add(promise);
  }

  assertOpen(): void {
    if (this.closed) throw new Closed('orchestrator closed');
  }

  // -- rate limits & gates -----------------------------------------------------------------------

  /** Pause new sessions on `engine` until `resetsAt` (unknown: a backoff, unless a known limit is active). */
  registerRateLimit(engine: EngineKind, resetsAt: number | null): void {
    if (resetsAt === null && this.limitedUntil(engine) !== null) return;
    const until = resetsAt ?? this.now() + RATE_LIMIT_BACKOFF_MS;
    this.rateLimits = [...this.rateLimits.filter((r) => r.engine !== engine), { engine, resetsAt: until }];
    this.log.warn(`rate limited on ${engine} until ${new Date(until).toISOString()}`);
    this.armWake(until);
  }

  activeRateLimits(): RateLimit[] {
    const now = this.now();
    this.rateLimits = this.rateLimits.filter((r) => r.resetsAt === null || r.resetsAt > now);
    return this.rateLimits;
  }

  limitedUntil(engine: EngineKind): number | null {
    const limit = this.activeRateLimits().find((r) => r.engine === engine);
    return limit ? (limit.resetsAt ?? this.now() + RATE_LIMIT_BACKOFF_MS) : null;
  }

  /** Why a new agent session on `engine` must wait, or null. */
  gate(runId: string, engine: EngineKind): ParkReason | null {
    if (this.store.requireRun(runId).paused) return { kind: 'paused' };
    if (this.limitedUntil(engine) !== null) return { kind: 'rate', engine };
    return null;
  }

  /** Wait (for run-level jobs) until `engine` is no longer rate limited. */
  async waitForEngine(engine: EngineKind): Promise<void> {
    for (;;) {
      this.assertOpen();
      const until = this.limitedUntil(engine);
      if (until === null) return;
      await sleep(Math.min(Math.max(until - this.now(), 50), 60_000));
    }
  }

  // -- sessions ----------------------------------------------------------------------------------

  sessionEnv(): Record<string, string> {
    return { ...this.ctx.env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) };
  }

  async openSession(params: OpenSessionParams): Promise<AgentRun> {
    this.assertOpen();
    const usable = this.registry.usable(params.engine);
    if (!usable.ok) throw new AgentFailure({ kind: 'auth', message: usable.reason });
    const engine: AgentEngine = this.registry.get(params.engine);
    const continued = params.resumeSessionId ? this.attemptsOfSession(params.run.id, params.resumeSessionId) : [];
    const parentAttemptId =
      params.parentAttemptId !== undefined ? params.parentAttemptId : (continued.at(-1)?.parentAttemptId ?? null);
    const attempt = params.reuseAttemptId
      ? this.store.transitionAttempt(params.reuseAttemptId, 'interrupted', 'running', { error: null })
      : this.store.insertAttempt({
          runId: params.run.id,
          taskId: params.taskId,
          role: params.role,
          engine: engine.kind,
          model: params.model,
          effort: params.effort,
          status: 'running',
          sessionId: params.resumeSessionId ?? null,
          parentAttemptId,
        });
    if (params.humanMessage) {
      this.store.appendAgentEvent(attempt, {
        type: 'user_message',
        text: params.humanMessage.text,
        attachments: [...params.humanMessage.attachments],
        priority: null,
      });
    }
    const token =
      this.mcp?.issueToken({
        runId: params.run.id,
        taskId: params.taskId,
        attemptId: attempt.id,
        role: params.role,
        parentAttemptId: attempt.parentAttemptId ?? null,
      }) ?? null;
    // Messages that arrived while this engine session was not running reach it with the resumed prompt. The
    // planner's are addressed to whichever planner attempt the sender saw, so it takes all of the run's.
    const inherited = this.drainQueuedMessages(
      params.role === 'planner'
        ? [attempt, ...this.store.listAttempts(params.run.id).filter((a) => a.role === 'planner')]
        : [attempt, ...continued],
    );
    // The project's MCP servers and skills for this role (settings.access); a failure here must not strand the attempt.
    const access = await resolveAccess(
      this.settings(),
      params.run.projectId ?? null,
      params.role,
      this.ctx.env.HOME || homedir(),
    ).catch((error: unknown) => {
      this.log.warn(`could not resolve agent access for ${params.role}: ${(error as Error).message}`);
      return { extraMcp: {}, skills: null };
    });
    const opts: SessionOptions = {
      role: params.role,
      cwd: params.cwd,
      prompt: inherited ? `${inherited}\n\n---\n\n${params.prompt.prompt}` : params.prompt.prompt,
      systemPrompt: params.prompt.systemPrompt,
      model: params.model,
      effort: params.effort,
      permission: permissionProfileFor(
        params.role,
        params.allowedCommands ?? [],
        this.settings().permissions.approvals,
      ),
      // Reviewers, the finalizer and research agents read worktrees that coders wrote: never trust their config.
      untrustedWorkdir: UNTRUSTED_WORKDIR_ROLES.has(params.role),
      outputSchema: params.outputSchema,
      mcp: token && this.mcp ? { url: this.mcp.url, token } : null,
      ...(Object.keys(access.extraMcp).length > 0 ? { extraMcp: access.extraMcp } : {}),
      ...(access.skills ? { skills: access.skills } : {}),
      env: this.sessionEnv(),
      attachments: params.attachments?.length ? params.attachments : null,
    };
    let session: Awaited<ReturnType<AgentEngine['start']>>;
    try {
      session = params.resumeSessionId ? await engine.resume(params.resumeSessionId, opts) : await engine.start(opts);
    } catch (error) {
      if (token) this.mcp?.revokeToken(token);
      const message = `could not start ${params.engine} ${params.role} session: ${(error as Error).message}`;
      if (!this.closed) this.store.transitionAttempt(attempt.id, 'running', 'failed', { error: message });
      throw new AgentFailure(classifyFailure(message));
    }
    const hooks: AgentRunHooks = {
      onEvent: (run, event) => this.onAgentEvent(run, event),
      onEnd: (run) => this.onAgentEnd(run),
      onTakeover: (run, taken) => this.onTakeover(run, taken),
      canHandBack: (run) => this.canHandBack(run),
    };
    const run = new AgentRun(
      { id: attempt.id, runId: attempt.runId, taskId: attempt.taskId, role: attempt.role },
      params.engine,
      engine,
      session,
      opts,
      hooks,
    );
    if (token) this.tokens.set(attempt.id, token);
    this.live.set(attempt.id, run);
    this.updatePower();
    if (session.id && session.id !== attempt.sessionId) this.store.updateAttempt(attempt.id, { sessionId: session.id });
    run.start();
    return run;
  }

  /** Attempts of `runId` that ran (or run) the engine session `sessionId`, oldest first. */
  private attemptsOfSession(runId: string, sessionId: string): Attempt[] {
    return this.store.listAttempts(runId).filter((a) => a.sessionId === sessionId);
  }

  /** Queued messages addressed to any of `attempts`, marked delivered and rendered for a prompt (null = none). */
  private drainQueuedMessages(attempts: readonly Attempt[]): string | null {
    const seen = new Set<string>();
    const queued: AgentMessage[] = [];
    for (const attempt of attempts) {
      if (seen.has(attempt.id)) continue;
      seen.add(attempt.id);
      queued.push(...this.store.queuedMessagesFor(attempt.id));
    }
    if (queued.length === 0) return null;
    queued.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    this.store.markDelivered(queued.map((m) => m.id));
    return renderMessages(queued.map((m) => messageLine(m, this.agentName(m.fromAttemptId))));
  }

  /** How other agents refer to an attempt: `coder of T3 (att_…)`. */
  agentName(attemptId: string): string {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) return attemptId;
    return peerLabel(attempt, this.nodeIdOf(attempt));
  }

  private nodeIdOf(attempt: Attempt): string | null {
    return attempt.taskId ? (this.store.getTask(attempt.taskId)?.nodeId ?? null) : null;
  }

  private peer(attempt: Attempt): AgentPeer {
    return { attemptId: attempt.id, role: attempt.role, nodeId: this.nodeIdOf(attempt), status: attempt.status };
  }

  /** Queue a message and hand it over (a blocked wait, or the lead's next wake). */
  postMessage(input: NewMessage): AgentMessage {
    const message = this.store.insertMessage(input);
    this.deliverMessage(message);
    return message;
  }

  /**
   * Hand `message` over: to a blocked wait of its recipient that it answers; else a lead or assistant is
   * woken (they read their mailbox between turns); else a working agent gets it in its running turn, like a
   * human steer. Otherwise it stays queued for the recipient's next prompt (`openSession`).
   */
  private deliverMessage(message: AgentMessage): void {
    const waiting = this.messageWaiters.get(message.toAttemptId);
    const index = waiting?.findIndex((w) => w.replyTo === null || w.replyTo === message.replyTo) ?? -1;
    if (waiting && index >= 0) {
      const [waiter] = waiting.splice(index, 1);
      if (waiting.length === 0) this.messageWaiters.delete(message.toAttemptId);
      const [delivered] = this.store.markDelivered([message.id]);
      waiter?.resolve(delivered ?? message);
      return;
    }
    const meta = runMeta(this.store, message.runId);
    if (meta.leadAttemptId === message.toAttemptId) this.wakeLead(message.runId);
    else if (meta.assistantAttemptId === message.toAttemptId) this.wakeAssistant(message.runId);
    else {
      const to = this.store.getAttempt(message.toAttemptId);
      if (to && !COORDINATOR_ROLES.has(to.role)) this.steerLive(message, to);
    }
  }

  /**
   * Pass `message` into the recipient's running turn as a queued user message (the engine folds it in, or runs
   * it right after and reports both as one turn). A planner is reached through whichever planner attempt is
   * live, since the sender may know an earlier step's. Idle or gone: it stays queued.
   */
  private steerLive(message: AgentMessage, to: Attempt): void {
    const live =
      to.role === 'planner'
        ? [...this.live.values()].find((r) => r.attempt.runId === message.runId && r.attempt.role === 'planner')
        : this.live.get(to.id);
    if (!live || live.ended || live.takenOver || !live.inTurn) return;
    const note = to.role === 'planner' ? PLANNER_STEER_NOTE : LIVE_MESSAGE_NOTE;
    const text = renderMessages([messageLine(message, this.agentName(message.fromAttemptId))], note) ?? message.body;
    this.store.markDelivered([message.id]);
    live.steer(text, 'next').catch((error: unknown) => {
      this.log.warn(`run ${message.runId}: could not pass a message to ${to.role}: ${(error as Error).message}`);
    });
  }

  private rejectMessageWaiters(attemptId: string, note: string): void {
    const waiting = this.messageWaiters.get(attemptId);
    if (!waiting) return;
    this.messageWaiters.delete(attemptId);
    for (const waiter of waiting) waiter.reject(new Error(note));
  }

  /** Close the process and settle the attempt row. */
  async finishAttempt(run: AgentRun, status: 'succeeded' | 'failed' | 'cancelled', error: string | null = null) {
    await run.close();
    if (this.closed) return;
    const attempt = this.store.getAttempt(run.attempt.id);
    if (attempt && (attempt.status === 'running' || attempt.status === 'interrupted')) {
      this.store.transitionAttempt(attempt.id, attempt.status, status, { error });
    }
  }

  /** Wait for a turn whose structured output parses with `schema`, nudging the agent on schema misses. */
  async structuredTurn<T>(run: AgentRun, schema: z.ZodType<T>, retries = 2): Promise<T> {
    for (let i = 0; ; i++) {
      let turn = await run.nextTurn();
      this.assertOpen();
      if (turn.kind === 'turn' && turn.isError) {
        // A process that dies reports its failed turn first and its exit right after: wait for the exit so the
        // failure carries the real error instead of a nudge sent into a closed session.
        await sleep(50);
        if (run.ended) turn = await run.nextTurn();
      }
      const failure = this.turnFailure(turn);
      if (failure && (failure.kind !== 'agent_error' || turn.kind === 'exited' || turn.reason === 'interrupted')) {
        throw new AgentFailure(failure);
      }
      const parsed = turn.kind === 'turn' && !turn.isError ? schema.safeParse(turn.structuredOutput) : null;
      if (parsed?.success) return parsed.data;
      const why = parsed
        ? parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')
        : (failure?.message ?? 'missing structured output');
      if (i >= retries) throw new AgentFailure({ kind: 'agent_error', message: `invalid structured output: ${why}` });
      await run.send(
        `Your final structured output was missing or did not match the required schema (${why}). Reply again with only the structured output, exactly in the required shape.`,
      );
    }
  }

  /** Failure described by a turn, or null when the turn ended normally. */
  turnFailure(turn: TurnResult): Failure | null {
    if (turn.kind === 'exited') {
      return classifyFailure(turn.error?.message ?? `the agent process exited (code ${turn.code ?? 'null'})`);
    }
    if (!turn.isError) return null;
    return classifyFailure(turn.error?.message ?? turn.reason ?? 'the turn failed');
  }

  private onAgentEvent(run: AgentRun, event: AgentEvent): void {
    if (this.closed) return;
    const ref = run.attempt;
    this.store.appendAgentEvent(ref, event);
    switch (event.type) {
      case 'session_started': {
        const attempt = this.store.getAttempt(ref.id);
        if (attempt && attempt.sessionId !== event.sessionId) {
          this.store.updateAttempt(ref.id, { sessionId: event.sessionId, model: event.model ?? attempt.model });
        }
        if (ref.taskId && ref.role === 'coder')
          patchTaskMeta(this.store, ref.taskId, { coderSessionId: event.sessionId });
        return;
      }
      case 'usage':
        this.applyUsage(run, event);
        return;
      case 'rate_limit':
        if (event.usedPct >= RATE_LIMIT_PAUSE_PCT) this.registerRateLimit(run.nominal, event.resetsAt);
        return;
      case 'error':
        if (event.retryable && RATE_LIMIT_RE.test(event.message)) this.registerRateLimit(run.nominal, null);
        return;
      case 'approval_request':
        this.store.insertInboxItem({
          runId: ref.runId,
          taskId: ref.taskId,
          attemptId: ref.id,
          kind: 'approval',
          payload: { requestId: event.requestId, tool: event.tool, input: event.input ?? null, reason: event.reason },
        });
        return;
      case 'turn_complete':
        // Pending approvals die with the turn (the CLIs drop them).
        this.dismissOpen(ref.runId, (item) => item.attemptId === ref.id && item.kind === 'approval', 'turn ended');
        return;
      default:
        return;
    }
  }

  /** Usage events are cumulative per engine session: attempt cost = latest total − other attempts' share. */
  private applyUsage(run: AgentRun, event: Extract<AgentEvent, { type: 'usage' }>): void {
    let base = this.usageBaselines.get(run);
    if (!base) {
      const others = this.store
        .listAttempts(run.attempt.runId)
        .filter((a) => a.id !== run.attempt.id && a.sessionId !== null && a.sessionId === run.sessionId);
      base = {
        cost: others.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
        input: others.reduce((sum, a) => sum + (a.inputTokens ?? 0), 0),
        output: others.reduce((sum, a) => sum + (a.outputTokens ?? 0), 0),
        decided: false,
      };
      this.usageBaselines.set(run, base);
    }
    if (!base.decided) {
      // An engine whose totals restart with each process reports less than what earlier attempts spent.
      const restarted =
        (event.costUsd !== null && base.cost > 0 && event.costUsd <= base.cost) ||
        (base.input > 0 && event.inputTokens <= base.input);
      if (restarted) {
        base.cost = 0;
        base.input = 0;
        base.output = 0;
      }
      base.decided = true;
    }
    const attempt = this.store.getAttempt(run.attempt.id);
    if (!attempt) return;
    this.store.updateAttempt(attempt.id, {
      costUsd: event.costUsd === null ? attempt.costUsd : Math.max(0, event.costUsd - base.cost),
      inputTokens: Math.max(0, event.inputTokens - base.input),
      outputTokens: Math.max(0, event.outputTokens - base.output),
    });
    this.checkBudget(attempt.runId);
  }

  private onAgentEnd(run: AgentRun): void {
    const token = this.tokens.get(run.attempt.id);
    if (token) this.mcp?.revokeToken(token);
    this.tokens.delete(run.attempt.id);
    this.live.delete(run.attempt.id);
    this.updatePower();
    for (const [itemId, waiter] of this.waiters) {
      if (waiter.attemptId === run.attempt.id) {
        this.waiters.delete(itemId);
        waiter.reject(new Error('the session ended'));
      }
    }
    this.rejectMessageWaiters(run.attempt.id, 'the session ended');
    if (this.closed) return;
    if (run.handBackRefused) {
      const attempt = this.store.getAttempt(run.attempt.id);
      if (attempt?.status === 'interrupted') {
        this.store.transitionAttempt(attempt.id, 'interrupted', 'cancelled', {
          error: 'the run or task ended during the takeover',
        });
      }
    }
    this.dismissOpen(
      run.attempt.runId,
      (item) =>
        item.attemptId === run.attempt.id &&
        (item.kind === 'approval' || (item.kind === 'question' && item.payload.source === 'agent')),
      'the agent session ended',
    );
  }

  /** A taken-over attempt may resume only while it, its run and its task are still live. */
  private canHandBack(run: AgentRun): boolean {
    if (this.closed) return false;
    const attempt = this.store.getAttempt(run.attempt.id);
    if (attempt?.status !== 'interrupted') return false;
    const current = this.store.getRun(run.attempt.runId);
    if (!current || current.archived || isTerminal(RUN_TRANSITIONS, current.status)) return false;
    const task = run.attempt.taskId ? this.store.getTask(run.attempt.taskId) : null;
    return !task || !isTerminal(TASK_TRANSITIONS, task.status);
  }

  private onTakeover(run: AgentRun, taken: boolean): void {
    if (this.closed) return;
    const attempt = this.store.getAttempt(run.attempt.id);
    if (!attempt) return;
    if (taken && attempt.status === 'running') {
      this.store.transitionAttempt(attempt.id, 'running', 'interrupted', { error: 'taken over by a human' });
    } else if (!taken && attempt.status === 'interrupted') {
      this.store.transitionAttempt(attempt.id, 'interrupted', 'running', { error: null });
      if (run.sessionId !== attempt.sessionId) this.store.updateAttempt(attempt.id, { sessionId: run.sessionId });
    }
  }

  // -- inbox -------------------------------------------------------------------------------------

  /** Resolve open items of a run matching `filter` with a dismissal (stale / superseded). */
  dismissOpen(runId: string, filter: (item: InboxItem) => boolean, note: string): void {
    for (const item of this.store.listInbox({ runId, includeResolved: false })) {
      if (!filter(item)) continue;
      try {
        this.store.resolveInboxItem(item.id, dismissal(item.kind, note));
      } catch {
        // resolved concurrently
      }
      const waiter = this.waiters.get(item.id);
      if (waiter) {
        this.waiters.delete(item.id);
        waiter.reject(new Error(note));
      }
    }
  }

  /** Wait for a human's resolution of `itemId` (MCP tool calls). */
  awaitResolution(itemId: string, attemptId: string | null): Promise<InboxResolution> {
    return new Promise((resolve, reject) => this.waiters.set(itemId, { attemptId, resolve, reject }));
  }

  /** Called after an item was resolved; true when an MCP tool call was waiting for it. */
  deliverResolution(itemId: string, resolution: InboxResolution): boolean {
    const waiter = this.waiters.get(itemId);
    if (!waiter) return false;
    this.waiters.delete(itemId);
    waiter.resolve(resolution);
    return true;
  }

  escalate(
    runId: string,
    taskId: string | null,
    reason: Extract<InboxItem, { kind: 'escalation' }>['payload']['reason'],
    summary: string,
    actions: Extract<InboxItem, { kind: 'escalation' }>['payload']['actions'],
    resume: ResumeStep | null = null,
  ): void {
    this.dismissOpen(
      runId,
      (item) => item.kind === 'escalation' && item.taskId === taskId,
      'superseded by a newer escalation',
    );
    this.store.insertInboxItem({
      runId,
      taskId,
      attemptId: null,
      kind: 'escalation',
      payload: { reason, summary, actions, ...(resume ? { resume } : {}) },
    });
  }

  /** `settings.permissions.approvals` changed: switch the live sessions that would ask (coders, resolvers). */
  private applyApprovals(approvals: Approvals): void {
    for (const run of this.live.values()) {
      const permission = run.opts.permission;
      if (run.ended || permission.mode !== 'workspace_write' || permission.approvals === approvals) continue;
      // Resumes (takeover hand-back) reuse the options: keep them in step.
      run.opts.permission = { ...permission, approvals };
      run.session.setApprovals?.(approvals).then(
        (ok) => {
          if (!ok) this.log.warn(`attempt ${run.attempt.id}: the engine kept its approvals (${approvals} refused)`);
        },
        () => undefined,
      );
    }
  }

  private notifyItem(item: InboxItem): void {
    const run = this.store.getRun(item.runId);
    const task = item.taskId ? this.store.getTask(item.taskId) : null;
    const where = [run?.title, task?.nodeId].filter(Boolean).join(' · ');
    const titles: Record<InboxKind, string> = {
      approval: 'Approval needed',
      question: item.kind === 'question' && item.payload.source === 'clarify' ? 'Clarifying questions' : 'Question',
      plan_signoff: 'Plan ready for review',
      escalation: 'Needs your attention',
      pr_ready: 'Ready for a pull request',
      conflict: 'Merge conflict',
      budget: 'Budget reached',
    };
    let detail = '';
    if (item.kind === 'approval') detail = `${item.payload.tool} wants to run`;
    else if (item.kind === 'question') detail = item.payload.questions[0]?.question ?? '';
    else if (item.kind === 'escalation') detail = item.payload.summary;
    else if (item.kind === 'conflict') detail = item.payload.summary;
    else if (item.kind === 'budget') detail = `$${item.payload.spentUsd.toFixed(2)} of $${item.payload.limitUsd}`;
    this.host({
      type: 'notify',
      title: titles[item.kind],
      body: [where, detail].filter(Boolean).join(': ').slice(0, 240),
      runId: item.runId,
    });
  }

  notify(title: string, body: string, runId: string | null): void {
    this.host({ type: 'notify', title, body, runId });
  }

  private updatePower(): void {
    const on = this.live.size > 0;
    if (on === this.poweredOn) return;
    this.poweredOn = on;
    this.host({ type: 'power', preventSleep: on });
  }

  // -- budget ------------------------------------------------------------------------------------

  runCost(runId: string): number {
    return this.store.listAttempts(runId).reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
  }

  checkBudget(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || isTerminal(RUN_TRANSITIONS, run.status)) return;
    const settings = this.settings();
    const meta = runMeta(this.store, runId);
    const limit = meta.budgetLimitUsd ?? settings.budget.perRunUsd;
    if (limit === null) return;
    const spent = this.runCost(runId);
    if (spent >= limit) {
      const open = this.store.listInbox({ runId, includeResolved: false }).some((i) => i.kind === 'budget');
      if (open) return;
      this.store.transaction(() => {
        if (!run.paused) this.store.updateRun(runId, { paused: true });
        this.store.insertInboxItem({
          runId,
          taskId: null,
          attemptId: null,
          kind: 'budget',
          payload: { spentUsd: spent, limitUsd: limit },
        });
      });
    } else if (spent >= (limit * settings.budget.warnAtPct) / 100 && !meta.budgetWarned) {
      this.store.setMeta(`run:${runId}`, { ...meta, budgetWarned: true });
      this.notify('Budget warning', `${run.title}: $${spent.toFixed(2)} of $${limit} spent`, runId);
    }
  }

  // -- task decisions ----------------------------------------------------------------------------

  /**
   * Apply a `core/policy` decision: walk its status path with CAS transitions, apply the counter patch,
   * raise the escalation, reset the attempt state on retry. One transaction.
   */
  applyDecision(
    taskId: string,
    decision: TaskDecision,
    options: { summary?: string; error?: string | null; patch?: Partial<Pick<Task, 'mergedSha'>> } = {},
  ) {
    const result = this.store.transaction(() => {
      let task = this.store.requireTask(taskId);
      const failing = decision.action === 'fail' || decision.action === 'escalate';
      const patch = {
        ...decision.patch,
        ...options.patch,
        error: options.error !== undefined ? options.error : failing ? decision.reason : null,
      };
      if (decision.path.length === 0) {
        task = this.store.updateTask(task.id, patch);
      } else {
        decision.path.forEach((status, i) => {
          task = this.store.transitionTask(task.id, task.status, status, i === decision.path.length - 1 ? patch : {});
        });
      }
      if (decision.escalation) {
        this.escalate(
          task.runId,
          task.id,
          decision.escalation,
          `${task.nodeId}: ${options.summary ?? decision.reason}`,
          task.status === 'failed' ? ['retry', 'skip', 'edit', 'abort'] : ['retry', 'skip', 'abort'],
          task.status === 'awaiting_human' ? (decision.resume ?? null) : null,
        );
      }
      if (task.status === 'awaiting_human') patchTaskMeta(this.store, task.id, { resumeStep: decision.resume ?? null });
      if (decision.action === 'retry' || decision.action === 'requeue') {
        patchTaskMeta(this.store, task.id, freshAttemptMeta(options.summary ?? decision.reason));
        if (task.report) task = this.store.updateTask(task.id, { report: null });
      }
      return task;
    });
    this.scheduleTick();
    return result;
  }

  /** Move a task to `to` via the shortest legal path (no-op when already there). */
  moveTask(taskId: string, path: readonly TaskStatus[], patch: Partial<Task> = {}): Task {
    return this.store.transaction(() => {
      let task = this.store.requireTask(taskId);
      if (path.length === 0) return Object.keys(patch).length > 0 ? this.store.updateTask(task.id, patch) : task;
      path.forEach((status, i) => {
        task = this.store.transitionTask(task.id, task.status, status, i === path.length - 1 ? patch : {});
      });
      return task;
    });
  }

  // -- scheduling --------------------------------------------------------------------------------

  /** Re-plan dispatch for every executing run (coalesced). */
  scheduleTick(): void {
    if (this.closed || this.tickPending) return;
    this.tickPending = true;
    setImmediate(() => {
      this.tickPending = false;
      this.tickChain = this.tickChain
        .then(() => this.tick())
        .catch((error: unknown) => {
          if (!this.closed) this.log.error('tick failed', error);
        });
    });
  }

  private armWake(at: number): void {
    if (this.closed) return;
    if (this.wakeAt !== null && this.wakeAt <= at && this.wakeAt > this.now()) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeAt = null;
        this.scheduleTick();
      },
      Math.max(0, at - this.now()) + 5,
    );
    this.wakeTimer.unref?.();
  }

  /** Flow starters, set by the wiring in `index.ts` (keeps this module free of import cycles). */
  flows: {
    driveTask(taskId: string): Promise<void>;
    mergeQueue(runId: string): Promise<void>;
    finalize(runId: string): Promise<void>;
    lead(runId: string, loop: LeadLoopHandle): Promise<void>;
    /** Whether a run gets a lead (settings, not given up). */
    leadEnabled(runId: string): boolean;
    leadTools: {
      planStatus(binding: McpBinding): PlanStatus;
      addTask(binding: McpBinding, node: TaskNode): Promise<AmendmentResult>;
      amendTask(binding: McpBinding, nodeId: string, patch: TaskNodePatch): Promise<AmendmentResult>;
      cancelTask(binding: McpBinding, nodeId: string, reason: string): Promise<AmendmentResult>;
    };
    spawnResearch(binding: McpBinding, request: SpawnResearchRequest): Promise<{ attemptId: string; role: Role }>;
    assistant(runId: string, loop: LeadLoopHandle): Promise<void>;
    assistantEnabled(runId: string): boolean;
    assistantTools: {
      startImplementation(binding: McpBinding, request: StartImplementationRequest): { runId: string; status: string };
      runStatus(binding: McpBinding): AssistantRunStatus;
    };
  } | null = null;

  /** Open the run's assistant loop (no-op when one runs). */
  startAssistant(runId: string): void {
    if (this.closed || this.assistantLoops.has(runId) || !this.flows) return;
    const flows = this.flows;
    const loop: LeadLoopHandle = { wake: deferred<void>() };
    this.assistantLoops.set(runId, loop);
    this.background(`assistant ${runId}`, () =>
      flows.assistant(runId, loop).finally(() => {
        if (this.assistantLoops.get(runId) === loop) this.assistantLoops.delete(runId);
      }),
    );
  }

  wakeAssistant(runId: string): void {
    const loop = this.assistantLoops.get(runId);
    if (!loop) return;
    loop.wake.resolve();
    loop.wake = deferred<void>();
  }

  /** The run's assistant attempt (the lead's parent), when there is one and it was not given up. */
  assistantAttemptId(runId: string): string | null {
    const meta = runMeta(this.store, runId);
    return meta.assistantDisabled ? null : meta.assistantAttemptId;
  }

  /** Keep every live conversation's assistant running and informed (called from the tick). */
  private tickAssistants(): void {
    if (!this.flows) return;
    for (const run of this.store.listRuns()) {
      if (isTerminal(RUN_TRANSITIONS, run.status) || run.archived) continue;
      const meta = runMeta(this.store, run.id);
      if (run.status !== 'chatting' && meta.assistantAttemptId === null) continue;
      if (!this.flows.assistantEnabled(run.id)) continue;
      this.startAssistant(run.id);
      this.wakeAssistant(run.id);
    }
  }

  /** Open the run's lead loop (no-op when one runs). */
  startLead(runId: string): void {
    if (this.closed || this.leadLoops.has(runId) || !this.flows) return;
    const flows = this.flows;
    const loop: LeadLoopHandle = { wake: deferred<void>() };
    this.leadLoops.set(runId, loop);
    this.background(`lead ${runId}`, () =>
      flows.lead(runId, loop).finally(() => {
        if (this.leadLoops.get(runId) === loop) this.leadLoops.delete(runId);
      }),
    );
  }

  /** Something the lead should see happened (a message, a board change, an amendment answer). */
  wakeLead(runId: string): void {
    const loop = this.leadLoops.get(runId);
    if (!loop) return;
    loop.wake.resolve();
    loop.wake = deferred<void>();
  }

  /** The run's lead attempt, when its coders should report to one (null = none, none yet, or given up). */
  leadAttemptId(runId: string): string | null {
    const meta = runMeta(this.store, runId);
    return meta.leadDisabled ? null : meta.leadAttemptId;
  }

  /** Pause between lead session failures (tests shorten it). */
  leadBackoffMs = 5_000;

  /**
   * Dispatch waits for the lead: a run that gets a lead holds its tasks until the lead attempt exists, so every
   * coder is opened with its parent set (otherwise the first coders would have no `ask_lead`).
   */
  private leadGate(run: Run): boolean {
    if (!this.flows?.leadEnabled(run.id)) return false;
    this.startLead(run.id);
    return runMeta(this.store, run.id).leadAttemptId === null;
  }

  startDriver(taskId: string): void {
    if (this.closed || this.drivers.has(taskId) || !this.flows) return;
    const flows = this.flows;
    this.drivers.add(taskId);
    this.parked.delete(taskId);
    this.background(`task ${taskId}`, () =>
      flows.driveTask(taskId).finally(() => {
        this.drivers.delete(taskId);
        this.scheduleTick();
      }),
    );
  }

  /** The run's merge queue is parked and its gate is still closed (arms the wake timer for a rate limit). */
  private mergeQueueWaits(run: Run): boolean {
    const parked = this.mergeParked.get(run.id);
    if (!parked) return false;
    if (parked.kind === 'paused' && run.paused) return true;
    if (parked.kind === 'rate') {
      const until = this.limitedUntil(parked.engine);
      if (until !== null) {
        this.armWake(until);
        return true;
      }
    }
    this.mergeParked.delete(run.id);
    return false;
  }

  startMergeQueue(runId: string): void {
    if (this.closed || this.mergeLoops.has(runId) || !this.flows) return;
    const flows = this.flows;
    this.mergeLoops.add(runId);
    this.background(`merge queue ${runId}`, () =>
      flows.mergeQueue(runId).finally(() => {
        this.mergeLoops.delete(runId);
        this.scheduleTick();
      }),
    );
  }

  startFinalize(runId: string): void {
    const flows = this.flows;
    if (!flows || this.runJobs.has(runId)) return;
    this.runJob(runId, 'finalize', () => flows.finalize(runId));
  }

  /**
   * Run a run-level job (planner steps, finalize), one at a time per run. A job requested while another
   * runs is started when it finishes (the latest request wins).
   */
  runJob(runId: string, name: string, job: () => Promise<void>): void {
    if (this.closed) return;
    if (this.runJobs.has(runId)) {
      this.pendingJobs.set(runId, { name, job });
      return;
    }
    this.runJobs.add(runId);
    this.background(`${name} ${runId}`, () =>
      job().finally(() => {
        this.runJobs.delete(runId);
        const next = this.pendingJobs.get(runId);
        this.pendingJobs.delete(runId);
        if (next) this.runJob(runId, next.name, next.job);
        else this.scheduleTick();
      }),
    );
  }

  private readonly pendingJobs = new Map<string, { name: string; job: () => Promise<void> }>();

  /** Slot-holding tasks per coder engine for every executing run. */
  private slotsByRun(runs: readonly Run[]): Map<string, Partial<Record<EngineKind, number>>> {
    const out = new Map<string, Partial<Record<EngineKind, number>>>();
    for (const run of runs) {
      const counts: Partial<Record<EngineKind, number>> = {};
      const engine = this.coderEngine();
      for (const task of this.store.listTasks(run.id)) {
        if (!SLOT_STATUSES.has(task.status)) continue;
        counts[engine] = (counts[engine] ?? 0) + 1;
      }
      out.set(run.id, counts);
    }
    return out;
  }

  private async tick(): Promise<void> {
    if (this.closed || !this.flows) return;
    this.tickAssistants();
    const settings = this.settings();
    const runs = this.store.listRuns().filter((r) => r.status === 'executing');
    for (const run of runs) {
      const slots = this.slotsByRun(runs);
      const others: Partial<Record<EngineKind, number>> = {};
      for (const [runId, counts] of slots) {
        if (runId === run.id) continue;
        for (const [engine, n] of Object.entries(counts) as [EngineKind, number][]) {
          others[engine] = (others[engine] ?? 0) + n;
        }
      }
      this.tickRun(run, settings, others);
    }
  }

  private tickRun(run: Run, settings: Settings, otherRunsInFlight: Partial<Record<EngineKind, number>>): void {
    const nodes = this.approvedNodes(run.id);
    if (nodes.length === 0) return;
    if (this.leadGate(run)) return;
    this.wakeLead(run.id);
    const now = this.now();
    const plan = planDispatch({
      nodes,
      tasks: this.store.listTasks(run.id),
      settings,
      otherRunsInFlight,
      paused: run.paused,
      rateLimits: this.activeRateLimits(),
      now,
    });
    const byNode = new Map(this.store.listTasks(run.id).map((t) => [t.nodeId, t]));
    this.store.transaction(() => {
      for (const nodeId of plan.enqueue) {
        const task = byNode.get(nodeId);
        if (task) this.store.transitionTask(task.id, 'blocked', 'queued');
      }
      for (const nodeId of plan.block) {
        const task = byNode.get(nodeId);
        if (task) this.store.transitionTask(task.id, 'queued', 'blocked');
      }
      for (const decision of plan.dispatch) {
        const task = byNode.get(decision.nodeId);
        if (!task) continue;
        const fresh = this.store.requireTask(task.id);
        this.store.transitionTask(task.id, 'queued', 'provisioning', {
          attemptCount: fresh.attemptCount + 1,
          fixRounds: 0,
          error: null,
          progress: null,
        });
      }
    });
    for (const task of this.store.listTasks(run.id)) {
      if (!SLOT_STATUSES.has(task.status) || this.drivers.has(task.id)) continue;
      const parked = this.parked.get(task.id);
      if (parked?.kind === 'paused' && run.paused) continue;
      if (parked?.kind === 'rate') {
        const until = this.limitedUntil(parked.engine);
        if (until !== null) {
          this.armWake(until);
          continue;
        }
      }
      this.startDriver(task.id);
    }
    const tasks = this.store.listTasks(run.id);
    if (tasks.some((t) => t.status === 'approved' || t.status === 'merging') && !this.mergeQueueWaits(run)) {
      this.startMergeQueue(run.id);
    }
    if (plan.run.state === 'complete' && !this.mergeLoops.has(run.id)) this.startFinalize(run.id);
    if (plan.nextWakeAt !== null) this.armWake(plan.nextWakeAt);
  }

  // -- MCP host ----------------------------------------------------------------------------------

  readonly mcpHost: McpHost = {
    onProgress: (binding, summary) => {
      if (this.closed || !binding.taskId) return;
      this.store.updateTask(binding.taskId, { progress: summary.slice(0, 500) });
    },
    askHuman: async (binding, question, options) => {
      this.assertOpen();
      const item = this.store.insertInboxItem({
        runId: binding.runId,
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        kind: 'question',
        payload: { source: 'agent', questions: [{ id: 'q1', question, options: options ?? [] }] },
      });
      const resolution = await this.awaitResolution(item.id, binding.attemptId);
      if (resolution.kind !== 'question') throw new Error('unexpected resolution');
      const answer = resolution.answers.find((a) => a.questionId === 'q1') ?? resolution.answers[0];
      if (!answer) throw new Error('the human dismissed the question; decide yourself and explain in your summary');
      return answer.answer;
    },
    approve: async (binding: McpBinding, request): Promise<ApproveResult> => {
      this.assertOpen();
      const item = this.store.insertInboxItem({
        runId: binding.runId,
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        kind: 'approval',
        payload: {
          requestId: request.toolUseId ?? `mcp-${Date.now()}`,
          tool: request.toolName,
          input: request.input,
          reason: null,
        },
      });
      const resolution = await this.awaitResolution(item.id, binding.attemptId);
      if (resolution.kind !== 'approval') throw new Error('unexpected resolution');
      const decision = resolution.decision;
      if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message };
      const updated = decision.updatedInput;
      return {
        behavior: 'allow',
        ...(updated && typeof updated === 'object' ? { updatedInput: updated as Record<string, unknown> } : {}),
      };
    },
    markDone: (binding, done) => {
      const run = this.live.get(binding.attemptId);
      if (run) run.markDone = done;
    },
    listAgents: (binding) => {
      const me = this.store.requireAttempt(binding.attemptId);
      const parent = me.parentAttemptId ? this.store.getAttempt(me.parentAttemptId) : null;
      return {
        parent: parent ? this.peer(parent) : null,
        children: this.store.listChildAttempts(me.id).map((child) => this.peer(child)),
      };
    },
    sendMessage: (binding, request) => {
      this.assertOpen();
      const from = this.store.requireAttempt(binding.attemptId);
      const target =
        request.to === 'lead'
          ? from.parentAttemptId
          : request.to === 'planner'
            ? (this.store
                .listChildAttempts(from.id)
                .filter((a) => a.role === 'planner')
                .at(-1)?.id ?? null)
            : request.to;
      if (!target) throw new Error(request.to === 'planner' ? 'no planner has started yet' : 'you have no lead');
      const to = this.store.getAttempt(target);
      if (!to || !canMessage(from, to)) throw new Error(messageRefusal(from, to));
      if (request.replyTo !== null) {
        const original = this.store.getMessage(request.replyTo);
        if (!original || original.runId !== from.runId) throw new Error(`unknown reply_to message ${request.replyTo}`);
      }
      return this.postMessage({
        runId: from.runId,
        fromAttemptId: from.id,
        toAttemptId: to.id,
        kind: request.kind,
        body: request.body,
        replyTo: request.replyTo,
      });
    },
    awaitMessage: (binding, filter) => {
      this.assertOpen();
      const matches = (m: AgentMessage) => filter.replyTo === null || m.replyTo === filter.replyTo;
      const queued = this.store.queuedMessagesFor(binding.attemptId).find(matches);
      if (queued) {
        const [delivered] = this.store.markDelivered([queued.id]);
        return Promise.resolve(delivered ?? queued);
      }
      return new Promise<AgentMessage | null>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const waiter: MessageWaiter = {
          replyTo: filter.replyTo,
          resolve: (message) => {
            if (timer) clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            if (timer) clearTimeout(timer);
            reject(error);
          },
        };
        const waiting = this.messageWaiters.get(binding.attemptId) ?? [];
        waiting.push(waiter);
        this.messageWaiters.set(binding.attemptId, waiting);
        if (filter.timeoutMs !== null) {
          timer = setTimeout(() => {
            const list = this.messageWaiters.get(binding.attemptId);
            const index = list?.indexOf(waiter) ?? -1;
            if (list && index >= 0) list.splice(index, 1);
            if (list && list.length === 0) this.messageWaiters.delete(binding.attemptId);
            resolve(null);
          }, filter.timeoutMs);
          timer.unref?.();
        }
      });
    },
    planStatus: (binding) => this.leadTools().planStatus(binding),
    readPlan: (binding, section) => {
      const plan = this.approvedPlan(binding.runId);
      if (!plan) throw new Error('the run has no approved plan yet');
      return planDocument({ version: plan.version, markdown: plan.markdown, nodes: plan.dag.nodes }, section);
    },
    addTask: (binding, node) => this.leadTools().addTask(binding, node),
    amendTask: (binding, nodeId, patch) => this.leadTools().amendTask(binding, nodeId, patch),
    cancelTask: (binding, nodeId, reason) => this.leadTools().cancelTask(binding, nodeId, reason),
    spawnResearch: (binding, request) => {
      this.assertOpen();
      if (!this.flows) throw new Error('research is not wired');
      return this.flows.spawnResearch(binding, request);
    },
    startImplementation: (binding, request) => {
      this.assertOpen();
      if (!this.flows) throw new Error('the assistant is not wired');
      return this.flows.assistantTools.startImplementation(binding, request);
    },
    runStatus: (binding) => {
      this.assertOpen();
      if (!this.flows) throw new Error('the assistant is not wired');
      return this.flows.assistantTools.runStatus(binding);
    },
    present: (binding: McpBinding, request: PresentRequest) => {
      this.assertOpen();
      return present(this, binding, request);
    },
  };

  private leadTools(): NonNullable<Orchestrator['flows']>['leadTools'] {
    this.assertOpen();
    if (!this.flows) throw new Error('the lead tools are not wired');
    return this.flows.leadTools;
  }

  // -- shutdown ----------------------------------------------------------------------------------

  /**
   * Stop everything without touching the DB state of in-flight work (like a crash, so recovery can
   * resume it): close live sessions, cancel timers, wait briefly for background jobs.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offEvents();
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const waiter of this.waiters.values()) waiter.reject(new Closed('engine shutting down'));
    this.waiters.clear();
    for (const attemptId of [...this.messageWaiters.keys()])
      this.rejectMessageWaiters(attemptId, 'engine shutting down');
    for (const loop of this.leadLoops.values()) loop.wake.resolve();
    for (const loop of this.assistantLoops.values()) loop.wake.resolve();
    await Promise.allSettled([...this.live.values()].map((run) => run.close()));
    await Promise.race([Promise.allSettled([...this.jobs]), sleep(5_000)]);
    await this.tickChain.catch(() => undefined);
    if (this.poweredOn) this.host({ type: 'power', preventSleep: false });
  }
}
