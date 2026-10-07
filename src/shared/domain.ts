/**
 * Legion's domain model (docs/architecture.md §5): zod schemas are the source of truth, types are
 * inferred from them. Conventions:
 * - timestamps are epoch milliseconds (integers);
 * - absent values are `null`, never `undefined` (rows, RPC payloads and agent schemas all agree);
 * - status changes are only legal along the `*_TRANSITIONS` tables below and are applied with
 *   compare-and-set in the engine's repository layer, which appends an event in the same transaction.
 */
import { z } from 'zod';
import { AttachmentRefSchema } from './attachments';
import { IdSchema, NodeIdSchema } from './ids';

// ---------------------------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------------------------

export const ENGINE_KINDS = ['claude', 'codex', 'fake'] as const;
export const EngineKindSchema = z.enum(ENGINE_KINDS);
export type EngineKind = z.infer<typeof EngineKindSchema>;

/** Engines a plan may assign to a node (the fake engine is only for tests/demo mode). */
export const REAL_ENGINE_KINDS = ['claude', 'codex'] as const;
export const RealEngineKindSchema = z.enum(REAL_ENGINE_KINDS);
export type RealEngineKind = z.infer<typeof RealEngineKindSchema>;

/**
 * `lead`: the run's coordinator after plan approval (coordinate mode: talks, never touches files).
 * `researcher`: read-only + web, answers one brief with a research report. `research_lead`: coordinate + web, fans
 * a brief out to researchers and synthesises their reports.
 */
export const ROLES = [
  'planner',
  'coder',
  'reviewer',
  'resolver',
  'finalizer',
  'lead',
  'researcher',
  'research_lead',
  'assistant',
] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Normalized reasoning effort; adapters map it onto each CLI's own scale. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

export const TimestampSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------------------------
// Status machines
// ---------------------------------------------------------------------------------------------

export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}

export function isTerminal<S extends string>(table: TransitionTable<S>, status: S): boolean {
  return table[status].length === 0;
}

export const RUN_STATUSES = [
  'chatting',
  'draft',
  'clarifying',
  'planning',
  'awaiting_approval',
  'executing',
  'integrating',
  'finalizing',
  'pr_ready',
  'done',
  'failed',
  'cancelled',
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Run lifecycle. `paused` is a separate flag, not a status.
 * - integrating: every task is terminal; full verify on the integration branch.
 * - finalizing: final holistic review over base...integration.
 * - pr_ready: waiting for the human PR gate; `runs.createPr` pushes and opens the draft PR → done.
 */
export const RUN_TRANSITIONS: TransitionTable<RunStatus> = {
  // chatting: a conversation with the assistant (§8.6); `start_implementation` moves it on.
  chatting: ['clarifying', 'planning', 'done', 'failed', 'cancelled'],
  draft: ['clarifying', 'planning', 'failed', 'cancelled'],
  clarifying: ['planning', 'failed', 'cancelled'],
  planning: ['clarifying', 'awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['planning', 'executing', 'failed', 'cancelled'],
  executing: ['integrating', 'failed', 'cancelled'],
  integrating: ['executing', 'finalizing', 'failed', 'cancelled'],
  finalizing: ['executing', 'pr_ready', 'failed', 'cancelled'],
  pr_ready: ['finalizing', 'done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export const TASK_STATUSES = [
  'blocked',
  'queued',
  'provisioning',
  'running',
  'verifying',
  'reviewing',
  'fixing',
  'approved',
  'awaiting_human',
  'merging',
  'merged',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Task lifecycle (architecture §8 step 6).
 * blocked: deps not merged yet. queued: ready, waiting for a concurrency slot.
 * `→ queued` from running/provisioning/failed/awaiting_human is a retry (new attempt).
 * merging → fixing: post-merge verify failed or conflict; the task goes back to its coder.
 */
export const TASK_TRANSITIONS: TransitionTable<TaskStatus> = {
  blocked: ['queued', 'skipped', 'cancelled'],
  queued: ['blocked', 'provisioning', 'skipped', 'cancelled'],
  provisioning: ['queued', 'running', 'failed', 'cancelled'],
  running: ['queued', 'verifying', 'awaiting_human', 'failed', 'cancelled'],
  verifying: ['reviewing', 'fixing', 'awaiting_human', 'failed', 'cancelled'],
  reviewing: ['approved', 'fixing', 'awaiting_human', 'failed', 'cancelled'],
  fixing: ['verifying', 'awaiting_human', 'failed', 'cancelled'],
  approved: ['merging', 'awaiting_human', 'cancelled'],
  awaiting_human: ['queued', 'running', 'reviewing', 'fixing', 'approved', 'merging', 'failed', 'skipped', 'cancelled'],
  merging: ['merged', 'fixing', 'awaiting_human', 'failed', 'cancelled'],
  merged: [],
  failed: ['queued', 'skipped', 'cancelled'],
  skipped: [],
  cancelled: [],
};

export const ATTEMPT_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'] as const;
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/** `interrupted` = process died with the engine (recovery, §9); it may be resumed → running. */
export const ATTEMPT_TRANSITIONS: TransitionTable<AttemptStatus> = {
  pending: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'interrupted', 'cancelled'],
  interrupted: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------------------------
// Plan / DAG
// ---------------------------------------------------------------------------------------------

export const TASK_KINDS = ['contracts', 'feature', 'test', 'refactor', 'docs', 'integration'] as const;
export const TaskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskSizeSchema = z.enum(['S', 'M', 'L']);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

export const RiskSchema = z.enum(['low', 'med', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

export const TouchModeSchema = z.enum(['create', 'modify', 'read']);
export type TouchMode = z.infer<typeof TouchModeSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).describe('Stable id within the node, e.g. "AC1".'),
  text: z.string().min(1),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TouchSchema = z.object({
  glob: z.string().min(1).describe('Repo-relative path or glob the task will touch.'),
  mode: TouchModeSchema,
});
export type Touch = z.infer<typeof TouchSchema>;

export const NodeAgentSchema = z.object({
  engine: EngineKindSchema,
  model: z.string().nullable(),
  effort: EffortSchema.nullable(),
});
export type NodeAgent = z.infer<typeof NodeAgentSchema>;

export const TaskNodeSchema = z.object({
  id: NodeIdSchema,
  title: z.string().min(1),
  goal: z.string().min(1),
  kind: TaskKindSchema,
  dependsOn: z.array(NodeIdSchema),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  touches: z.array(TouchSchema),
  size: TaskSizeSchema,
  verify: z.object({ commands: z.array(z.string().min(1)) }),
  contextHints: z.object({ files: z.array(z.string()), notes: z.string() }),
  agent: NodeAgentSchema,
  risk: RiskSchema,
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const PLAN_ANNOTATION_KINDS = [
  'serializing_edge',
  'large_node',
  'missing_verify',
  'cost_estimate',
  'note',
] as const;
export const PlanAnnotationSchema = z.object({
  kind: z.enum(PLAN_ANNOTATION_KINDS),
  /** For serializing_edge: [from, to] (to now depends on from). Otherwise the affected nodes. */
  nodeIds: z.array(NodeIdSchema),
  message: z.string(),
});
export type PlanAnnotation = z.infer<typeof PlanAnnotationSchema>;

/** The validated DAG. Edges are the nodes' `dependsOn`; annotations are added by `orchestrator/dag.ts`. */
export const PlanDagSchema = z.object({
  nodes: z.array(TaskNodeSchema),
  annotations: z.array(PlanAnnotationSchema),
});
export type PlanDag = z.infer<typeof PlanDagSchema>;

export const PlanSourceSchema = z.enum(['agent', 'user']);

export const PlanSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  version: z.number().int().positive(),
  markdown: z.string(),
  dag: PlanDagSchema,
  /** `user` when created by `runs.updatePlan` (human edit), `agent` when produced by the planner. */
  source: PlanSourceSchema,
  /** Revision feedback that produced this version (from `runs.requestPlanRevision`), if any. */
  feedback: z.string().nullable(),
  createdAt: TimestampSchema,
  approvedAt: TimestampSchema.nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------------------------
// Runtime entities
// ---------------------------------------------------------------------------------------------

export const PR_STATES = ['open', 'closed', 'merged'] as const;
export const PrStateSchema = z.enum(PR_STATES);
export type PrState = z.infer<typeof PrStateSchema>;

/** The run's draft PR as last seen on the host (`runs.createPr`, refreshed by `runs.refreshPr` and polling). */
export const PullRequestSchema = z.object({
  url: z.string(),
  number: z.number().int().nonnegative(),
  state: PrStateSchema,
  isDraft: z.boolean(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** The coder's final report of a task (structured task report or `mark_task_done`). */
export const TaskReportInfoSchema = z.object({ summary: z.string(), commitMessage: z.string() });
export type TaskReportInfo = z.infer<typeof TaskReportInfoSchema>;

/**
 * A repository the user works in (the rail's top level). `path` is the real path of the checkout's top level,
 * unique. Runs reference their project (`Run.projectId`); `runs.create` adds the project when needed.
 */
export const ProjectSchema = z.object({
  id: IdSchema,
  path: z.string(),
  name: z.string(),
  addedAt: TimestampSchema,
  lastOpenedAt: TimestampSchema.nullable(),
  pinned: z.boolean(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const RunSchema = z.object({
  id: IdSchema,
  repoPath: z.string(),
  /**
   * The run's project (migration 004; backfilled from `repoPath`). Null when the project was removed. Always
   * present on engine rows; optional in the type for older payloads and fixtures (see `pr`).
   */
  projectId: IdSchema.nullable().optional(),
  baseRef: z.string(),
  title: z.string(),
  issueText: z.string(),
  issueUrl: z.string().nullable(),
  status: RunStatusSchema,
  paused: z.boolean(),
  plannerEngine: EngineKindSchema,
  plannerModel: z.string().nullable(),
  /** `legion/<runShort>/integration`, set when execution starts. */
  integrationBranch: z.string().nullable(),
  /** Kept for compatibility; equals `pr.url` once a PR exists. */
  prUrl: z.string().nullable(),
  /**
   * The draft PR (null until `runs.createPr`). Always present on rows from the engine; optional in the
   * type only so older event-log payloads and fixtures stay valid (treat `undefined` as `null`).
   */
  pr: PullRequestSchema.nullable().optional(),
  /** Cleaned up and hidden from `runs.list` (`runs.archive`). Always present on engine rows (see `pr`). */
  archived: z.boolean().optional(),
  /** Files attached when the run was created (`runs.create`); optional like `pr`, absent = none. */
  attachments: z.array(AttachmentRefSchema).nullable().optional(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Run = z.infer<typeof RunSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  nodeId: NodeIdSchema,
  status: TaskStatusSchema,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  startSha: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  fixRounds: z.number().int().nonnegative(),
  mergedSha: z.string().nullable(),
  /** User override of the plan's `agent` (tasks.setEngine). */
  engineOverride: EngineKindSchema.nullable(),
  modelOverride: z.string().nullable(),
  effortOverride: EffortSchema.nullable(),
  /** Latest one-line status from the agent (`report_progress`). */
  progress: z.string().nullable(),
  /**
   * The coder's latest final report (null until the coder finished a turn with one; cleared when a fresh
   * attempt starts). Always present on engine rows; optional in the type for older payloads (see `Run.pr`).
   */
  report: TaskReportInfoSchema.nullable().optional(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const AttemptSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  taskId: IdSchema.nullable(),
  role: RoleSchema,
  engine: EngineKindSchema,
  model: z.string().nullable(),
  effort: EffortSchema.nullable(),
  /** Engine-native id (Claude session id / Codex thread id), known after `session_started`. */
  sessionId: z.string().nullable(),
  /**
   * The attempt this one reports to in the agent hierarchy (null = top level). Agents may only message
   * their parent and their children (`core/messaging.ts`). Always present on engine rows; optional in the type
   * for older event payloads.
   */
  parentAttemptId: IdSchema.nullable().optional(),
  status: AttemptStatusSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  costUsd: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

// ---------------------------------------------------------------------------------------------
// Agent messages (the mailbox between an attempt and its parent / children)
// ---------------------------------------------------------------------------------------------

/**
 * brief: work handed down (objective, output format, boundaries). question / answer: a blocking ask and its
 * reply (`replyTo` = the question). report: a child's final, condensed result. status: a non-blocking note.
 */
export const MESSAGE_KINDS = ['brief', 'question', 'answer', 'report', 'status'] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const AgentMessageSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  fromAttemptId: IdSchema,
  toAttemptId: IdSchema,
  kind: MessageKindSchema,
  /** Markdown. Kept short: transcripts never cross agents, only messages do. */
  body: z.string(),
  /** The message this one answers (answers always set it). */
  replyTo: IdSchema.nullable(),
  createdAt: TimestampSchema,
  /** When it reached the recipient's context (a blocked wait returned it, or a resumed prompt carried it). */
  deliveredAt: TimestampSchema.nullable(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const CriterionStatusSchema = z.enum(['met', 'unmet', 'unclear']);
export const FindingSeveritySchema = z.enum(['blocker', 'major', 'minor', 'nit']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;
export const ReviewVerdictSchema = z.enum(['approve', 'request_changes', 'reject_replan']);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewCriterionSchema = z.object({
  id: z.string().describe('Acceptance criterion id from the task node, e.g. "AC1".'),
  status: CriterionStatusSchema,
  evidence: z.string(),
});
export type ReviewCriterion = z.infer<typeof ReviewCriterionSchema>;

export const ReviewFindingSchema = z.object({
  severity: FindingSeveritySchema,
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  suggestedFix: z.string().nullable(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  /** null = final holistic review of the run. */
  taskId: IdSchema.nullable(),
  attemptId: IdSchema,
  verdict: ReviewVerdictSchema,
  criteria: z.array(ReviewCriterionSchema),
  findings: z.array(ReviewFindingSchema),
  summary: z.string(),
  createdAt: TimestampSchema,
});
export type Review = z.infer<typeof ReviewSchema>;

/** Approve iff every criterion is met and there are no blocker/major findings (§8). */
export function reviewPasses(review: Pick<Review, 'criteria' | 'findings'>): boolean {
  return (
    review.criteria.every((c) => c.status === 'met') &&
    !review.findings.some((f) => f.severity === 'blocker' || f.severity === 'major')
  );
}

export const VerificationPhaseSchema = z.enum(['setup', 'task', 'post_merge', 'final']);
export type VerificationPhase = z.infer<typeof VerificationPhaseSchema>;

/** One verify/setup command execution (node `verify.commands`, repo `legion.json` setup/verify). */
export const VerificationSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  taskId: IdSchema.nullable(),
  attemptId: IdSchema.nullable(),
  phase: VerificationPhaseSchema,
  command: z.string(),
  /** null = killed / timed out. */
  exitCode: z.number().int().nullable(),
  /** Last few KB of combined stdout/stderr. */
  outputTail: z.string(),
  durationMs: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
});
export type Verification = z.infer<typeof VerificationSchema>;

export const MergeStatusSchema = z.enum(['pending', 'merged', 'conflict', 'verify_failed', 'reverted']);
export type MergeStatus = z.infer<typeof MergeStatusSchema>;

/** One squash-merge of a task into the integration branch (§8 merge queue). */
export const MergeSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  taskId: IdSchema,
  /** Integration HEAD before the merge; reset target on failure (§9). */
  preSha: z.string(),
  postSha: z.string().nullable(),
  status: MergeStatusSchema,
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
});
export type Merge = z.infer<typeof MergeSchema>;

// ---------------------------------------------------------------------------------------------
// Approvals & inbox
// ---------------------------------------------------------------------------------------------

/**
 * A human decision on an agent's approval request.
 * Claude: allow → `{behavior:"allow", updatedInput}`; deny → `{behavior:"deny", message}`.
 * Codex: allow/once → accept, allow/session → acceptForSession, deny → decline (interrupt → cancel).
 */
export const ApprovalDecisionSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    scope: z.enum(['once', 'session']),
    /** Replacement tool input (Claude only); null = use the original input. */
    updatedInput: z.unknown().nullable(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    /** Also stop the current turn. */
    interrupt: z.boolean(),
  }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ClarifyQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  /** Suggested answers; empty = free text. */
  options: z.array(z.string()),
});
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>;

export const QuestionAnswerSchema = z.object({ questionId: z.string(), answer: z.string() });
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const INBOX_KINDS = [
  'approval',
  'question',
  'plan_signoff',
  'escalation',
  'pr_ready',
  'conflict',
  'budget',
] as const;
export const InboxKindSchema = z.enum(INBOX_KINDS);
export type InboxKind = z.infer<typeof InboxKindSchema>;

export const EscalationActionSchema = z.enum(['retry', 'skip', 'edit', 'abort']);

/**
 * Where a human `retry` picks an escalated task up without discarding its work: `code` = coder turn in the
 * existing worktree, `fix` = a fix round with a fresh fix budget, `review` = re-review, `merge` = back into
 * the merge queue with a fresh resolver budget.
 */
export const ResumeStepSchema = z.enum(['code', 'fix', 'review', 'merge']);
export type ResumeStep = z.infer<typeof ResumeStepSchema>;

/**
 * Answers to an escalation: the offered `actions`, plus `restart` (start over from scratch, like
 * `tasks.restart`) wherever `retry` is offered.
 */
export const EscalationResolutionActionSchema = z.enum([...EscalationActionSchema.options, 'restart']);

const inboxBase = {
  id: IdSchema,
  runId: IdSchema,
  taskId: IdSchema.nullable(),
  attemptId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
};

export const InboxPayloadSchemas = {
  approval: z.object({
    requestId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    reason: z.string().nullable(),
  }),
  question: z.object({
    /** clarify = planner's clarify step; agent = `request_human_input` / Codex user-input request. */
    source: z.enum(['clarify', 'agent']),
    questions: z.array(ClarifyQuestionSchema),
  }),
  plan_signoff: z.object({
    planId: IdSchema,
    version: z.number().int(),
    /** Set when the lead changes an approved plan mid-run: what changed and why it needs the human. */
    amendment: z.object({ change: z.string(), reason: z.string() }).nullish(),
  }),
  escalation: z.object({
    reason: z.enum([
      'attempts_exhausted',
      'fix_rounds_exhausted',
      'verify_failed',
      'review_rejected',
      'final_review',
      'other',
    ]),
    summary: z.string(),
    actions: z.array(EscalationActionSchema),
    /**
     * Task escalations whose work is kept: what `retry` resumes. Absent/null = `retry` starts over. `restart`
     * (resolution) or `tasks.restart` always starts over.
     */
    resume: ResumeStepSchema.nullish(),
  }),
  pr_ready: z.object({ integrationBranch: z.string(), title: z.string(), body: z.string() }),
  conflict: z.object({ files: z.array(z.string()), summary: z.string() }),
  budget: z.object({ spentUsd: z.number(), limitUsd: z.number() }),
} as const;

export const InboxResolutionSchemas = {
  approval: z.object({ decision: ApprovalDecisionSchema }),
  question: z.object({
    answers: z.array(QuestionAnswerSchema),
    /** Files attached to the answers (clarify); absent = none. */
    attachments: z.array(AttachmentRefSchema).nullish(),
  }),
  plan_signoff: z.object({ approved: z.boolean(), feedback: z.string().nullable() }),
  escalation: z.object({ action: EscalationResolutionActionSchema, note: z.string().nullable() }),
  pr_ready: z.object({ approved: z.boolean(), title: z.string().nullable(), body: z.string().nullable() }),
  conflict: z.object({ action: z.enum(['retry', 'skip', 'abort']), note: z.string().nullable() }),
  budget: z.object({ action: z.enum(['raise', 'stop']), newLimitUsd: z.number().nullable() }),
} as const;

function inboxVariant<K extends InboxKind>(kind: K) {
  return z.object({
    ...inboxBase,
    kind: z.literal(kind),
    payload: InboxPayloadSchemas[kind],
    resolution: InboxResolutionSchemas[kind].nullable(),
  });
}

export const InboxItemSchema = z.discriminatedUnion('kind', [
  inboxVariant('approval'),
  inboxVariant('question'),
  inboxVariant('plan_signoff'),
  inboxVariant('escalation'),
  inboxVariant('pr_ready'),
  inboxVariant('conflict'),
  inboxVariant('budget'),
]);
export type InboxItem = z.infer<typeof InboxItemSchema>;
export type InboxItemOf<K extends InboxKind> = Extract<InboxItem, { kind: K }>;
export type InboxPayload<K extends InboxKind> = z.infer<(typeof InboxPayloadSchemas)[K]>;

/** Resolution as sent by the UI (`inbox.resolve`): tagged with the item kind. */
export const InboxResolutionSchema = z.discriminatedUnion('kind', [
  InboxResolutionSchemas.approval.extend({ kind: z.literal('approval') }),
  InboxResolutionSchemas.question.extend({ kind: z.literal('question') }),
  InboxResolutionSchemas.plan_signoff.extend({ kind: z.literal('plan_signoff') }),
  InboxResolutionSchemas.escalation.extend({ kind: z.literal('escalation') }),
  InboxResolutionSchemas.pr_ready.extend({ kind: z.literal('pr_ready') }),
  InboxResolutionSchemas.conflict.extend({ kind: z.literal('conflict') }),
  InboxResolutionSchemas.budget.extend({ kind: z.literal('budget') }),
]);
export type InboxResolution = z.infer<typeof InboxResolutionSchema>;

// ---------------------------------------------------------------------------------------------
// Event log row (append-only). Payloads are `ServerEventBody` values, see events.ts.
// ---------------------------------------------------------------------------------------------

export const EventRowSchema = z.object({
  seq: z.number().int().positive(),
  ts: TimestampSchema,
  runId: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  attemptId: IdSchema.nullable(),
  type: z.string(),
  payload: z.unknown(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export const RoleDefaultsSchema = z.object({
  engine: EngineKindSchema,
  /** Model per engine (the reviewer engine depends on the coder, so both are configured). null = CLI default. */
  models: z.object({ claude: z.string().nullable(), codex: z.string().nullable() }),
  effort: EffortSchema.nullable(),
});
export type RoleDefaults = z.infer<typeof RoleDefaultsSchema>;

export const EngineSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Binary path; null = resolve from PATH. Changes take effect for new sessions without a restart. */
  path: z.string().nullable(),
  /**
   * Reviewer/finalizer model when this engine has to review its own coders' work (the other engine is
   * unavailable). If it matches the coder's model, Legion picks a different one (opus ↔ sonnet, or another
   * model from the engine's probe). null = pick automatically.
   */
  fallbackReviewModel: z.string().nullable(),
});
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

export const SettingsSchema = z.object({
  concurrency: z.object({
    /** Max concurrently running agent sessions across all runs (default 3). */
    global: z.number().int().min(1).max(32),
    perEngine: z.object({
      claude: z.number().int().min(0).max(32),
      codex: z.number().int().min(0).max(32),
      fake: z.number().int().min(0).max(32),
    }),
  }),
  roles: z.object({
    planner: RoleDefaultsSchema,
    coder: RoleDefaultsSchema,
    reviewer: RoleDefaultsSchema,
    resolver: RoleDefaultsSchema,
    finalizer: RoleDefaultsSchema,
    lead: RoleDefaultsSchema,
    researcher: RoleDefaultsSchema,
    research_lead: RoleDefaultsSchema,
    assistant: RoleDefaultsSchema,
  }),
  lead: z.object({
    /** Open an implementation lead for every run once its plan is approved (`orchestrator/lead.ts`). */
    enabled: z.boolean(),
  }),
  assistant: z.object({
    /** The composer talks to an assistant (`runs.chat`) instead of starting the planner directly. */
    enabled: z.boolean(),
  }),
  permissions: z.object({
    /**
     * What coders and resolvers would ask the human (commands outside the task's verify list, ...): `auto` lets
     * the engine's own automatic review decide (Claude auto mode, Codex approve-for-me), `ask` sends each one
     * to the inbox. Changing it also switches running Claude sessions.
     */
    approvals: z.enum(['ask', 'auto']),
  }),
  budget: z.object({
    /** Per-run spend limit in USD (estimates); null = unlimited. Crossing it raises a `budget` inbox item. */
    perRunUsd: z.number().positive().nullable(),
    warnAtPct: z.number().int().min(1).max(100),
  }),
  limits: z.object({
    /** Extra attempts after the first one fails (§8: 2). */
    maxRetries: z.number().int().min(0).max(10),
    /** Fix rounds before escalating (§8: 2). */
    maxFixRounds: z.number().int().min(0).max(10),
    /** Conflict resolver attempts before escalating (§8: 2). */
    maxResolverAttempts: z.number().int().min(0).max(10),
  }),
  engines: z.object({
    claude: EngineSettingsSchema,
    codex: EngineSettingsSchema,
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

const roleDefaults = (engine: EngineKind): RoleDefaults => ({
  engine,
  models: { claude: null, codex: null },
  effort: null,
});

export const DEFAULT_SETTINGS: Settings = {
  concurrency: { global: 3, perEngine: { claude: 3, codex: 3, fake: 8 } },
  roles: {
    planner: roleDefaults('claude'),
    coder: roleDefaults('claude'),
    reviewer: roleDefaults('codex'),
    resolver: roleDefaults('claude'),
    finalizer: roleDefaults('codex'),
    lead: roleDefaults('claude'),
    researcher: roleDefaults('claude'),
    research_lead: roleDefaults('claude'),
    assistant: roleDefaults('claude'),
  },
  lead: { enabled: true },
  assistant: { enabled: true },
  permissions: { approvals: 'auto' },
  budget: { perRunUsd: null, warnAtPct: 80 },
  limits: { maxRetries: 2, maxFixRounds: 2, maxResolverAttempts: 2 },
  engines: {
    claude: { enabled: true, path: null, fallbackReviewModel: 'opus' },
    codex: { enabled: true, path: null, fallbackReviewModel: null },
  },
};

const RoleDefaultsPatchSchema = z
  .object({
    engine: EngineKindSchema,
    models: SettingsSchema.shape.roles.shape.planner.shape.models.partial(),
    effort: EffortSchema.nullable(),
  })
  .partial();

/** Deep-partial settings patch accepted by `settings.set`. */
export const SettingsPatchSchema = z
  .object({
    concurrency: z
      .object({
        global: SettingsSchema.shape.concurrency.shape.global,
        perEngine: SettingsSchema.shape.concurrency.shape.perEngine.partial(),
      })
      .partial(),
    roles: z
      .object({
        planner: RoleDefaultsPatchSchema,
        coder: RoleDefaultsPatchSchema,
        reviewer: RoleDefaultsPatchSchema,
        resolver: RoleDefaultsPatchSchema,
        finalizer: RoleDefaultsPatchSchema,
        lead: RoleDefaultsPatchSchema,
        researcher: RoleDefaultsPatchSchema,
        research_lead: RoleDefaultsPatchSchema,
        assistant: RoleDefaultsPatchSchema,
      })
      .partial(),
    lead: SettingsSchema.shape.lead.partial(),
    assistant: SettingsSchema.shape.assistant.partial(),
    permissions: SettingsSchema.shape.permissions.partial(),
    budget: SettingsSchema.shape.budget.partial(),
    limits: SettingsSchema.shape.limits.partial(),
    engines: z
      .object({
        claude: SettingsSchema.shape.engines.shape.claude.partial(),
        codex: SettingsSchema.shape.engines.shape.codex.partial(),
      })
      .partial(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

/** Apply a patch and re-validate. Throws a ZodError if the result is invalid. */
export function applySettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse(deepMerge(base, patch));
}

/** Fill gaps in stored settings (e.g. after an upgrade added a field) from the defaults. */
export function normalizeSettings(stored: unknown): Settings {
  const merged = deepMerge(DEFAULT_SETTINGS, stored);
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
