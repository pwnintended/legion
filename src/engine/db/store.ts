/**
 * Typed repository layer over node:sqlite.
 *
 * Rules:
 * - Every mutation appends a `ServerEvent` to the `events` table in the same transaction and, after
 *   COMMIT, hands the events to `onEvents` listeners (the RPC hub publishes them to renderers).
 * - Status changes go through `transition*`: validated against the shared transition tables and applied
 *   with compare-and-set (`UPDATE … WHERE status = ?`). A lost race throws `RpcError('conflict')`.
 * - Everything is synchronous (node:sqlite is), so a `transaction(fn)` callback must not await.
 */

import type { SQLInputValue } from 'node:sqlite';
import {
  ATTEMPT_TRANSITIONS,
  type Attempt,
  type AttemptStatus,
  applySettingsPatch,
  canTransition,
  DEFAULT_SETTINGS,
  type InboxItem,
  type InboxKind,
  type InboxPayload,
  type InboxResolution,
  type Merge,
  normalizeSettings,
  type Plan,
  type Review,
  RUN_TRANSITIONS,
  type Run,
  type RunStatus,
  type Settings,
  type SettingsPatch,
  TASK_TRANSITIONS,
  type Task,
  type TaskStatus,
  type TransitionTable,
  type Verification,
} from '@shared/domain';
import type { AgentEvent, ServerEvent, ServerEventBody } from '@shared/events';
import { eventRefs } from '@shared/events';
import { newId } from '@shared/ids';
import type { RecentRepo, RunSnapshot, RunSummary, TranscriptEntry } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import type { Database } from './sqlite';

// ---------------------------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------------------------

type ColumnKind = 'plain' | 'json' | 'bool';
type ColumnSpec<T> = { readonly [K in keyof T]-?: readonly [column: string, kind?: ColumnKind] };
type Row = Record<string, unknown>;

class Table<T extends { id: string }> {
  readonly keys: (keyof T & string)[];
  constructor(
    readonly name: string,
    readonly spec: ColumnSpec<T>,
  ) {
    this.keys = Object.keys(spec) as (keyof T & string)[];
  }

  column(key: keyof T): string {
    return this.spec[key][0];
  }

  toDb(key: keyof T, value: unknown): SQLInputValue {
    const kind = this.spec[key][1] ?? 'plain';
    if (value === undefined || value === null) return null;
    if (kind === 'json') return JSON.stringify(value);
    if (kind === 'bool') return value ? 1 : 0;
    return value as SQLInputValue;
  }

  fromRow(row: Row): T {
    const out: Record<string, unknown> = {};
    for (const key of this.keys) {
      const [column, kind = 'plain'] = this.spec[key];
      const value = row[column];
      if (value === null || value === undefined) out[key] = null;
      else if (kind === 'json') out[key] = JSON.parse(value as string);
      else if (kind === 'bool') out[key] = value === 1 || value === 1n;
      else out[key] = value;
    }
    return out as T;
  }
}

const runs = new Table<Run>('runs', {
  id: ['id'],
  repoPath: ['repo_path'],
  baseRef: ['base_ref'],
  title: ['title'],
  issueText: ['issue_text'],
  issueUrl: ['issue_url'],
  status: ['status'],
  paused: ['paused', 'bool'],
  plannerEngine: ['planner_engine'],
  plannerModel: ['planner_model'],
  integrationBranch: ['integration_branch'],
  prUrl: ['pr_url'],
  error: ['error'],
  createdAt: ['created_at'],
  updatedAt: ['updated_at'],
});

const plans = new Table<Plan>('plans', {
  id: ['id'],
  runId: ['run_id'],
  version: ['version'],
  markdown: ['markdown'],
  dag: ['dag', 'json'],
  source: ['source'],
  feedback: ['feedback'],
  createdAt: ['created_at'],
  approvedAt: ['approved_at'],
});

const tasks = new Table<Task>('tasks', {
  id: ['id'],
  runId: ['run_id'],
  nodeId: ['node_id'],
  status: ['status'],
  branch: ['branch'],
  worktreePath: ['worktree_path'],
  startSha: ['start_sha'],
  attemptCount: ['attempt_count'],
  fixRounds: ['fix_rounds'],
  mergedSha: ['merged_sha'],
  engineOverride: ['engine_override'],
  modelOverride: ['model_override'],
  effortOverride: ['effort_override'],
  progress: ['progress'],
  error: ['error'],
  createdAt: ['created_at'],
  updatedAt: ['updated_at'],
});

const attempts = new Table<Attempt>('attempts', {
  id: ['id'],
  runId: ['run_id'],
  taskId: ['task_id'],
  role: ['role'],
  engine: ['engine'],
  model: ['model'],
  effort: ['effort'],
  sessionId: ['session_id'],
  status: ['status'],
  startedAt: ['started_at'],
  endedAt: ['ended_at'],
  costUsd: ['cost_usd'],
  inputTokens: ['input_tokens'],
  outputTokens: ['output_tokens'],
  error: ['error'],
});

const reviews = new Table<Review>('reviews', {
  id: ['id'],
  runId: ['run_id'],
  taskId: ['task_id'],
  attemptId: ['attempt_id'],
  verdict: ['verdict'],
  criteria: ['criteria', 'json'],
  findings: ['findings', 'json'],
  summary: ['summary'],
  createdAt: ['created_at'],
});

const inbox = new Table<InboxItem>('inbox_items', {
  id: ['id'],
  runId: ['run_id'],
  taskId: ['task_id'],
  attemptId: ['attempt_id'],
  kind: ['kind'],
  payload: ['payload', 'json'],
  resolution: ['resolution', 'json'],
  createdAt: ['created_at'],
  resolvedAt: ['resolved_at'],
});

const merges = new Table<Merge>('merges', {
  id: ['id'],
  runId: ['run_id'],
  taskId: ['task_id'],
  preSha: ['pre_sha'],
  postSha: ['post_sha'],
  status: ['status'],
  error: ['error'],
  createdAt: ['created_at'],
  endedAt: ['ended_at'],
});

const verifications = new Table<Verification>('verifications', {
  id: ['id'],
  runId: ['run_id'],
  taskId: ['task_id'],
  attemptId: ['attempt_id'],
  phase: ['phase'],
  command: ['command'],
  exitCode: ['exit_code'],
  outputTail: ['output_tail'],
  durationMs: ['duration_ms'],
  createdAt: ['created_at'],
});

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

type Mutable<T> = Partial<Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'status'>>;
export type RunPatch = Mutable<Run>;
export type TaskPatch = Mutable<Omit<Task, 'runId' | 'nodeId'>>;
export type AttemptPatch = Mutable<Omit<Attempt, 'runId' | 'taskId' | 'role'>>;
export type MergePatch = Partial<Pick<Merge, 'postSha' | 'error' | 'endedAt'>>;

export type NewRun = Pick<
  Run,
  'repoPath' | 'baseRef' | 'title' | 'issueText' | 'issueUrl' | 'plannerEngine' | 'plannerModel'
> &
  Partial<Pick<Run, 'id' | 'status'>>;
export type NewPlan = Pick<Plan, 'runId' | 'markdown' | 'dag' | 'source' | 'feedback'> & Partial<Pick<Plan, 'id'>>;
export type NewTask = Pick<Task, 'runId' | 'nodeId'> & Partial<Pick<Task, 'id' | 'status'>>;
export type NewAttempt = Pick<Attempt, 'runId' | 'taskId' | 'role' | 'engine' | 'model' | 'effort'> &
  Partial<Pick<Attempt, 'id' | 'status' | 'sessionId'>>;
export type NewReview = Omit<Review, 'id' | 'createdAt'> & Partial<Pick<Review, 'id'>>;
export type NewInboxItem<K extends InboxKind = InboxKind> = {
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  kind: K;
  payload: InboxPayload<K>;
};
export type NewMerge = Pick<Merge, 'runId' | 'taskId' | 'preSha'>;
export type NewVerification = Omit<Verification, 'id' | 'createdAt'>;

export interface StoreOptions {
  now?: () => number;
}

const notFound = (what: string, id: string): RpcError => new RpcError('not_found', `${what} ${id} not found`);

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export class Store {
  private readonly now: () => number;
  private readonly listeners = new Set<(events: ServerEvent[]) => void>();
  private readonly statements = new Map<string, ReturnType<Database['prepare']>>();
  private depth = 0;
  private pending: ServerEvent[] = [];

  constructor(
    readonly db: Database,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  // -- plumbing ---------------------------------------------------------------------------------

  private stmt(sql: string): ReturnType<Database['prepare']> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  /** Called after each successful commit with the events it appended (in seq order). */
  onEvents(listener: (events: ServerEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run `fn` in a transaction (nested calls join the outer one). `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    this.pending = [];
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error('Store.transaction callback must be synchronous');
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.pending = [];
      throw error;
    } finally {
      this.depth = 0;
    }
    const events = this.pending;
    this.pending = [];
    if (events.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(events);
        } catch (error) {
          console.error('[store] event listener failed', error);
        }
      }
    }
    return result;
  }

  private insert<T extends { id: string }>(table: Table<T>, entity: T): void {
    const columns = table.keys.map((key) => table.column(key));
    const values = table.keys.map((key) => table.toDb(key, entity[key]));
    this.run(
      `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...values,
    );
  }

  private select<T extends { id: string }>(table: Table<T>, id: string): T | null {
    const row = this.get(`SELECT * FROM ${table.name} WHERE id = ?`, id);
    return row ? table.fromRow(row) : null;
  }

  private selectWhere<T extends { id: string }>(
    table: Table<T>,
    where: string,
    order: string,
    ...params: SQLInputValue[]
  ): T[] {
    return this.all(`SELECT * FROM ${table.name} WHERE ${where} ORDER BY ${order}`, ...params).map((row) =>
      table.fromRow(row),
    );
  }

  /**
   * Generic UPDATE with optional compare-and-set on status. Returns false when the CAS did not match.
   */
  private patchRow<T extends { id: string }>(
    table: Table<T>,
    id: string,
    patch: NoInfer<Partial<T>>,
    expectStatus?: readonly string[],
  ): boolean {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof T & string, unknown][];
    const sets = entries.map(([key]) => `${table.column(key)} = ?`);
    const params = entries.map(([key, value]) => table.toDb(key, value));
    if (sets.length === 0) return true;
    let sql = `UPDATE ${table.name} SET ${sets.join(', ')} WHERE id = ?`;
    params.push(id);
    if (expectStatus && expectStatus.length > 0) {
      sql += ` AND status IN (${expectStatus.map(() => '?').join(', ')})`;
      params.push(...expectStatus);
    }
    return this.run(sql, ...params) > 0;
  }

  private transition<T extends { id: string; status: S }, S extends string>(
    table: Table<T>,
    transitions: TransitionTable<S>,
    what: string,
    id: string,
    from: S | readonly S[],
    to: S,
    patch: Partial<T>,
  ): { entity: T; from: S } {
    const allowed = (Array.isArray(from) ? from : [from]) as readonly S[];
    for (const source of allowed) {
      if (!canTransition(transitions, source, to)) {
        throw new RpcError('conflict', `illegal ${what} transition ${source} → ${to}`);
      }
    }
    const current = this.select(table, id);
    if (!current) throw notFound(what, id);
    if (!allowed.includes(current.status)) {
      throw new RpcError('conflict', `${what} ${id} is ${current.status}, expected ${allowed.join(' | ')}`, {
        actual: current.status,
      });
    }
    const updated = this.patchRow(table, id, { ...patch, status: to } as Partial<T>, [current.status]);
    if (!updated) throw new RpcError('conflict', `${what} ${id} changed concurrently`);
    const entity = this.select(table, id);
    if (!entity) throw notFound(what, id);
    return { entity, from: current.status };
  }

  // -- events -----------------------------------------------------------------------------------

  /** Append an event (joins the current transaction, or runs in its own). */
  append(body: ServerEventBody): ServerEvent {
    return this.transaction(() => {
      const ts = this.now();
      const refs = eventRefs(body);
      const seq = Number(
        this.stmt('INSERT INTO events (ts, run_id, task_id, attempt_id, type, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
          ts,
          refs.runId,
          refs.taskId,
          refs.attemptId,
          body.type,
          JSON.stringify(body),
        ).lastInsertRowid,
      );
      const event = { ...body, seq, ts } as ServerEvent;
      this.pending.push(event);
      return event;
    });
  }

  headSeq(): number {
    return Number(this.get('SELECT COALESCE(MAX(seq), 0) AS head FROM events')?.head ?? 0);
  }

  private toEvent(row: Row): ServerEvent {
    return { ...(JSON.parse(row.payload as string) as ServerEventBody), seq: Number(row.seq), ts: Number(row.ts) };
  }

  /** Events with seq > sinceSeq, oldest first. */
  eventsSince(sinceSeq: number, limit: number): ServerEvent[] {
    return this.all('SELECT seq, ts, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?', sinceSeq, limit).map(
      (row) => this.toEvent(row),
    );
  }

  appendAgentEvent(attempt: Pick<Attempt, 'id' | 'runId' | 'taskId'>, event: AgentEvent): ServerEvent {
    return this.append({
      type: 'agent.event',
      runId: attempt.runId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      event,
    });
  }

  attemptTranscript(
    attemptId: string,
    sinceSeq: number,
    limit: number,
  ): { entries: TranscriptEntry[]; hasMore: boolean } {
    const rows = this.all(
      `SELECT seq, ts, payload FROM events WHERE attempt_id = ? AND type = 'agent.event' AND seq > ?
       ORDER BY seq LIMIT ?`,
      attemptId,
      sinceSeq,
      limit + 1,
    );
    const entries = rows.slice(0, limit).map((row) => {
      const body = JSON.parse(row.payload as string) as Extract<ServerEventBody, { type: 'agent.event' }>;
      return { seq: Number(row.seq), ts: Number(row.ts), event: body.event };
    });
    return { entries, hasMore: rows.length > limit };
  }

  // -- settings & kv ----------------------------------------------------------------------------

  getMeta<T = unknown>(key: string): T | null {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? (JSON.parse(row.value as string) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    );
  }

  getSettings(): Settings {
    const stored = this.getMeta('app');
    return stored === null ? DEFAULT_SETTINGS : normalizeSettings(stored);
  }

  updateSettings(patch: SettingsPatch): Settings {
    return this.transaction(() => {
      const settings = applySettingsPatch(this.getSettings(), patch);
      this.setMeta('app', settings);
      this.append({ type: 'settings.updated', settings });
      return settings;
    });
  }

  // -- recent repos -----------------------------------------------------------------------------

  touchRecentRepo(path: string, name: string): void {
    this.run(
      `INSERT INTO recent_repos (path, name, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET name = excluded.name, last_used_at = excluded.last_used_at`,
      path,
      name,
      this.now(),
    );
  }

  listRecentRepos(limit = 20): RecentRepo[] {
    return this.all('SELECT path, name, last_used_at FROM recent_repos ORDER BY last_used_at DESC LIMIT ?', limit).map(
      (row) => ({ path: row.path as string, name: row.name as string, lastUsedAt: Number(row.last_used_at) }),
    );
  }

  // -- runs -------------------------------------------------------------------------------------

  createRun(input: NewRun): Run {
    return this.transaction(() => {
      const now = this.now();
      const run: Run = {
        id: input.id ?? newId('run'),
        repoPath: input.repoPath,
        baseRef: input.baseRef,
        title: input.title,
        issueText: input.issueText,
        issueUrl: input.issueUrl,
        status: input.status ?? 'draft',
        paused: false,
        plannerEngine: input.plannerEngine,
        plannerModel: input.plannerModel,
        integrationBranch: null,
        prUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      this.insert(runs, run);
      this.append({ type: 'run.updated', run, from: null });
      return run;
    });
  }

  getRun(id: string): Run | null {
    return this.select(runs, id);
  }

  requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw notFound('run', id);
    return run;
  }

  listRuns(): Run[] {
    return this.all('SELECT * FROM runs ORDER BY created_at DESC').map((row) => runs.fromRow(row));
  }

  transitionRun(id: string, from: RunStatus | readonly RunStatus[], to: RunStatus, patch: RunPatch = {}): Run {
    return this.transaction(() => {
      const result = this.transition(runs, RUN_TRANSITIONS, 'run', id, from, to, {
        ...patch,
        updatedAt: this.now(),
      });
      this.append({ type: 'run.updated', run: result.entity, from: result.from });
      return result.entity;
    });
  }

  updateRun(id: string, patch: RunPatch): Run {
    return this.transaction(() => {
      if (!this.patchRow(runs, id, { ...patch, updatedAt: this.now() })) throw notFound('run', id);
      const run = this.requireRun(id);
      this.append({ type: 'run.updated', run, from: null });
      return run;
    });
  }

  listRunSummaries(): RunSummary[] {
    const counts = new Map<string, Partial<Record<TaskStatus, number>>>();
    for (const row of this.all('SELECT run_id, status, COUNT(*) AS n FROM tasks GROUP BY run_id, status')) {
      const runCounts = counts.get(row.run_id as string) ?? {};
      runCounts[row.status as TaskStatus] = Number(row.n);
      counts.set(row.run_id as string, runCounts);
    }
    const inboxCounts = new Map(
      this.all('SELECT run_id, COUNT(*) AS n FROM inbox_items WHERE resolved_at IS NULL GROUP BY run_id').map(
        (row) => [row.run_id as string, Number(row.n)] as const,
      ),
    );
    const costs = new Map(
      this.all('SELECT run_id, COALESCE(SUM(cost_usd), 0) AS c FROM attempts GROUP BY run_id').map(
        (row) => [row.run_id as string, Number(row.c)] as const,
      ),
    );
    return this.listRuns().map((run) => ({
      run,
      taskCounts: counts.get(run.id) ?? {},
      openInbox: inboxCounts.get(run.id) ?? 0,
      costUsd: costs.get(run.id) ?? 0,
    }));
  }

  runSnapshot(runId: string): RunSnapshot {
    const run = this.requireRun(runId);
    return {
      seq: this.headSeq(),
      run,
      plans: this.listPlans(runId),
      tasks: this.listTasks(runId),
      attempts: this.listAttempts(runId),
      reviews: this.listReviews(runId),
      inbox: this.listInbox({ runId, includeResolved: true }),
      verifications: this.listVerifications(runId),
      merges: this.listMerges(runId),
    };
  }

  // -- plans ------------------------------------------------------------------------------------

  insertPlan(input: NewPlan): Plan {
    return this.transaction(() => {
      this.requireRun(input.runId);
      const version =
        Number(this.get('SELECT COALESCE(MAX(version), 0) AS v FROM plans WHERE run_id = ?', input.runId)?.v ?? 0) + 1;
      const plan: Plan = {
        id: input.id ?? newId('plan'),
        runId: input.runId,
        version,
        markdown: input.markdown,
        dag: input.dag,
        source: input.source,
        feedback: input.feedback,
        createdAt: this.now(),
        approvedAt: null,
      };
      this.insert(plans, plan);
      this.append({ type: 'plan.updated', plan });
      return plan;
    });
  }

  getPlan(id: string): Plan | null {
    return this.select(plans, id);
  }

  listPlans(runId: string): Plan[] {
    return this.selectWhere(plans, 'run_id = ?', 'version', runId);
  }

  latestPlan(runId: string): Plan | null {
    return this.listPlans(runId).at(-1) ?? null;
  }

  /** Marks a plan approved (CAS on approved_at IS NULL). */
  approvePlan(id: string): Plan {
    return this.transaction(() => {
      const changed = this.run('UPDATE plans SET approved_at = ? WHERE id = ? AND approved_at IS NULL', this.now(), id);
      const plan = this.getPlan(id);
      if (!plan) throw notFound('plan', id);
      if (changed === 0) throw new RpcError('conflict', `plan ${id} is already approved`);
      this.append({ type: 'plan.updated', plan });
      return plan;
    });
  }

  // -- tasks ------------------------------------------------------------------------------------

  insertTask(input: NewTask): Task {
    return this.transaction(() => {
      const now = this.now();
      const task: Task = {
        id: input.id ?? newId('task'),
        runId: input.runId,
        nodeId: input.nodeId,
        status: input.status ?? 'blocked',
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
      this.insert(tasks, task);
      this.append({ type: 'task.updated', task, from: null });
      return task;
    });
  }

  getTask(id: string): Task | null {
    return this.select(tasks, id);
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw notFound('task', id);
    return task;
  }

  listTasks(runId: string): Task[] {
    return this.selectWhere(tasks, 'run_id = ?', 'created_at, node_id', runId);
  }

  transitionTask(id: string, from: TaskStatus | readonly TaskStatus[], to: TaskStatus, patch: TaskPatch = {}): Task {
    return this.transaction(() => {
      const result = this.transition(tasks, TASK_TRANSITIONS, 'task', id, from, to, {
        ...patch,
        updatedAt: this.now(),
      });
      this.append({ type: 'task.updated', task: result.entity, from: result.from });
      return result.entity;
    });
  }

  updateTask(id: string, patch: TaskPatch): Task {
    return this.transaction(() => {
      if (!this.patchRow(tasks, id, { ...patch, updatedAt: this.now() })) throw notFound('task', id);
      const task = this.requireTask(id);
      this.append({ type: 'task.updated', task, from: null });
      return task;
    });
  }

  // -- attempts ---------------------------------------------------------------------------------

  insertAttempt(input: NewAttempt): Attempt {
    return this.transaction(() => {
      const attempt: Attempt = {
        id: input.id ?? newId('attempt'),
        runId: input.runId,
        taskId: input.taskId,
        role: input.role,
        engine: input.engine,
        model: input.model,
        effort: input.effort,
        sessionId: input.sessionId ?? null,
        status: input.status ?? 'pending',
        startedAt: this.now(),
        endedAt: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        error: null,
      };
      this.insert(attempts, attempt);
      this.append({ type: 'attempt.updated', attempt, from: null });
      return attempt;
    });
  }

  getAttempt(id: string): Attempt | null {
    return this.select(attempts, id);
  }

  requireAttempt(id: string): Attempt {
    const attempt = this.getAttempt(id);
    if (!attempt) throw notFound('attempt', id);
    return attempt;
  }

  listAttempts(runId: string): Attempt[] {
    return this.selectWhere(attempts, 'run_id = ?', 'started_at, id', runId);
  }

  listAttemptsByStatus(status: AttemptStatus): Attempt[] {
    return this.selectWhere(attempts, 'status = ?', 'started_at', status);
  }

  transitionAttempt(
    id: string,
    from: AttemptStatus | readonly AttemptStatus[],
    to: AttemptStatus,
    patch: AttemptPatch = {},
  ): Attempt {
    return this.transaction(() => {
      const terminal = ATTEMPT_TRANSITIONS[to].length === 0;
      const result = this.transition(attempts, ATTEMPT_TRANSITIONS, 'attempt', id, from, to, {
        ...(terminal ? { endedAt: this.now() } : {}),
        ...patch,
      });
      this.append({ type: 'attempt.updated', attempt: result.entity, from: result.from });
      return result.entity;
    });
  }

  updateAttempt(id: string, patch: AttemptPatch): Attempt {
    return this.transaction(() => {
      if (!this.patchRow(attempts, id, patch)) throw notFound('attempt', id);
      const attempt = this.requireAttempt(id);
      this.append({ type: 'attempt.updated', attempt, from: null });
      return attempt;
    });
  }

  // -- reviews ----------------------------------------------------------------------------------

  insertReview(input: NewReview): Review {
    return this.transaction(() => {
      const review: Review = { ...input, id: input.id ?? newId('review'), createdAt: this.now() };
      this.insert(reviews, review);
      this.append({ type: 'review.created', review });
      return review;
    });
  }

  listReviews(runId: string): Review[] {
    return this.selectWhere(reviews, 'run_id = ?', 'created_at, id', runId);
  }

  // -- inbox ------------------------------------------------------------------------------------

  insertInboxItem<K extends InboxKind>(input: NewInboxItem<K>): InboxItem {
    return this.transaction(() => {
      const item = {
        id: newId('inbox'),
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        kind: input.kind,
        payload: input.payload,
        resolution: null,
        createdAt: this.now(),
        resolvedAt: null,
      } as InboxItem;
      this.insert(inbox, item);
      this.append({ type: 'inbox.updated', item });
      return item;
    });
  }

  getInboxItem(id: string): InboxItem | null {
    return this.select(inbox, id);
  }

  listInbox(filter: { runId: string | null; includeResolved: boolean }): InboxItem[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.runId !== null) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (!filter.includeResolved) where.push('resolved_at IS NULL');
    return this.selectWhere(inbox, where.length > 0 ? where.join(' AND ') : '1', 'created_at, id', ...params);
  }

  /** Resolve an open item (CAS on resolved_at IS NULL). The resolution kind must match the item. */
  resolveInboxItem(id: string, resolution: InboxResolution): InboxItem {
    return this.transaction(() => {
      const current = this.getInboxItem(id);
      if (!current) throw notFound('inbox item', id);
      if (current.kind !== resolution.kind) {
        throw new RpcError('bad_request', `inbox item ${id} is a ${current.kind}, got a ${resolution.kind} resolution`);
      }
      const { kind: _kind, ...stored } = resolution;
      const changed = this.run(
        'UPDATE inbox_items SET resolution = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
        JSON.stringify(stored),
        this.now(),
        id,
      );
      if (changed === 0) throw new RpcError('conflict', `inbox item ${id} is already resolved`);
      const item = this.getInboxItem(id);
      if (!item) throw notFound('inbox item', id);
      this.append({ type: 'inbox.updated', item });
      return item;
    });
  }

  // -- merges & verifications -------------------------------------------------------------------

  insertMerge(input: NewMerge): Merge {
    return this.transaction(() => {
      const merge: Merge = {
        id: newId('merge'),
        ...input,
        postSha: null,
        status: 'pending',
        error: null,
        createdAt: this.now(),
        endedAt: null,
      };
      this.insert(merges, merge);
      this.append({ type: 'merge.updated', merge });
      return merge;
    });
  }

  /** Finish a pending merge (CAS on status = 'pending'). */
  finishMerge(id: string, status: Exclude<Merge['status'], 'pending'>, patch: MergePatch = {}): Merge {
    return this.transaction(() => {
      const ok = this.patchRow(merges, id, { endedAt: this.now(), ...patch, status }, ['pending']);
      const merge = this.select(merges, id);
      if (!merge) throw notFound('merge', id);
      if (!ok) throw new RpcError('conflict', `merge ${id} is already ${merge.status}`);
      this.append({ type: 'merge.updated', merge });
      return merge;
    });
  }

  /** Mark a merged merge as reverted (integration reset to preSha after a failed post-merge verify). */
  revertMerge(id: string, error: string | null): Merge {
    return this.transaction(() => {
      const ok = this.patchRow(merges, id, { status: 'reverted', error } as Partial<Merge>, [
        'merged',
        'verify_failed',
      ]);
      const merge = this.select(merges, id);
      if (!merge) throw notFound('merge', id);
      if (!ok) throw new RpcError('conflict', `merge ${id} is ${merge.status}`);
      this.append({ type: 'merge.updated', merge });
      return merge;
    });
  }

  listMerges(runId: string): Merge[] {
    return this.selectWhere(merges, 'run_id = ?', 'created_at, id', runId);
  }

  insertVerification(input: NewVerification): Verification {
    return this.transaction(() => {
      const verification: Verification = { id: newId('verification'), ...input, createdAt: this.now() };
      this.insert(verifications, verification);
      this.append({ type: 'verification.created', verification });
      return verification;
    });
  }

  listVerifications(runId: string): Verification[] {
    return this.selectWhere(verifications, 'run_id = ?', 'created_at, id', runId);
  }
}
