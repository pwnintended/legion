/**
 * React hooks over the stores. This is the API tiles, overlays and chrome read data through:
 *
 *   const run = useRun(runId);                 const tasks = useRunTasks(runId);
 *   const task = useTask(taskId);              const node = useTaskNode(runId, task?.nodeId);
 *   const items = useInbox(runId);             const t = useTranscript(attemptId);  // fetches on demand
 *   const call = useRpc();  await call('inbox.resolve', { itemId, resolution });
 *
 * Every hook returns referentially stable values while the underlying data is unchanged.
 */
import type { Attempt, InboxItem, Plan, Review, Run, Task, TaskNode } from '@shared/domain';
import type { ProcedureName, RpcInput, RpcOutput } from '@shared/rpc';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { describeTile, type TileMeta } from '../layout/describe';
import type { LayoutTile, Workspace } from '../layout/tree';
import {
  attemptsOfRun,
  type DataState,
  type EnginesState,
  latestPlan,
  openInbox,
  plansOfRun,
  type RateLimit,
  reviewsOfRun,
  runCost,
  selectRunList,
  type Transcript,
  tasksOfRun,
} from './data';
import { dataStore, type UiState, uiStore } from './store';
import { getClient, getSync } from './sync';

export function useData<T>(selector: (state: DataState) => T): T {
  return useStore(dataStore, selector);
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector);
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export function useRuns(): Run[] {
  return useData(selectRunList);
}

export function useRun(runId: string | null | undefined): Run | null {
  return useData((s) => (runId ? (s.runs[runId] ?? null) : null));
}

export function useActiveRunId(): string | null {
  return useUi((s) => s.activeRunId);
}

export function useActiveRun(): Run | null {
  const runId = useActiveRunId();
  return useRun(runId);
}

/** True once the run's full snapshot (tasks, attempts, ...) is in the store. */
export function useRunLoaded(runId: string | null | undefined): boolean {
  return useData((s) => (runId ? s.loadedRuns[runId] !== undefined : false));
}

export function useRunCost(runId: string | null | undefined): number {
  return useData((s) => (runId ? runCost(s, runId) : 0));
}

// ---------------------------------------------------------------------------------------------
// Plans, tasks, attempts, reviews
// ---------------------------------------------------------------------------------------------

export function usePlans(runId: string): Plan[] {
  return useData((s) => plansOfRun(s.plans, runId));
}

export function useLatestPlan(runId: string | null | undefined): Plan | null {
  return useData((s) => (runId ? latestPlan(s, runId) : null));
}

export function useRunTasks(runId: string): Task[] {
  return useData((s) => tasksOfRun(s.tasks, runId));
}

export function useTask(taskId: string | null | undefined): Task | null {
  return useData((s) => (taskId ? (s.tasks[taskId] ?? null) : null));
}

/** The plan node of a task (from the latest plan). */
export function useTaskNode(runId: string, nodeId: string | null | undefined): TaskNode | null {
  return useData((s) => (nodeId ? (latestPlan(s, runId)?.dag.nodes.find((n) => n.id === nodeId) ?? null) : null));
}

export function useAttempt(attemptId: string | null | undefined): Attempt | null {
  return useData((s) => (attemptId ? (s.attempts[attemptId] ?? null) : null));
}

/** Attempts of a task, oldest first. */
export function useTaskAttempts(task: Task | null): Attempt[] {
  return useData(
    useShallow((s) => (task ? attemptsOfRun(s.attempts, task.runId).filter((a) => a.taskId === task.id) : [])),
  );
}

/** Reviews of a task (null = the run's final review), oldest first. */
export function useReviews(runId: string, taskId: string | null): Review[] {
  return useData(useShallow((s) => reviewsOfRun(s.reviews, runId).filter((r) => r.taskId === taskId)));
}

// ---------------------------------------------------------------------------------------------
// Inbox & urgency
// ---------------------------------------------------------------------------------------------

/** Open inbox items, oldest first: for one run, or all runs when `runId` is null. */
export function useInbox(runId: string | null = null): InboxItem[] {
  return useData((s) => openInbox(s.inbox, runId ?? '*'));
}

export function useInboxItem(itemId: string | null | undefined): InboxItem | null {
  return useData((s) => (itemId ? (s.inbox[itemId] ?? null) : null));
}

export function useAcknowledged(itemIds: readonly string[]): boolean {
  return useUi((s) => itemIds.every((id) => s.acknowledged[id]));
}

// ---------------------------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------------------------

const EMPTY_TRANSCRIPT: Transcript = {
  status: 'loading',
  entries: [],
  count: 0,
  lastSeq: 0,
  error: null,
  dropped: 0,
  gap: null,
};

/**
 * An attempt's transcript: fetched once on first use, then appended live from agent events.
 * Entries are sorted by seq; coalesce `text_delta`s in the tile.
 */
export function useTranscript(attemptId: string | null | undefined): Transcript {
  const transcript = useData((s) => (attemptId ? s.transcripts[attemptId] : undefined));
  useEffect(() => {
    const sync = getSync();
    if (!attemptId || !sync) return;
    // Kept while shown; dropped a while after the last view of it unmounts.
    const release = sync.retainTranscript(attemptId);
    void sync.requestTranscript(attemptId);
    return release;
  }, [attemptId]);
  return transcript ?? EMPTY_TRANSCRIPT;
}

/** Last few readable activity lines of an attempt (no transcript fetch needed). */
export function useActivity(attemptId: string | null | undefined): readonly string[] {
  return useData((s) => (attemptId ? (s.activity[attemptId]?.lines ?? NO_LINES) : NO_LINES));
}
const NO_LINES: readonly string[] = [];

// ---------------------------------------------------------------------------------------------
// Engines, limits, settings, connection
// ---------------------------------------------------------------------------------------------

export function useEngines(): EnginesState {
  return useData((s) => s.engines);
}

/** Latest rate-limit reading per engine and window. */
export function useRateLimits(): RateLimit[] {
  return useData(useShallow((s) => Object.values(s.rateLimits).flatMap((byWindow) => Object.values(byWindow ?? {}))));
}

export function useSettings() {
  return useData((s) => s.settings);
}

export function useConnection() {
  return useData((s) => s.connection);
}

/** Agents holding a concurrency slot (task sessions) vs the global cap. */
export function useAgentsRunning(): { running: number; max: number } {
  return useData(
    useShallow((s) => ({
      // Compared with the global cap, which counts task slots (planners and the finalizer don't take one).
      running: Object.values(s.attempts).filter((a) => a.status === 'running' && a.taskId !== null).length,
      max: s.settings?.concurrency.global ?? 3,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

export function useLayout(runId: string | null | undefined): Workspace | null {
  return useUi((s) => (runId ? (s.layouts[runId] ?? null) : null));
}

/** Header/card metadata for a tile. Pass `now` to tick durations. */
export function useTileMeta(runId: string, tile: LayoutTile, now?: number): TileMeta {
  // describeTile builds a new object; select its inputs and memoize on them instead.
  const deps = useData(
    useShallow((s) => [
      s.runs[runId],
      s.plans,
      s.tasks,
      s.attempts,
      s.reviews,
      s.inbox,
      s.merges,
      s.verifications,
      s.diffstats,
    ]),
  );
  const [cache] = useState(() => ({
    deps: [] as unknown[],
    now: -1,
    tile: null as LayoutTile | null,
    meta: null as TileMeta | null,
  }));
  if (
    cache.meta &&
    cache.tile === tile &&
    cache.now === (now ?? -1) &&
    deps.length === cache.deps.length &&
    deps.every((d, i) => d === cache.deps[i])
  )
    return cache.meta;
  const meta = describeTile(dataStore.getState(), runId, tile, now);
  cache.deps = deps;
  cache.now = now ?? -1;
  cache.tile = tile;
  cache.meta = meta;
  return meta;
}

/** A ticking clock (ms), for "running 6m" style labels. */
export function useNow(intervalMs = 15_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

// ---------------------------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------------------------

/** Typed RPC call bound to the current engine client (demo mode included). */
export function useRpc(): <P extends ProcedureName>(method: P, input: RpcInput<P>) => Promise<RpcOutput<P>> {
  return useCallback(<P extends ProcedureName>(method: P, input: RpcInput<P>) => getClient().call(method, input), []);
}

/** Non-hook variant for command handlers. */
export function rpc<P extends ProcedureName>(method: P, input: RpcInput<P>): Promise<RpcOutput<P>> {
  return getClient().call(method, input);
}
