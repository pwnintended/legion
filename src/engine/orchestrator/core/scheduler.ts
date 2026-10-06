/**
 * Dispatch planning (architecture §8 step 6). `planDispatch` is a pure function of the run's DAG, task
 * statuses and capacity; the lifecycle service calls it whenever something changes (task status change,
 * settings change, pause/resume, rate-limit reset timer) and applies the decisions with CAS transitions.
 *
 * Slots: a task holds one concurrency slot, charged to its coder engine, while it is provisioning,
 * running, verifying, reviewing or fixing (it runs at most one agent session at a time: coder, then
 * reviewer, then fixer). Approved/merging/awaiting_human tasks hold no slot. Continuations of in-flight
 * tasks (review, fix, resolver) never wait for a slot; only new starts are gated.
 */
import type { EngineKind, Settings, TaskNode, TaskStatus } from '@shared/domain';
import { coderEngineFor } from './engines';
import { compareNodeIds, fanOut, indexGraph, longestRemainingPath } from './graph';
import { comparePriority } from './priority';

export const SLOT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'provisioning',
  'running',
  'verifying',
  'reviewing',
  'fixing',
]);
/** Statuses that will make progress without a human. */
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([...SLOT_STATUSES, 'approved', 'merging']);
/** A dependency in one of these statuses is satisfied (skip = "treat as done", §8 escalation). */
export const SATISFIED_STATUSES: ReadonlySet<TaskStatus> = new Set(['merged', 'skipped']);
/** A dependency in one of these statuses blocks its descendants until a human acts. */
export const FAILED_STATUSES: ReadonlySet<TaskStatus> = new Set(['failed', 'cancelled']);
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['merged', 'skipped', 'cancelled']);

export interface SchedulerTask {
  readonly nodeId: string;
  readonly status: TaskStatus;
  readonly engineOverride?: EngineKind | null;
}

export interface RateLimit {
  readonly engine: EngineKind;
  /** null = unknown reset time: limited until the caller drops the entry. */
  readonly resetsAt: number | null;
}

export interface SchedulerInput {
  readonly nodes: readonly TaskNode[];
  /** One row per node; nodes without a row are treated as `blocked`. */
  readonly tasks: readonly SchedulerTask[];
  readonly settings: Pick<Settings, 'concurrency'>;
  /** Slot-holding tasks of *other* runs per coder engine (the global cap spans all runs). */
  readonly otherRunsInFlight?: Partial<Record<EngineKind, number>>;
  readonly paused: boolean;
  readonly rateLimits?: readonly RateLimit[];
  readonly now: number;
}

export type WaitReason = 'paused' | 'global_cap' | 'engine_cap' | 'rate_limited';

export interface DispatchDecision {
  readonly nodeId: string;
  readonly engine: EngineKind;
}

export interface WaitingTask {
  readonly nodeId: string;
  readonly engine: EngineKind;
  readonly reason: WaitReason;
  /** Rate-limit reset, if known. */
  readonly until: number | null;
}

export type RunProgress =
  | { readonly state: 'complete'; readonly merged: string[]; readonly skipped: string[]; readonly cancelled: string[] }
  /** Something is in flight, merging, or was dispatched now. */
  | { readonly state: 'active' }
  /** Nothing in flight; ready work waits for resume, capacity or a rate-limit reset. */
  | { readonly state: 'waiting'; readonly reason: WaitReason; readonly until: number | null }
  /** Nothing can progress without a human (inbox). */
  | {
      readonly state: 'needs_human';
      readonly awaitingHuman: string[];
      readonly failed: string[];
      readonly cancelled: string[];
      readonly blockedByFailure: string[];
    };

export interface DispatchPlan {
  /** blocked → queued: every dependency is merged (or skipped). */
  readonly enqueue: readonly string[];
  /** queued → blocked: defensive, a dependency is no longer satisfied (e.g. after a plan edit). */
  readonly block: readonly string[];
  /** queued → provisioning, in priority order. Includes nodes from `enqueue` (apply enqueue first). */
  readonly dispatch: readonly DispatchDecision[];
  /** Ready but not dispatched, and why. */
  readonly waiting: readonly WaitingTask[];
  /** Not-yet-started nodes with a failed or cancelled ancestor; `causes` = those ancestors. */
  readonly blockedByFailure: readonly { readonly nodeId: string; readonly causes: readonly string[] }[];
  /** Slots this run holds after the dispatches above. */
  readonly inFlight: { readonly total: number; readonly byEngine: Readonly<Record<EngineKind, number>> };
  readonly run: RunProgress;
  /** When to call `planDispatch` again even if nothing changes (earliest relevant rate-limit reset). */
  readonly nextWakeAt: number | null;
}

const zeroByEngine = (): Record<EngineKind, number> => ({ claude: 0, codex: 0, fake: 0 });

export function planDispatch(input: SchedulerInput): DispatchPlan {
  const index = indexGraph(input.nodes);
  const statusOf = new Map<string, TaskStatus>(index.ids.map((id) => [id, 'blocked']));
  const taskOf = new Map<string, SchedulerTask>();
  for (const task of input.tasks) {
    if (!index.byId.has(task.nodeId)) continue;
    statusOf.set(task.nodeId, task.status);
    taskOf.set(task.nodeId, task);
  }
  const status = (id: string) => statusOf.get(id) as TaskStatus;
  const engineOf = (id: string) => coderEngineFor(index.byId.get(id) as TaskNode, taskOf.get(id));
  const depsSatisfied = (id: string) => (index.deps.get(id) ?? []).every((d) => SATISFIED_STATUSES.has(status(d)));

  // Failure propagation: nodes that cannot start because a (transitive) dependency failed or was cancelled.
  const failedCauses = new Map<string, Set<string>>();
  for (const id of index.ids) {
    const causes = new Set<string>();
    const stack = [...(index.deps.get(id) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const dep = stack.pop() as string;
      if (seen.has(dep)) continue;
      seen.add(dep);
      if (FAILED_STATUSES.has(status(dep))) causes.add(dep);
      stack.push(...(index.deps.get(dep) ?? []));
    }
    if (causes.size > 0 && (status(id) === 'blocked' || status(id) === 'queued')) failedCauses.set(id, causes);
  }

  const enqueue: string[] = [];
  const block: string[] = [];
  const ready: string[] = [];
  for (const id of index.ids) {
    const s = status(id);
    if (s === 'blocked' && depsSatisfied(id)) {
      enqueue.push(id);
      ready.push(id);
    } else if (s === 'queued') {
      if (depsSatisfied(id)) ready.push(id);
      else block.push(id);
    }
  }

  const remaining = longestRemainingPath(input.nodes);
  const fan = fanOut(input.nodes);
  ready.sort((a, b) =>
    comparePriority(
      { id: a, remaining: remaining.get(a) ?? 0, fanOut: fan.get(a) ?? 0, risk: index.byId.get(a)?.risk ?? 'low' },
      { id: b, remaining: remaining.get(b) ?? 0, fanOut: fan.get(b) ?? 0, risk: index.byId.get(b)?.risk ?? 'low' },
    ),
  );

  const ownByEngine = zeroByEngine();
  for (const id of index.ids) if (SLOT_STATUSES.has(status(id))) ownByEngine[engineOf(id)]++;
  const usedByEngine = zeroByEngine();
  for (const engine of Object.keys(usedByEngine) as EngineKind[]) {
    usedByEngine[engine] = ownByEngine[engine] + (input.otherRunsInFlight?.[engine] ?? 0);
  }
  let usedGlobal = Object.values(usedByEngine).reduce((a, b) => a + b, 0);
  const limitedUntil = (engine: EngineKind): number | null | undefined => {
    const active = (input.rateLimits ?? []).filter(
      (r) => r.engine === engine && (r.resetsAt === null || r.resetsAt > input.now),
    );
    if (active.length === 0) return undefined;
    if (active.some((r) => r.resetsAt === null)) return null;
    return Math.max(...active.map((r) => r.resetsAt as number));
  };

  const dispatch: DispatchDecision[] = [];
  const waiting: WaitingTask[] = [];
  for (const id of ready) {
    const engine = engineOf(id);
    const until = limitedUntil(engine);
    const wait = (reason: WaitReason, at: number | null = null) =>
      waiting.push({ nodeId: id, engine, reason, until: at });
    if (input.paused) wait('paused');
    else if (until !== undefined) wait('rate_limited', until);
    else if (usedGlobal >= input.settings.concurrency.global) wait('global_cap');
    else if (usedByEngine[engine] >= input.settings.concurrency.perEngine[engine]) wait('engine_cap');
    else {
      dispatch.push({ nodeId: id, engine });
      usedByEngine[engine]++;
      ownByEngine[engine]++;
      usedGlobal++;
    }
  }

  const wakeTimes = waiting
    .filter((w) => w.reason === 'rate_limited' && w.until !== null)
    .map((w) => w.until as number);
  const nextWakeAt = wakeTimes.length > 0 ? Math.min(...wakeTimes) : null;
  const blockedByFailure = [...failedCauses]
    .map(([nodeId, causes]) => ({ nodeId, causes: [...causes].sort(compareNodeIds) }))
    .sort((a, b) => compareNodeIds(a.nodeId, b.nodeId));

  return {
    enqueue,
    block,
    dispatch,
    waiting,
    blockedByFailure,
    inFlight: { total: Object.values(ownByEngine).reduce((a, b) => a + b, 0), byEngine: ownByEngine },
    run: runProgress(),
    nextWakeAt,
  };

  function runProgress(): RunProgress {
    const ids = index.ids;
    const having = (pred: (s: TaskStatus) => boolean) => ids.filter((id) => pred(status(id)));
    if (ids.every((id) => TERMINAL_STATUSES.has(status(id)))) {
      return {
        state: 'complete',
        merged: having((s) => s === 'merged'),
        skipped: having((s) => s === 'skipped'),
        cancelled: having((s) => s === 'cancelled'),
      };
    }
    if (dispatch.length > 0 || ids.some((id) => ACTIVE_STATUSES.has(status(id)))) return { state: 'active' };
    const first = waiting[0];
    if (first) {
      const reason = waiting.some((w) => w.reason === 'paused')
        ? 'paused'
        : waiting.some((w) => w.reason === 'global_cap')
          ? 'global_cap'
          : waiting.some((w) => w.reason === 'rate_limited')
            ? 'rate_limited'
            : first.reason;
      return { state: 'waiting', reason, until: reason === 'rate_limited' ? nextWakeAt : null };
    }
    return {
      state: 'needs_human',
      awaitingHuman: having((s) => s === 'awaiting_human'),
      failed: having((s) => s === 'failed'),
      cancelled: having((s) => s === 'cancelled'),
      blockedByFailure: blockedByFailure.map((b) => b.nodeId),
    };
  }
}

export interface EscalationPreview {
  /** Nodes no longer blocked by a failure afterwards. */
  readonly unblocked: readonly string[];
  /** Nodes that would become ready (blocked → queued) right away. */
  readonly newlyReady: readonly string[];
}

/**
 * What retrying or skipping a failed / awaiting_human node would unblock (for the escalation UI).
 * Retry puts the node back in `queued`; skip marks it `skipped` (dependents treat it as satisfied).
 */
export function previewEscalation(input: SchedulerInput, nodeId: string, action: 'retry' | 'skip'): EscalationPreview {
  const before = planDispatch({ ...input, paused: true });
  const status: TaskStatus = action === 'retry' ? 'queued' : 'skipped';
  const tasks: SchedulerTask[] = input.tasks.some((t) => t.nodeId === nodeId)
    ? input.tasks.map((t) => (t.nodeId === nodeId ? { ...t, status } : t))
    : [...input.tasks, { nodeId, status }];
  const after = planDispatch({ ...input, tasks, paused: true });
  const stillBlocked = new Set(after.blockedByFailure.map((b) => b.nodeId));
  const enqueuedBefore = new Set(before.enqueue);
  return {
    unblocked: before.blockedByFailure.map((b) => b.nodeId).filter((id) => !stillBlocked.has(id)),
    newlyReady: after.enqueue.filter((id) => !enqueuedBefore.has(id)),
  };
}
