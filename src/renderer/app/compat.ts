/**
 * Forward-compatible reads of engine fields and procedures that are being added in parallel (they may not exist
 * in this build's `shared/` yet): `Run.pr`, `Run.archived`, `Task.report`, `runs.archive`, `runs.refreshPr`,
 * `runs.list({ includeArchived })`. Pure readers that feature-detect and degrade: the PR tile falls back to
 * parsing `prUrl`, the review pack to the agent's last message. The calls live in run-actions.ts.
 */

export type PrState = 'open' | 'closed' | 'merged';

export interface PullRequestInfo {
  url: string;
  number: number | null;
  state: PrState;
  isDraft: boolean;
}

export interface TaskReport {
  summary: string;
  commitMessage: string;
}

function prNumberOf(url: string): number | null {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? Number(n) : null;
}

/** The run's pull request: `run.pr` when the engine provides it, else derived from `prUrl` (an open draft). */
export function runPr(run: unknown): PullRequestInfo | null {
  if (!run || typeof run !== 'object') return null;
  const r = run as { pr?: unknown; prUrl?: unknown };
  const pr = r.pr as Partial<PullRequestInfo> | null | undefined;
  if (pr && typeof pr === 'object' && typeof pr.url === 'string') {
    const state: PrState = pr.state === 'merged' || pr.state === 'closed' ? pr.state : 'open';
    return {
      url: pr.url,
      number: typeof pr.number === 'number' ? pr.number : prNumberOf(pr.url),
      state,
      isDraft: state === 'open' && pr.isDraft !== false,
    };
  }
  if (typeof r.prUrl === 'string' && r.prUrl)
    return { url: r.prUrl, number: prNumberOf(r.prUrl), state: 'open', isDraft: true };
  return null;
}

/** Archived runs are hidden from the rail unless "Show archived" is on. */
export function isArchived(run: unknown): boolean {
  if (!run || typeof run !== 'object') return false;
  const r = run as { archivedAt?: unknown; archived?: unknown };
  return (typeof r.archivedAt === 'number' && r.archivedAt > 0) || r.archived === true;
}

/** The coder's structured report (`mark_task_done` / task-report output), if the engine exposes it. */
export function taskReport(task: unknown): TaskReport | null {
  if (!task || typeof task !== 'object') return null;
  const report = (task as { report?: unknown }).report as Partial<TaskReport> | null | undefined;
  if (!report || typeof report !== 'object' || typeof report.summary !== 'string' || !report.summary.trim())
    return null;
  return {
    summary: report.summary,
    commitMessage: typeof report.commitMessage === 'string' ? report.commitMessage : '',
  };
}

/** A finished run can be archived (cleans its worktrees). */
export function canArchive(run: { status: string } | null | undefined): boolean {
  if (!run || isArchived(run)) return false;
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') return true;
  const pr = runPr(run);
  return pr !== null && pr.state !== 'open';
}
