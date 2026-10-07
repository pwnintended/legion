/**
 * Run-level actions shared by the palette, the rail and tiles: archive a run (with a confirm when it is still
 * active, and a report of what was kept), refresh its PR state. Both procedures are newer on the engine
 * side, so they are called through `callOptional` (older engines answer with a readable error).
 */
import type { Run } from '@shared/domain';
import type { ArchiveReport, ProcedureName, RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { toast } from '../overlays/nav';
import { isArchived } from './compat';
import { confirmAction } from './confirm';
import { applyRunRow, selectRunList } from './data';
import { actions, dataStore, uiStore } from './store';
import { getClient, getSync } from './sync';

/** Call a procedure this build's contract may not know yet. Unknown procedures reject with a readable message. */
export async function callOptional(method: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    return await getClient().call(method as ProcedureName, input as RpcInput<ProcedureName>);
  } catch (error) {
    const unknown =
      error instanceof RpcError &&
      (error.code === 'not_implemented' || (error.code === 'not_found' && /unknown method/i.test(error.message)));
    if (unknown) throw new Error(`This engine version doesn't support ${method} yet.`);
    throw error;
  }
}

function looksLikeRun(value: unknown, runId: string): value is Run {
  return !!value && typeof value === 'object' && (value as { id?: unknown }).id === runId && 'status' in value;
}

/** Put a run row returned by a procedure into the store (the matching event may arrive later). */
export function adoptRun(row: Run): void {
  const atSeq = getClient().seq;
  dataStore.setState((s) => applyRunRow(s, row, atSeq), true);
}
const applyRun = adoptRun;

/** `runs.archive`'s report, read defensively (absent on older engines). */
export function archiveReportOf(result: unknown): ArchiveReport {
  const report = (result as { archiveReport?: unknown } | null)?.archiveReport as Partial<ArchiveReport> | null;
  const kept = Array.isArray(report?.kept)
    ? report.kept.filter(
        (k): k is ArchiveReport['kept'][number] =>
          !!k && typeof k === 'object' && typeof k.name === 'string' && typeof k.reason === 'string',
      )
    : [];
  const problems = Array.isArray(report?.problems)
    ? report.problems.filter((p): p is string => typeof p === 'string')
    : [];
  return { kept, problems };
}

/**
 * Archive a run: the engine removes its worktrees and branches (keeping those with work found nowhere
 * else, see the report) and hides it from the rail. An active run is refused (`failed_precondition`) unless
 * `force`, which cancels it first.
 */
export async function archiveRun(runId: string, force = false, discard = false): Promise<ArchiveReport> {
  const result = await callOptional('runs.archive', {
    runId,
    ...(force ? { force: true } : {}),
    ...(discard ? { discard: true } : {}),
  });
  const current = dataStore.getState().runs[runId];
  let row: Run | undefined = current;
  if (looksLikeRun(result, runId)) {
    const { archiveReport: _, ...run } = result as Run & { archiveReport?: unknown };
    row = run as Run;
  }
  if (row) applyRun(isArchived(row) ? row : ({ ...row, archived: true } as Run));
  if (uiStore.getState().activeRunId === runId) {
    const next = selectRunList(dataStore.getState())[0];
    actions.setActiveRun(next?.id ?? null);
  }
  return archiveReportOf(result);
}

/**
 * Stop a run for good (`runs.cancel`) after a confirm: every agent of the run stops, its tasks are cancelled and
 * its open inbox items dismissed. Worktrees and branches stay until the run is archived. False when declined.
 */
export async function stopRunInteractively(run: Pick<Run, 'id' | 'title'>): Promise<boolean> {
  const ok = await confirmAction({
    title: `Stop “${run.title}”?`,
    body: [
      'Every agent of this run stops now: the assistant, the planner or lead, coders and reviewers. Unfinished tasks are cancelled and what waits in the inbox for this run is dismissed.',
      'Merged work, worktrees and branches stay; archive the run afterwards to clean them up. A stopped run cannot be resumed (Pause can).',
    ],
    confirmLabel: 'Stop run',
    tone: 'danger',
  });
  if (!ok) return false;
  applyRun(await getClient().call('runs.cancel', { runId: run.id }));
  return true;
}

/** The engine refused because the run is still active. */
export function isActiveRunRefusal(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'failed_precondition';
}

/** Lines describing what archiving kept, and what went wrong. */
export function describeArchiveReport(report: ArchiveReport): string[] {
  return [
    ...report.kept.map((k) => `kept ${k.kind} ${k.name}: ${k.reason}`),
    ...report.problems.map((p) => `problem: ${p}`),
  ];
}

/**
 * The archive action of the rail, the palette and the PR tile. When the engine refuses because the run is
 * still active, asks (explaining what is cancelled, removed and kept) before archiving with `force`.
 * Afterwards shows what was kept and any cleanup problems. Resolves false when the user backed out.
 */
export async function archiveRunInteractively(run: Pick<Run, 'id' | 'title' | 'status'>): Promise<boolean> {
  let report: ArchiveReport;
  try {
    report = await archiveRun(run.id);
  } catch (error) {
    if (!isActiveRunRefusal(error)) throw error;
    const ok = await confirmAction({
      title: `Cancel “${run.title}” and archive it?`,
      body: [
        `The run is still ${run.status.replace(/_/g, ' ')}. Archiving it cancels the run first: its agents and terminals stop, open questions close.`,
        'Its worktrees and task branches are then removed, including uncommitted changes and work that was never merged. The integration branch is kept, and so is a pull request on GitHub.',
      ],
      confirmLabel: 'Cancel run and archive',
      cancelLabel: 'Keep the run',
      tone: 'danger',
    });
    if (!ok) return false;
    report = await archiveRun(run.id, true);
  }
  const lines = describeArchiveReport(report);
  if (lines.length === 0) {
    toast(`Archived “${run.title}”. Its worktrees are cleaned up.`);
    return true;
  }
  // The report is not part of archiving: answered later, it may still remove what was kept.
  void confirmAction({
    title: `Archived “${run.title}”`,
    body: [
      report.problems.length
        ? 'Some cleanup did not go through, and what holds work found nowhere else was kept:'
        : 'Kept because they hold work found nowhere else:',
      'Remove all of it to delete these worktrees and branches too, unmerged work included. Nothing on GitHub is touched.',
    ],
    items: lines,
    confirmLabel: 'Remove all of it',
    cancelLabel: 'Keep them',
    tone: 'danger',
  }).then((removeAll) =>
    removeAll
      ? discardLeftovers(run).catch((error: unknown) =>
          toast(`Couldn't remove the run's leftovers: ${(error as Error).message}`, 'error'),
        )
      : undefined,
  );
  return true;
}

/**
 * Remove everything an archived run left on disk (`runs.archive` with `discard`): kept worktrees, task branches
 * with unmerged work and the integration branch. The remote is never touched.
 */
async function discardLeftovers(run: Pick<Run, 'id' | 'title'>): Promise<void> {
  const report = await archiveRun(run.id, false, true);
  const left = describeArchiveReport(report);
  if (left.length === 0) {
    toast(`Removed everything “${run.title}” left behind.`);
    return;
  }
  void confirmAction({
    title: `Some of “${run.title}” is still there`,
    body: ['These could not be removed. If Legion was started before this option existed, restart it and try again.'],
    items: left,
    confirmLabel: 'OK',
    cancelLabel: null,
  });
}

/** For an archived run, from the sidebar or the palette: confirm, then remove everything it left on disk. */
export async function discardRunInteractively(run: Pick<Run, 'id' | 'title'>): Promise<boolean> {
  const ok = await confirmAction({
    title: `Remove everything “${run.title}” left?`,
    body: [
      'Deletes the worktrees and branches Legion kept when the run was archived: uncommitted changes, task work that was never merged and the integration branch.',
      'Pushed branches and pull requests on GitHub stay. This cannot be undone.',
    ],
    confirmLabel: 'Remove all of it',
    tone: 'danger',
  });
  if (!ok) return false;
  await discardLeftovers(run);
  return true;
}

/** Ask the engine to re-read the PR's state from GitHub. */
export async function refreshPr(runId: string): Promise<void> {
  const result = await callOptional('runs.refreshPr', { runId });
  if (looksLikeRun(result, runId)) applyRun(result);
  else if (result && typeof result === 'object' && looksLikeRun((result as { run?: unknown }).run, runId))
    applyRun((result as { run: Run }).run);
}

/** Refetch the run list (e.g. after toggling "Show archived"). */
export function reloadRuns(): void {
  void getSync()?.refresh();
}
