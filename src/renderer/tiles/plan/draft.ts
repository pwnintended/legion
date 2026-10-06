/**
 * The editable plan draft shared by the plan and DAG tiles while a plan awaits sign-off.
 *
 * Edits apply locally at once (validated with the orchestrator's pure core) and are saved with a debounced
 * `runs.updatePlan` against the version they started from. A save that loses the race (`conflict`), or a
 * newer plan arriving while there are unsaved edits, puts the draft in `conflict` until the user keeps their
 * edits (rebased onto the newest version) or discards them.
 */
import type { Plan, PlanDag } from '@shared/domain';
import type { RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { latestPlan } from '../../app/data';
import { rpc, useLatestPlan, useSettings } from '../../app/hooks';
import { dataStore } from '../../app/store';
import { errorText } from './kit';
import { analyzePlan } from './model';

export type DraftStatus = 'clean' | 'pending' | 'saving' | 'saved' | 'invalid' | 'conflict' | 'error';

export interface PlanDraft {
  runId: string;
  basePlanId: string;
  baseVersion: number;
  markdown: string;
  dag: PlanDag;
  /** Local edits not yet saved. */
  dirty: boolean;
  /** Bumped on every edit (a save only clears `dirty` when no edit happened meanwhile). */
  edits: number;
  status: DraftStatus;
  error: string | null;
  /** Last edit, for a one-step undo. */
  undo: { label: string; markdown: string; dag: PlanDag } | null;
}

const store = createStore<Record<string, PlanDraft>>(() => ({}));
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
const SAVE_DELAY_MS = 700;

function fromPlan(plan: Plan): PlanDraft {
  return {
    runId: plan.runId,
    basePlanId: plan.id,
    baseVersion: plan.version,
    markdown: plan.markdown,
    dag: plan.dag,
    dirty: false,
    edits: 0,
    status: 'clean',
    error: null,
    undo: null,
  };
}

function patch(runId: string, next: Partial<PlanDraft>): void {
  const current = store.getState()[runId];
  if (!current) return;
  store.setState({ ...store.getState(), [runId]: { ...current, ...next } });
}

/** The draft for a run's latest plan (tracking new versions while there are no local edits). */
export function usePlanDraft(runId: string): PlanDraft | null {
  const plan = useLatestPlan(runId);
  const draft = useStore(store, (s) => s[runId] ?? null);
  useEffect(() => {
    if (!plan) return;
    const current = store.getState()[runId];
    if (!current) {
      store.setState({ ...store.getState(), [runId]: fromPlan(plan) });
      return;
    }
    if (current.basePlanId === plan.id) return;
    if (current.status === 'saving') return;
    if (!current.dirty) store.setState({ ...store.getState(), [runId]: fromPlan(plan) });
    else if (current.status !== 'conflict')
      patch(runId, {
        status: 'conflict',
        error: `v${plan.version} arrived (${plan.source === 'agent' ? 'from the planner' : 'another edit'}) while you were editing.`,
      });
  }, [plan, runId]);
  if (draft && plan && (draft.basePlanId === plan.id || draft.dirty || draft.status === 'saving')) return draft;
  return plan ? fromPlan(plan) : null;
}

/** Validation + estimate of the current draft (memoized per DAG). */
const analysisCache = new WeakMap<PlanDag, ReturnType<typeof analyzePlan>>();
export function useAnalysis(dag: PlanDag | null): ReturnType<typeof analyzePlan> | null {
  const settings = useSettings();
  if (!dag) return null;
  const cached = analysisCache.get(dag);
  if (cached) return cached;
  const analysis = analyzePlan(dag, settings);
  analysisCache.set(dag, analysis);
  return analysis;
}

/**
 * Apply an edit to the run's draft. The DAG is normalized through validation (auto edges appear at once);
 * a structurally broken DAG is kept locally but not saved.
 */
export function editPlan(
  runId: string,
  label: string,
  edit: (draft: { markdown: string; dag: PlanDag }) => { markdown?: string; dag?: PlanDag },
): void {
  let current = store.getState()[runId];
  if (!current) {
    const plan = latestPlan(dataStore.getState(), runId);
    if (!plan) return;
    current = fromPlan(plan);
  }
  const result = edit({ markdown: current.markdown, dag: current.dag });
  const markdown = result.markdown ?? current.markdown;
  let dag = result.dag ?? current.dag;
  const analysis = analyzePlan(dag, dataStore.getState().settings);
  if (analysis.validation.ok) dag = analysis.validation.dag;
  analysisCache.set(dag, analysis.validation.ok ? analyzePlan(dag, dataStore.getState().settings) : analysis);
  const invalid = !analysis.validation.ok;
  store.setState({
    ...store.getState(),
    [runId]: {
      ...current,
      markdown,
      dag,
      dirty: true,
      edits: current.edits + 1,
      status: current.status === 'conflict' ? 'conflict' : invalid ? 'invalid' : 'pending',
      error: current.status === 'conflict' ? current.error : null,
      undo: { label, markdown: current.markdown, dag: current.dag },
    },
  });
  if (!invalid && current.status !== 'conflict') scheduleSave(runId);
}

export function undoEdit(runId: string): void {
  const current = store.getState()[runId];
  if (!current?.undo) return;
  const { markdown, dag } = current.undo;
  editPlan(runId, 'undo', () => ({ markdown, dag }));
  patch(runId, { undo: null });
}

function scheduleSave(runId: string): void {
  const timer = timers.get(runId);
  if (timer) clearTimeout(timer);
  timers.set(
    runId,
    setTimeout(() => {
      timers.delete(runId);
      void save(runId);
    }, SAVE_DELAY_MS),
  );
}

async function save(runId: string): Promise<void> {
  const running = inflight.get(runId);
  if (running) {
    await running;
    const again = store.getState()[runId];
    if (again?.dirty && again.status !== 'conflict' && again.status !== 'invalid') return save(runId);
    return;
  }
  const draft = store.getState()[runId];
  if (!draft?.dirty || draft.status === 'invalid' || draft.status === 'conflict') return;
  const edits = draft.edits;
  patch(runId, { status: 'saving', error: null });
  // `annotations` carries undone auto edges ([overlap_accepted]); engines that predate it ignore the field.
  const payload = {
    runId,
    basePlanId: draft.basePlanId,
    markdown: draft.markdown,
    nodes: draft.dag.nodes,
    annotations: draft.dag.annotations,
  };
  const task = (async () => {
    try {
      const plan = await rpc('runs.updatePlan', payload as RpcInput<'runs.updatePlan'>);
      const now = store.getState()[runId];
      if (!now) return;
      const clean = now.edits === edits;
      patch(runId, {
        basePlanId: plan.id,
        baseVersion: plan.version,
        dirty: !clean,
        status: clean ? 'saved' : 'pending',
        error: null,
        ...(clean ? { dag: plan.dag, markdown: plan.markdown } : {}),
      });
      if (!clean) scheduleSave(runId);
    } catch (error) {
      const conflict = error instanceof RpcError && error.code === 'conflict';
      patch(runId, {
        status: conflict ? 'conflict' : 'error',
        error: conflict ? 'Someone else saved a newer version first.' : errorText(error),
      });
    }
  })();
  inflight.set(runId, task);
  try {
    await task;
  } finally {
    inflight.delete(runId);
  }
}

/** Save now (before approving). Resolves to the id of the plan version that holds every edit. */
export async function flushPlan(runId: string): Promise<string | null> {
  const timer = timers.get(runId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(runId);
  }
  await save(runId);
  const draft = store.getState()[runId];
  if (draft?.dirty) return null;
  return draft?.basePlanId ?? latestPlan(dataStore.getState(), runId)?.id ?? null;
}

/** Keep local edits: rebase them onto the newest version and save again. */
export function keepMine(runId: string): void {
  const plan = latestPlan(dataStore.getState(), runId);
  if (!plan) return;
  patch(runId, { basePlanId: plan.id, baseVersion: plan.version, status: 'pending', error: null });
  scheduleSave(runId);
}

/** Drop local edits and follow the newest version. */
export function discardEdits(runId: string): void {
  const plan = latestPlan(dataStore.getState(), runId);
  const timer = timers.get(runId);
  if (timer) clearTimeout(timer);
  timers.delete(runId);
  const next = { ...store.getState() };
  if (plan) next[runId] = fromPlan(plan);
  else delete next[runId];
  store.setState(next);
}

export function resetDraftsForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  store.setState({});
}
