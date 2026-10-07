/**
 * The renderer ↔ engine contract (architecture §10): one object mapping procedure name → zod input and
 * output. The engine validates both on the server side (`rpc-transport.ts`); the renderer gets static
 * types only.
 *
 * Adding a procedure: add an entry here (input/output schemas, `null`-not-`undefined` conventions), then
 * implement it in the engine with `server.implement('name', handler)`. Until implemented, the engine
 * answers with `RpcError('not_implemented')`.
 *
 * Push events are `ServerEvent` batches (see events.ts); a connection only receives them after
 * calling `subscribe`.
 */
import { z } from 'zod';
import {
  AttemptSchema,
  EffortSchema,
  EngineKindSchema,
  InboxItemSchema,
  InboxResolutionSchema,
  MergeSchema,
  PlanAnnotationSchema,
  PlanSchema,
  QuestionAnswerSchema,
  ReviewSchema,
  RunSchema,
  SettingsPatchSchema,
  SettingsSchema,
  TaskNodeSchema,
  TaskSchema,
  TaskStatusSchema,
  TimestampSchema,
  VerificationSchema,
} from './domain';
import { EngineInfoSchema } from './engine';
import { AgentEventSchema, ServerEventSchema } from './events';
import { IdSchema } from './ids';

// ---------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------

const Empty = z.object({});
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

const ByRun = z.object({ runId: IdSchema });
const ByTask = z.object({ taskId: IdSchema });
const ByAttempt = z.object({ attemptId: IdSchema });

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  engineVersion: z.string(),
  /** Versions of the engine's runtime (Electron utilityProcess or plain Node). */
  runtime: z.object({
    node: z.string(),
    electron: z.string().nullable(),
    platform: z.string(),
    arch: z.string(),
  }),
  pid: z.number().int(),
  dataDir: z.string(),
  dbPath: z.string(),
  schemaVersion: z.number().int(),
  startedAt: TimestampSchema,
  /** Head of the event log at the time of the call. */
  headSeq: z.number().int().nonnegative(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const RemoteSchema = z.object({ name: z.string(), url: z.string() });

export const RepoInspectionSchema = z.object({
  /** The path that was asked about. */
  path: z.string(),
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  /** Top-level directory of the work tree. */
  root: z.string().nullable(),
  /** null when HEAD is detached or the repo has no commits. */
  currentBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  /** origin/HEAD if known, else main/master if present, else the current branch. */
  defaultBranch: z.string().nullable(),
  remotes: z.array(RemoteSchema),
  /** owner/name parsed from the origin (or first) GitHub remote. */
  github: z.object({ owner: z.string(), name: z.string() }).nullable(),
  /** Tracked files modified (untracked files ignored). */
  dirty: z.boolean(),
  hasGh: z.boolean(),
  /** Parsed `legion.json` if present and valid (§9). */
  legionConfig: z
    .object({
      setup: z.array(z.string()).nullable(),
      verify: z.array(z.string()).nullable(),
      copy: z.array(z.string()).nullable(),
      symlink: z.array(z.string()).nullable(),
      highRiskGlobs: z.array(z.string()).nullable(),
      installCommand: z.string().nullable(),
    })
    .nullable(),
  /** Why the path is unusable, if it is. */
  error: z.string().nullable(),
});
export type RepoInspection = z.infer<typeof RepoInspectionSchema>;

export const RecentRepoSchema = z.object({
  path: z.string(),
  name: z.string(),
  lastUsedAt: TimestampSchema,
});
export type RecentRepo = z.infer<typeof RecentRepoSchema>;

export const RunSummarySchema = z.object({
  run: RunSchema,
  taskCounts: z.partialRecord(TaskStatusSchema, z.number().int().nonnegative()),
  openInbox: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** Everything the UI needs to render one run. `seq` = event-log head when the snapshot was read. */
export const RunSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  run: RunSchema,
  plans: z.array(PlanSchema),
  tasks: z.array(TaskSchema),
  attempts: z.array(AttemptSchema),
  reviews: z.array(ReviewSchema),
  inbox: z.array(InboxItemSchema),
  verifications: z.array(VerificationSchema),
  merges: z.array(MergeSchema),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const TranscriptEntrySchema = z.object({
  seq: z.number().int().positive(),
  ts: TimestampSchema,
  event: AgentEventSchema,
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const DiffTargetSchema = z.discriminatedUnion('kind', [
  /** The task's own changes: startSha..branch HEAD (or working tree while running). */
  z.object({ kind: z.literal('task'), taskId: IdSchema }),
  /** The whole run: base...integration. */
  z.object({ kind: z.literal('run'), runId: IdSchema }),
  /** Arbitrary range inside the run's repo. */
  z.object({ kind: z.literal('range'), runId: IdSchema, from: z.string(), to: z.string() }),
]);
export type DiffTarget = z.infer<typeof DiffTargetSchema>;

export const DiffLineSchema = z.object({
  kind: z.enum(['context', 'add', 'del', 'no_newline']),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const DiffHunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Text after the second `@@` (usually the enclosing function). */
  header: z.string(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  /** Previous path for renames/copies. */
  oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed']),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(DiffHunkSchema),
  /** Hunks omitted because the file diff was too large. */
  truncated: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  files: z.array(DiffFileSchema),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

/**
 * Terminals: the renderer creates a `MessageChannel` and transfers one port with `terminals.open`
 * (`call(..., { transfer: [port] })`). Raw PTY bytes flow over that port, not the RPC channel:
 * engine → renderer: `{ type: 'data', data: string }` | `{ type: 'exit', code: number | null }`;
 * renderer → engine: `{ type: 'input', data: string }`.
 */
export const TerminalTargetSchema = z.discriminatedUnion('kind', [
  /** A login shell in a directory (task worktree, integration worktree, repo). */
  z.object({ kind: z.literal('shell'), cwd: z.string() }),
  /** Take over an agent session: resume it interactively in its CLI inside a PTY. */
  z.object({ kind: z.literal('attempt'), attemptId: IdSchema }),
]);
export type TerminalTarget = z.infer<typeof TerminalTargetSchema>;

export const TerminalMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
  z.object({ type: z.literal('input'), data: z.string() }),
]);
export type TerminalMessage = z.infer<typeof TerminalMessageSchema>;

const TerminalSize = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };

const NullableModel = { model: z.string().nullable(), effort: EffortSchema.nullable() };

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

export const rpcContract = {
  // app & engines -------------------------------------------------------------------------------
  'app.info': { input: Empty, output: AppInfoSchema },
  /** Last known probe results (probes lazily on first call). */
  'engines.list': { input: Empty, output: z.array(EngineInfoSchema) },
  /** Re-probe one engine or all of them. */
  'engines.probe': {
    input: z.object({ kind: EngineKindSchema.nullable() }),
    output: z.array(EngineInfoSchema),
  },

  // settings ------------------------------------------------------------------------------------
  'settings.get': { input: Empty, output: SettingsSchema },
  /** Deep-merges the patch, validates, persists, emits `settings.updated`. */
  'settings.set': { input: SettingsPatchSchema, output: SettingsSchema },

  // repos ---------------------------------------------------------------------------------------
  /** Read-only inspection; a valid repo is also recorded in recent repos. */
  'repos.inspect': { input: z.object({ path: z.string().min(1) }), output: RepoInspectionSchema },
  'repos.recent': { input: Empty, output: z.array(RecentRepoSchema) },

  // runs ----------------------------------------------------------------------------------------
  /** Newest first; archived runs only with `includeArchived: true`. */
  'runs.list': {
    input: z.object({ includeArchived: z.boolean().nullish() }),
    output: z.array(RunSummarySchema),
  },
  'runs.get': { input: ByRun, output: RunSnapshotSchema },
  'runs.create': {
    input: z.object({
      repoPath: z.string().min(1),
      /** null = the repo's default branch. */
      baseRef: z.string().nullable(),
      /** null = derived from the issue. */
      title: z.string().nullable(),
      issueText: z.string(),
      issueUrl: z.string().nullable(),
      plannerEngine: EngineKindSchema,
      plannerModel: z.string().nullable(),
      skipClarify: z.boolean(),
    }),
    output: RunSchema,
  },
  'runs.answerClarify': {
    input: z.object({ runId: IdSchema, answers: z.array(QuestionAnswerSchema) }),
    output: RunSchema,
  },
  /** Human edit of the plan: stores a new plan version (source `user`) after DAG validation. */
  'runs.updatePlan': {
    input: z.object({
      runId: IdSchema,
      /** The version being edited; rejected with `conflict` if it is no longer the latest. */
      basePlanId: IdSchema,
      markdown: z.string(),
      nodes: z.array(TaskNodeSchema),
      /**
       * The edited DAG's annotations. Carries the human's DAG decisions across re-validation: an
       * `[overlap_accepted]` note (from `undoAutoEdge`) keeps that pair unserialized, a dropped
       * `serializing_edge` stays dropped. Absent/null = keep the base version's annotations.
       */
      annotations: z.array(PlanAnnotationSchema).nullish(),
    }),
    output: PlanSchema,
  },
  'runs.approvePlan': { input: z.object({ runId: IdSchema, planId: IdSchema }), output: RunSchema },
  'runs.requestPlanRevision': {
    input: z.object({ runId: IdSchema, planId: IdSchema, feedback: z.string().min(1) }),
    output: RunSchema,
  },
  'runs.pause': { input: ByRun, output: RunSchema },
  'runs.resume': { input: ByRun, output: RunSchema },
  'runs.cancel': { input: ByRun, output: RunSchema },
  /** Human PR gate: push the integration branch and open the draft PR. */
  'runs.createPr': {
    input: z.object({ runId: IdSchema, title: z.string().nullable(), body: z.string().nullable() }),
    output: z.object({ run: RunSchema, url: z.string() }),
  },
  /**
   * Re-read the run's PR from the host (`gh pr view`) and store it in `run.pr`. A merged or closed PR
   * finishes the run and archives it (cleanup, see `runs.archive`). The engine also polls open PRs.
   */
  'runs.refreshPr': { input: ByRun, output: RunSchema },
  /**
   * Clean up a run (§8 step 9) and hide it from `runs.list`: cancels it if still active, closes its
   * sessions and terminals, removes task worktrees + local task branches and the integration worktree
   * (the integration branch stays while a PR is open), restores `gc.auto`, sets `archived: true`.
   * Idempotent.
   */
  'runs.archive': { input: ByRun, output: RunSchema },

  // tasks ---------------------------------------------------------------------------------------
  'tasks.retry': {
    input: z.object({ taskId: IdSchema, note: z.string().nullable() }),
    output: TaskSchema,
  },
  /**
   * Start a failed / awaiting_human task over from scratch: fresh worktree from integration, fresh attempt
   * budget, the note (and the last error) as context for the new coder. `tasks.retry` instead resumes the
   * failed step when there is work to keep.
   */
  'tasks.restart': {
    input: z.object({ taskId: IdSchema, note: z.string().nullish() }),
    output: TaskSchema,
  },
  'tasks.skip': { input: ByTask, output: TaskSchema },
  'tasks.setEngine': {
    input: z.object({ taskId: IdSchema, engine: EngineKindSchema, ...NullableModel }),
    output: TaskSchema,
  },
  /** For `awaiting_human` tasks (high risk / escalations): approve for the merge queue. */
  'tasks.approveMerge': { input: ByTask, output: TaskSchema },
  /** Send human feedback to the coder session (→ fixing). */
  'tasks.requestChanges': {
    input: z.object({ taskId: IdSchema, feedback: z.string().min(1) }),
    output: TaskSchema,
  },

  // inbox ---------------------------------------------------------------------------------------
  'inbox.list': {
    input: z.object({ runId: IdSchema.nullable(), includeResolved: z.boolean() }),
    output: z.array(InboxItemSchema),
  },
  'inbox.resolve': {
    input: z.object({ itemId: IdSchema, resolution: InboxResolutionSchema }),
    output: InboxItemSchema,
  },

  // live sessions -------------------------------------------------------------------------------
  'sessions.send': {
    input: z.object({ attemptId: IdSchema, text: z.string().min(1), priority: z.enum(['now', 'next']) }),
    output: OkSchema,
  },
  'sessions.interrupt': { input: ByAttempt, output: OkSchema },
  /** Stop the structured session and resume it interactively in a PTY (see `terminals.open`). */
  'sessions.takeover': {
    input: z.object({ attemptId: IdSchema, ...TerminalSize }),
    output: z.object({ terminalId: IdSchema }),
  },

  // transcripts & diffs -------------------------------------------------------------------------
  'attempts.get': { input: ByAttempt, output: AttemptSchema },
  'attempts.transcript': {
    input: z.object({
      attemptId: IdSchema,
      /** Return events with seq > sinceSeq. */
      sinceSeq: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(5000),
    }),
    output: z.object({
      entries: z.array(TranscriptEntrySchema),
      /** True when more entries exist after the last returned one. */
      hasMore: z.boolean(),
    }),
  },
  'diff.get': {
    input: z.object({ target: DiffTargetSchema, contextLines: z.number().int().min(0).max(100) }),
    output: DiffResultSchema,
  },

  // terminals (transfer a MessagePort with `open`) -----------------------------------------------
  /**
   * Open a terminal, or re-attach to a live one: with `terminalId` (e.g. a detached shell, or the
   * terminal returned by `sessions.takeover`) the transferred port is attached to that terminal and
   * `target` is ignored. Absent/null `terminalId` = open (or, for an attempt target, find) by `target`.
   */
  'terminals.open': {
    input: z.object({ target: TerminalTargetSchema, ...TerminalSize, terminalId: IdSchema.nullish() }),
    output: z.object({ terminalId: IdSchema, pid: z.number().int() }),
  },
  'terminals.resize': { input: z.object({ terminalId: IdSchema, ...TerminalSize }), output: OkSchema },
  'terminals.close': { input: z.object({ terminalId: IdSchema }), output: OkSchema },

  // event stream --------------------------------------------------------------------------------
  /**
   * Start (or resume) the push stream for this connection. The engine replays events with
   * seq > sinceSeq when it still can (`replayed: true`); otherwise (`replayed: false`) the client must
   * refetch snapshots (`runs.list`, `runs.get`) and ignore events whose seq ≤ the snapshot's seq.
   * Either way, live events with seq > headSeq follow.
   */
  subscribe: {
    input: z.object({ sinceSeq: z.number().int().nonnegative() }),
    output: z.object({ headSeq: z.number().int().nonnegative(), replayed: z.boolean() }),
  },
} as const;

export type RpcContract = typeof rpcContract;
export type ProcedureName = keyof RpcContract;
export type RpcInput<P extends ProcedureName> = z.input<RpcContract[P]['input']>;
export type RpcOutput<P extends ProcedureName> = z.output<RpcContract[P]['output']>;

/** Push channel payload schema (engine → renderer). */
export const rpcEventSchema = ServerEventSchema;

/** Max events replayed by `subscribe` before falling back to `replayed: false`. */
export const MAX_REPLAY_EVENTS = 20_000;
