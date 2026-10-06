/**
 * Run-level actions shared by the palette, the rail and tiles: archive a finished run, refresh its PR state.
 * Both procedures are new on the engine side, so they are called through `callOptional` (see compat.ts).
 */
import type { Run } from '@shared/domain';
import type { ProcedureName, RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { isArchived } from './compat';
import { selectRunList } from './data';
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
function applyRun(row: Run): void {
  dataStore.setState((s) => ({ runs: { ...s.runs, [row.id]: row } }));
}

/** Archive a finished run: the engine removes its worktrees and hides it from the rail. */
export async function archiveRun(runId: string): Promise<void> {
  const result = await callOptional('runs.archive', { runId });
  const current = dataStore.getState().runs[runId];
  const row = looksLikeRun(result, runId) ? result : current;
  if (row) applyRun(isArchived(row) ? row : ({ ...row, archived: true } as Run));
  if (uiStore.getState().activeRunId === runId) {
    const next = selectRunList(dataStore.getState())[0];
    actions.setActiveRun(next?.id ?? null);
  }
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
