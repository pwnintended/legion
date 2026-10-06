/**
 * Orchestrator bookkeeping that is not part of the domain rows but must survive an engine restart:
 * stored as JSON in the `settings` key/value table (`run:<id>`, `task:<id>`).
 */
import type { ReviewCriterion, ReviewFinding } from '@shared/domain';
import type { Store } from '../db';
import type { ScopeReport, VerifyResultInput } from './core';

export interface RunMeta {
  /** Base commit the integration branch was created from. */
  baseSha: string | null;
  /** Planner session (clarify and plan steps resume it). */
  plannerSessionId: string | null;
  /** Clarify answers, with their questions. */
  answers: { question: string; answer: string }[];
  /** Integration worktree has had its copy/symlink/setup provisioning. */
  integrationReady: boolean;
  /** Per-run budget raised through a `budget` inbox answer (overrides settings). */
  budgetLimitUsd: number | null;
  budgetWarned: boolean;
  /** The `gc.auto` value before Legion disabled it (restored when the run ends). */
  gcAuto: string | null;
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
  /** Files the task changed (for dependents' upstream summaries). */
  files: string[];
  fix: FixContext | null;
  /** Failure summary / human note for the next fresh attempt's prompt. */
  previousFailure: string | null;
  lastVerify: VerifyResultInput[];
  scope: ScopeReport | null;
  /** Reviews of the current attempt (ids), oldest first. */
  reviewIds: string[];
  /** Consecutive reviewer sessions that failed to produce a review. */
  reviewFailures: number;
  resolverAttempts: number;
  resolverFailure: string | null;
}

const RUN_DEFAULTS: RunMeta = {
  baseSha: null,
  plannerSessionId: null,
  answers: [],
  integrationReady: false,
  budgetLimitUsd: null,
  budgetWarned: false,
  gcAuto: null,
};

const TASK_DEFAULTS: TaskMeta = {
  coderSessionId: null,
  report: null,
  files: [],
  fix: null,
  previousFailure: null,
  lastVerify: [],
  scope: null,
  reviewIds: [],
  reviewFailures: 0,
  resolverAttempts: 0,
  resolverFailure: null,
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
