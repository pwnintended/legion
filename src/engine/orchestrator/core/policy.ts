/**
 * Task status decisions for the verify → review → fix loop, the merge step and the retry policy
 * (architecture §8 step 6). Each decision is a `path` of task statuses to apply in order with CAS
 * transitions (every step is legal in `TASK_TRANSITIONS`; an empty path = stay) plus counter updates.
 *
 * Counters: `Task.attemptCount` is incremented by the lifecycle when it starts a fresh coder attempt
 * (queued → provisioning). `Task.fixRounds` is incremented by the `patch` of a decision that enters
 * `fixing`. A fresh attempt resets `fixRounds` to 0.
 */
import {
  canTransition,
  type InboxPayload,
  type ResumeStep,
  type ReviewFinding,
  type Settings,
  TASK_TRANSITIONS,
  type Task,
  type TaskNode,
  type TaskStatus,
} from '@shared/domain';
import type { ReviewOutput } from '@shared/schemas';
import { highRiskGlobHits } from './dag';

export type Limits = Settings['limits'];
export type EscalationReason = InboxPayload<'escalation'>['reason'];
type TaskState = Pick<Task, 'status' | 'attemptCount' | 'fixRounds'>;

export type DecisionAction =
  | 'verify'
  | 'review'
  | 'fix'
  | 'approve'
  | 'merge'
  | 'resolve'
  | 'done'
  | 'retry'
  | 'requeue'
  | 'fail'
  | 'escalate'
  | 'skip'
  | 'cancel';

export type { ResumeStep };

export interface TaskDecision {
  readonly action: DecisionAction;
  readonly path: readonly TaskStatus[];
  readonly patch: { readonly attemptCount?: number; readonly fixRounds?: number };
  /** Set when the decision should raise an `escalation` inbox item. */
  readonly escalation: EscalationReason | null;
  readonly reason: string;
  /** For decisions that park the task in `awaiting_human`: the step a human retry resumes. */
  readonly resume?: ResumeStep;
}

const decision = (
  action: DecisionAction,
  path: readonly TaskStatus[],
  reason: string,
  extra: Partial<Pick<TaskDecision, 'patch' | 'escalation' | 'resume'>> = {},
): TaskDecision => ({
  action,
  path,
  reason,
  patch: extra.patch ?? {},
  escalation: extra.escalation ?? null,
  ...(extra.resume ? { resume: extra.resume } : {}),
});

/** Shortest legal status path (BFS over TASK_TRANSITIONS, preferring `via` as the first hop). */
export function taskStatusPath(from: TaskStatus, to: TaskStatus, via: readonly TaskStatus[] = []): TaskStatus[] | null {
  if (from === to) return [];
  if (canTransition(TASK_TRANSITIONS, from, to)) return [to];
  for (const hop of via) {
    if (canTransition(TASK_TRANSITIONS, from, hop) && canTransition(TASK_TRANSITIONS, hop, to)) return [hop, to];
  }
  const previous = new Map<TaskStatus, TaskStatus>();
  const queue: TaskStatus[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as TaskStatus;
    for (const next of TASK_TRANSITIONS[current]) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path: TaskStatus[] = [to];
        let step = current;
        while (step !== from) {
          path.unshift(step);
          step = previous.get(step) as TaskStatus;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

function pathOrThrow(from: TaskStatus, to: TaskStatus, via: readonly TaskStatus[] = []): TaskStatus[] {
  const path = taskStatusPath(from, to, via);
  if (!path) throw new Error(`no legal task transition path ${from} → ${to}`);
  return path;
}

export function maxAttempts(limits: Pick<Limits, 'maxRetries'>): number {
  return 1 + limits.maxRetries;
}

export function attemptsRemaining(task: Pick<Task, 'attemptCount'>, limits: Pick<Limits, 'maxRetries'>): number {
  return Math.max(0, maxAttempts(limits) - task.attemptCount);
}

/** High-risk nodes (risk: high, or writes matching `highRiskGlobs`) wait for a human after approval. */
export function requiresHumanGate(
  node: Pick<TaskNode, 'risk' | 'touches'>,
  highRiskGlobs: readonly string[] = [],
): boolean {
  return node.risk === 'high' || highRiskGlobHits(node, highRiskGlobs).length > 0;
}

/** What the fixer must address: blocker/major findings (minor/nit are recorded, not looped on). */
export function blockingFindings(review: Pick<ReviewOutput, 'findings'>): ReviewFinding[] {
  return review.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
}

/** Approve iff no `reject_replan`, every criterion met, no blocker/major (verdict text alone is not trusted). */
export function reviewApproves(review: Pick<ReviewOutput, 'verdict' | 'criteria' | 'findings'>): boolean {
  return (
    review.verdict !== 'reject_replan' &&
    review.criteria.every((c) => c.status === 'met') &&
    blockingFindings(review).length === 0
  );
}

function findingKey(f: ReviewFinding): string {
  return `${f.file ?? ''}|${f.title.trim().toLowerCase()}`;
}

function enterFixRound(task: TaskState, limits: Limits, reason: string, exhausted: EscalationReason): TaskDecision {
  if (task.fixRounds < limits.maxFixRounds) {
    return decision('fix', pathOrThrow(task.status, 'fixing'), reason, { patch: { fixRounds: task.fixRounds + 1 } });
  }
  return decision(
    'escalate',
    pathOrThrow(task.status, 'awaiting_human'),
    `${reason}; ${limits.maxFixRounds} fix round(s) used`,
    { escalation: exhausted, resume: 'fix' },
  );
}

export interface CoderTurnOutcome {
  /** From `mark_task_done` / the structured task report; null = the turn ended without either. */
  readonly report: { readonly status: 'done' | 'blocked' | 'partial' } | null;
  /** Files changed since `startSha` (after Legion's commit). */
  readonly changedFiles: number;
}

/** After a coder (running) or fixer (fixing) turn ends without a process error. */
export function decideAfterCoderTurn(task: TaskState, outcome: CoderTurnOutcome, limits: Limits): TaskDecision {
  if (outcome.report?.status === 'blocked') {
    return decision('escalate', pathOrThrow(task.status, 'awaiting_human'), 'the agent reported it is blocked', {
      escalation: 'other',
      resume: 'fix',
    });
  }
  if (outcome.report?.status === 'done' && (outcome.changedFiles > 0 || task.status === 'fixing')) {
    return decision('verify', pathOrThrow(task.status, 'verifying'), 'the agent reported done');
  }
  const why =
    outcome.report === null
      ? 'the turn ended without mark_task_done'
      : outcome.report.status === 'partial'
        ? 'the agent stopped with partial work'
        : 'the agent reported done without changing any file';
  return decideAfterFailure(task, { kind: 'agent_error', message: why }, limits);
}

/** After Legion ran the verify commands (and the scope check, if enforced as a gate). */
export function decideAfterVerify(task: TaskState, passed: boolean, limits: Limits): TaskDecision {
  if (passed) return decision('review', pathOrThrow(task.status, 'reviewing'), 'verification passed');
  return enterFixRound(task, limits, 'verification failed', 'verify_failed');
}

export interface ReviewContext {
  readonly node: Pick<TaskNode, 'risk' | 'touches'>;
  readonly highRiskGlobs?: readonly string[];
  /** Blocking findings of the previous review round, to detect oscillation. */
  readonly previousFindings?: readonly ReviewFinding[];
  /** Changed agent/CI/hook config or package scripts (`core/sensitive.ts`): always a human gate. */
  readonly sensitiveChanges?: readonly string[];
}

/** After the reviewer's structured output was validated. */
export function decideAfterReview(
  task: TaskState,
  review: Pick<ReviewOutput, 'verdict' | 'criteria' | 'findings'>,
  context: ReviewContext,
  limits: Limits,
): TaskDecision {
  if (review.verdict === 'reject_replan') {
    return decision('escalate', pathOrThrow(task.status, 'awaiting_human'), 'the reviewer asks for a re-plan', {
      escalation: 'review_rejected',
      resume: 'fix',
    });
  }
  if (reviewApproves(review)) {
    const sensitive = context.sensitiveChanges ?? [];
    const gate = requiresHumanGate(context.node, context.highRiskGlobs) || sensitive.length > 0;
    return decision(
      'approve',
      gate ? ['approved', 'awaiting_human'] : ['approved'],
      sensitive.length > 0
        ? `approved; changes ${sensitive.join(', ')} (agent/CI/hook config or scripts), so a human approves the merge`
        : gate
          ? 'approved; high-risk task waits for a human before merging'
          : 'approved',
      gate ? { resume: 'merge' } : {},
    );
  }
  const blocking = blockingFindings(review);
  const previous = new Set((context.previousFindings ?? []).map(findingKey));
  if (blocking.length > 0 && previous.size > 0 && blocking.every((f) => previous.has(findingKey(f)))) {
    return decision(
      'escalate',
      pathOrThrow(task.status, 'awaiting_human'),
      'the same findings came back after a fix round',
      { escalation: 'fix_rounds_exhausted', resume: 'fix' },
    );
  }
  const unmet = review.criteria.filter((c) => c.status !== 'met').length;
  const reason = `changes requested (${blocking.length} blocking finding(s), ${unmet} criterion/criteria not met)`;
  return enterFixRound(task, limits, reason, 'fix_rounds_exhausted');
}

/** Human decision on a high-risk gate (task in awaiting_human after approval). */
export function decideHumanGate(task: TaskState, approved: boolean): TaskDecision {
  if (approved) return decision('merge', pathOrThrow(task.status, 'merging'), 'approved by a human');
  // A human-requested round does not consume the automatic fix-round budget.
  return decision('fix', pathOrThrow(task.status, 'fixing'), 'sent back by a human');
}

export type MergeOutcome = 'merged' | 'conflict' | 'verify_failed';

/** After a merge-queue step for a task in `merging`. `resolverAttempts` = resolver sessions so far. */
export function decideAfterMerge(
  task: TaskState,
  outcome: MergeOutcome,
  resolverAttempts: number,
  limits: Limits,
): TaskDecision {
  if (outcome === 'merged') return decision('done', pathOrThrow(task.status, 'merged'), 'merged into integration');
  if (outcome === 'conflict') {
    if (resolverAttempts < limits.maxResolverAttempts) {
      return decision(
        'resolve',
        [],
        `merge conflict; resolver attempt ${resolverAttempts + 1} of ${limits.maxResolverAttempts}`,
      );
    }
    return decision('escalate', pathOrThrow(task.status, 'awaiting_human'), 'merge conflict could not be resolved', {
      escalation: 'other',
      resume: 'merge',
    });
  }
  return enterFixRound(task, limits, 'post-merge verification failed', 'verify_failed');
}

export type FailureKind =
  /** Engine rate limit: requeue without charging an attempt (the scheduler waits for the reset). */
  | 'rate_limited'
  /** Not logged in / auth expired: needs the human. */
  | 'auth'
  /** Process crashed, errored turn, invalid structured output, empty result... */
  | 'agent_error'
  /** Worktree / setup commands failed (not the agent's fault, still retried). */
  | 'provision_failed';

export interface Failure {
  readonly kind: FailureKind;
  readonly message: string;
}

/** Retry policy: at most `1 + maxRetries` attempts in total, then `failed` + escalation. */
export function decideAfterFailure(
  task: TaskState,
  failure: Failure,
  limits: Pick<Limits, 'maxRetries'>,
): TaskDecision {
  if (failure.kind === 'rate_limited') {
    return decision('requeue', pathOrThrow(task.status, 'queued', ['failed']), `rate limited: ${failure.message}`, {
      patch: { attemptCount: Math.max(0, task.attemptCount - 1), fixRounds: 0 },
    });
  }
  if (failure.kind === 'auth') {
    return decision(
      'escalate',
      pathOrThrow(task.status, 'awaiting_human', ['failed']),
      `engine auth: ${failure.message}`,
      {
        escalation: 'other',
        // Keep the work in the worktree: a retry runs the coder (or fixer) again where it stopped.
        ...(task.status === 'running'
          ? { resume: 'code' as const }
          : task.status === 'fixing'
            ? { resume: 'fix' as const }
            : {}),
      },
    );
  }
  if (task.attemptCount < maxAttempts(limits)) {
    return decision(
      'retry',
      pathOrThrow(task.status, 'queued', ['failed']),
      `attempt ${task.attemptCount} of ${maxAttempts(limits)} failed: ${failure.message}`,
      { patch: { fixRounds: 0 } },
    );
  }
  return decision(
    'fail',
    pathOrThrow(task.status, 'failed'),
    `all ${maxAttempts(limits)} attempts failed: ${failure.message}`,
    {
      escalation: 'attempts_exhausted',
    },
  );
}

export type EscalationAction = InboxPayload<'escalation'>['actions'][number] | 'restart';

/**
 * Apply a human's escalation answer to a failed / awaiting_human task. Retry and edit (after the caller
 * saved the edited node) start over with a fresh attempt budget; abort cancels the task (the caller
 * cancels the run).
 */
export function decideEscalation(task: TaskState, action: EscalationAction): TaskDecision {
  switch (action) {
    case 'retry':
    case 'edit':
    case 'restart':
      return decision('retry', pathOrThrow(task.status, 'queued', ['failed']), `human chose ${action}`, {
        patch: { attemptCount: 0, fixRounds: 0 },
      });
    case 'skip':
      return decision('skip', pathOrThrow(task.status, 'skipped'), 'human chose skip');
    case 'abort':
      return decision('cancel', pathOrThrow(task.status, 'cancelled'), 'human chose abort');
  }
}
