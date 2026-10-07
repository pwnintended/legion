/**
 * Orchestrator bookkeeping that is not part of the domain rows but must survive an engine restart:
 * stored as JSON in the `settings` key/value table (`run:<id>`, `task:<id>`).
 */
import type { AttachmentRef } from '@shared/attachments';
import type { ReviewCriterion, ReviewFinding } from '@shared/domain';
import type { Store } from '../db';
import type { ResumeStep, ScopeReport, VerifyResultInput } from './core';

export interface RunMeta {
  /** Base commit the integration branch was created from. */
  baseSha: string | null;
  /** Planner session (clarify and plan steps resume it). */
  plannerSessionId: string | null;
  /** Clarify answers, with their questions. */
  answers: { question: string; answer: string }[];
  /** Files attached to the clarify answers (sent with the plan prompt; coders and reviewers get them too). */
  answerAttachments: AttachmentRef[];
  /** Integration worktree has had its copy/symlink/setup provisioning. */
  integrationReady: boolean;
  /** Untracked files that provisioning (copy/symlink/setup) left in the integration worktree; cleaning keeps them. */
  integrationKeep: string[];
  /** Per-run budget raised through a `budget` inbox answer (overrides settings). */
  budgetLimitUsd: number | null;
  budgetWarned: boolean;
  /** Legacy (runs approved before `repo-gc.ts`): the `gc.auto` value before Legion disabled it. */
  gcAuto: string | null;
  /** `gc.auto` is reference-counted per repository (`repo-gc.ts`) for this run. */
  gcRepoManaged: boolean;
  /** The implementation lead (`lead.ts`): its current attempt and engine session, failures, and whether it was given up. */
  leadAttemptId: string | null;
  leadSessionId: string | null;
  leadFailures: number;
  leadDisabled: boolean;
  /** A plan version proposed by the lead that waits for, or just got, the human's answer. */
  amendment: {
    planId: string;
    version: number;
    reason: string;
    status: 'pending' | 'approved' | 'rejected';
    feedback: string | null;
  } | null;
}

export interface FixContext {
  findings: ReviewFinding[];
  unmetCriteria: ReviewCriterion[];
  failedVerify: VerifyResultInput[];
  humanNote: string | null;
  /** Post-merge failure: merge this ref into the task branch before fixing. */
  mergedIntegrationRef: string | null;
}

export interface TaskMeta {
  /** Coder session of the current (fresh) attempt; fix rounds resume it. */
  coderSessionId: string | null;
  /** Latest coder report (summary feeds reviewers, dependents and the PR). */
  report: { status: 'done' | 'blocked' | 'partial'; summary: string; commitMessage: string } | null;
  /** Untracked files provisioning left in the task worktree: never committed, kept when cleaning. */
  provisioned: string[];
  /** Files the task changed (for dependents' upstream summaries). */
  files: string[];
  fix: FixContext | null;
  /** Failure summary / human note for the next fresh attempt's prompt. */
  previousFailure: string | null;
  lastVerify: VerifyResultInput[];
  scope: ScopeReport | null;
  /** Sensitive changes found by the last verify (`core/sensitive.ts`). */
  sensitive: string[];
  /** Reviews of the current attempt (ids), oldest first. */
  reviewIds: string[];
  /** Consecutive reviewer sessions that failed to produce a review. */
  reviewFailures: number;
  resolverAttempts: number;
  resolverFailure: string | null;
  /** Step a human `retry` resumes while the task is `awaiting_human` (null = start over). */
  resumeStep: ResumeStep | null;
}

const RUN_DEFAULTS: RunMeta = {
  baseSha: null,
  plannerSessionId: null,
  answers: [],
  answerAttachments: [],
  integrationReady: false,
  integrationKeep: [],
  budgetLimitUsd: null,
  budgetWarned: false,
  gcAuto: null,
  gcRepoManaged: false,
  leadAttemptId: null,
  leadSessionId: null,
  leadFailures: 0,
  leadDisabled: false,
  amendment: null,
};

const TASK_DEFAULTS: TaskMeta = {
  coderSessionId: null,
  report: null,
  provisioned: [],
  files: [],
  fix: null,
  previousFailure: null,
  lastVerify: [],
  scope: null,
  sensitive: [],
  reviewIds: [],
  reviewFailures: 0,
  resolverAttempts: 0,
  resolverFailure: null,
  resumeStep: null,
};

export function runMeta(store: Store, runId: string): RunMeta {
  return { ...RUN_DEFAULTS, ...(store.getMeta<Partial<RunMeta>>(`run:${runId}`) ?? {}) };
}

export function patchRunMeta(store: Store, runId: string, patch: Partial<RunMeta>): RunMeta {
  const next = { ...runMeta(store, runId), ...patch };
  store.setMeta(`run:${runId}`, next);
  return next;
}

export function taskMeta(store: Store, taskId: string): TaskMeta {
  return { ...TASK_DEFAULTS, ...(store.getMeta<Partial<TaskMeta>>(`task:${taskId}`) ?? {}) };
}

export function patchTaskMeta(store: Store, taskId: string, patch: Partial<TaskMeta>): TaskMeta {
  const next = { ...taskMeta(store, taskId), ...patch };
  store.setMeta(`task:${taskId}`, next);
  return next;
}

/** State of a fresh coder attempt (keeps `previousFailure`, which feeds its prompt). */
export function freshAttemptMeta(previousFailure: string | null): Partial<TaskMeta> {
  return { ...TASK_DEFAULTS, previousFailure };
}
