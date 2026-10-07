/**
 * `gc.auto=0` while Legion runs use a repository (§9), reference-counted per repository: the user's own
 * value is saved once, when the first run acquires the repo, and restored when the last one releases it.
 * Persisted under `repo:<repoPath>` so an engine restart in between keeps the original value.
 */
import { isTerminal, RUN_TRANSITIONS, type Run } from '@shared/domain';
import { disableAutoGc, restoreGcAuto } from '../git';
import { patchRunMeta, runMeta } from './meta';
import type { Orchestrator } from './orchestrator';

export interface RepoGcMeta {
  /** A value is saved (some run disabled gc.auto and has not restored it yet). */
  saved: boolean;
  /** The user's `gc.auto` before Legion touched it (null = unset). */
  gcAuto: string | null;
  /** Runs holding the repo. */
  runs: string[];
}

const EMPTY: RepoGcMeta = { saved: false, gcAuto: null, runs: [] };

export function repoGcMeta(o: Orchestrator, repoPath: string): RepoGcMeta {
  return { ...EMPTY, ...(o.store.getMeta<Partial<RepoGcMeta>>(`repo:${repoPath}`) ?? {}) };
}

function setRepoGcMeta(o: Orchestrator, repoPath: string, meta: RepoGcMeta): void {
  o.store.setMeta(`repo:${repoPath}`, meta);
}

const chains = new Map<string, Promise<unknown>>();

/** One acquire/release at a time per repository (they read, then write, around git calls). */
function serialized<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(repoPath) ?? Promise.resolve()).then(fn, fn);
  const settled = next.catch(() => undefined);
  chains.set(repoPath, settled);
  void settled.then(() => {
    if (chains.get(repoPath) === settled) chains.delete(repoPath);
  });
  return next;
}

/** Disable `gc.auto` for `run` (saving the user's value if no other run holds the repo). Never throws. */
export function acquireRepo(o: Orchestrator, run: Pick<Run, 'id' | 'repoPath'>): Promise<void> {
  return serialized(run.repoPath, async () => {
    const meta = repoGcMeta(o, run.repoPath);
    let previous: string | null;
    try {
      previous = await disableAutoGc(run.repoPath);
    } catch (error) {
      o.log.warn(`could not disable gc.auto in ${run.repoPath}: ${(error as Error).message}`);
      return;
    }
    if (o.closed) return;
    setRepoGcMeta(o, run.repoPath, {
      saved: true,
      gcAuto: meta.saved ? meta.gcAuto : previous,
      runs: [...new Set([...meta.runs, run.id])],
    });
    patchRunMeta(o.store, run.id, { gcRepoManaged: true });
  });
}

const isActive = (o: Orchestrator, runId: string): boolean => {
  const run = o.store.getRun(runId);
  return run !== null && !isTerminal(RUN_TRANSITIONS, run.status);
};

/** `run` no longer needs the repo; the last holder restores the user's `gc.auto`. Never throws. */
export function releaseRepo(o: Orchestrator, run: Run): Promise<void> {
  return serialized(run.repoPath, async () => {
    if (!runMeta(o.store, run.id).gcRepoManaged) return releaseLegacy(o, run);
    const meta = repoGcMeta(o, run.repoPath);
    if (!meta.saved) return;
    const holders = meta.runs.filter((id) => id !== run.id && isActive(o, id));
    if (holders.length > 0) {
      setRepoGcMeta(o, run.repoPath, { ...meta, runs: holders });
      return;
    }
    try {
      await restoreGcAuto(run.repoPath, meta.gcAuto);
    } catch (error) {
      o.log.warn(`could not restore gc.auto in ${run.repoPath}: ${(error as Error).message}`);
      return;
    }
    if (!o.closed) setRepoGcMeta(o, run.repoPath, EMPTY);
  });
}

/** Runs approved before the per-repo bookkeeping saved the value in their own meta. */
async function releaseLegacy(o: Orchestrator, run: Run): Promise<void> {
  const others = o.store
    .listRuns()
    .filter((r) => r.id !== run.id && r.repoPath === run.repoPath && !isTerminal(RUN_TRANSITIONS, r.status));
  if (others.length > 0 || repoGcMeta(o, run.repoPath).saved) return;
  const meta = runMeta(o.store, run.id);
  if (meta.gcAuto === null && run.integrationBranch === null) return;
  await restoreGcAuto(run.repoPath, meta.gcAuto).catch((error: unknown) =>
    o.log.warn(`could not restore gc.auto in ${run.repoPath}: ${(error as Error).message}`),
  );
}
