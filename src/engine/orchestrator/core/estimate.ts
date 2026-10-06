/**
 * Cost and duration heuristics for a plan (architecture §8 step 4 "Estimate cost").
 *
 * All tunables live in `ESTIMATE_CONSTANTS`. They are rough, deliberately round numbers for API-priced
 * sessions with default models; subscription users pay in quota rather than dollars. Calibrate them from
 * finished `Attempt` rows (costUsd, startedAt/endedAt) once there is data; callers can override any
 * group through `EstimateOptions.constants`.
 */
import type { EngineKind, Risk, TaskNode, TaskSize } from '@shared/domain';
import { type EnabledEngines, finalizerEngineFor, reviewerEngineFor } from './engines';
import { compareNodeIds, criticalPath, fanOut, indexGraph, longestRemainingPath } from './graph';
import { comparePriority } from './priority';

type BySize = { readonly [S in TaskSize]: number };
type ByEngine<T> = { readonly [E in EngineKind]: T };

export interface EstimateConstants {
  /** Wall-clock minutes of one coder session (explore, edit, run verify commands), by size. */
  readonly coderMinutes: BySize;
  /** Legion's own verify run after each coder/fixer turn. */
  readonly verifyMinutes: BySize;
  /** One reviewer session (fresh context: reads spec + diff, may re-run tests). */
  readonly reviewerMinutes: BySize;
  /** A fix round costs this fraction of a coder session, plus a verify and a full re-review. */
  readonly fixRoundCoderFraction: number;
  /** Expected fix rounds by risk; L-size nodes add `largeExtraFixRounds`. Capped at `maxFixRounds`. */
  readonly expectedFixRounds: { readonly [R in Risk]: number };
  readonly largeExtraFixRounds: number;
  /** Expected extra full coder attempts (failed attempts that get retried), as a fraction. */
  readonly retryRate: number;
  /** Squash-merge + post-merge verify in the serialized merge queue. */
  readonly mergeMinutes: number;
  /** Multiplier on all minutes spent in an engine's sessions. */
  readonly engineTimeFactor: ByEngine<number>;
  /** USD per coder session. */
  readonly coderCostUsd: ByEngine<BySize>;
  /** USD per reviewer session. */
  readonly reviewerCostUsd: ByEngine<BySize>;
  /** After all merges: full verify on integration + final holistic review. */
  readonly finalize: { readonly minutes: number; readonly costUsd: ByEngine<number> };
}

export const ESTIMATE_CONSTANTS: EstimateConstants = {
  coderMinutes: { S: 6, M: 14, L: 30 },
  verifyMinutes: { S: 1, M: 2, L: 3 },
  reviewerMinutes: { S: 3, M: 5, L: 8 },
  fixRoundCoderFraction: 0.4,
  expectedFixRounds: { low: 0.3, med: 0.6, high: 1 },
  largeExtraFixRounds: 0.4,
  retryRate: 0.1,
  mergeMinutes: 2,
  engineTimeFactor: { claude: 1, codex: 1.1, fake: 0.01 },
  coderCostUsd: {
    claude: { S: 0.5, M: 1.2, L: 3 },
    codex: { S: 0.35, M: 0.9, L: 2.2 },
    fake: { S: 0, M: 0, L: 0 },
  },
  reviewerCostUsd: {
    claude: { S: 0.2, M: 0.4, L: 0.8 },
    codex: { S: 0.15, M: 0.3, L: 0.6 },
    fake: { S: 0, M: 0, L: 0 },
  },
  finalize: { minutes: 10, costUsd: { claude: 1, codex: 0.8, fake: 0 } },
};

export interface EstimateOptions {
  readonly concurrency?: { readonly global: number; readonly perEngine: Partial<ByEngine<number>> };
  readonly maxFixRounds?: number;
  readonly enabled?: EnabledEngines;
  /** Coder engine overrides by node id (`Task.engineOverride`). */
  readonly engineOverrides?: ReadonlyMap<string, EngineKind>;
  readonly constants?: Partial<EstimateConstants>;
}

export interface NodeEstimate {
  readonly nodeId: string;
  readonly coderEngine: EngineKind;
  readonly reviewerEngine: EngineKind;
  readonly expectedFixRounds: number;
  /** Coding + verify + review + expected fix rounds and retries (excludes the merge queue). */
  readonly minutes: number;
  readonly costUsd: number;
  readonly breakdown: { readonly coderUsd: number; readonly reviewerUsd: number; readonly fixUsd: number };
}

export interface ScheduleEntry {
  readonly nodeId: string;
  readonly start: number;
  /** Work done (review approved), slot released. */
  readonly end: number;
  /** Merged into the integration branch; dependents can start. */
  readonly mergedAt: number;
}

export interface PlanEstimate {
  readonly nodes: readonly NodeEstimate[];
  /** Task work + finalize, in USD. The planner's own cost is already spent and not included. */
  readonly totalCostUsd: number;
  /** Sum of all task minutes (one agent at a time). */
  readonly serialMinutes: number;
  /** Lower bound with unlimited concurrency (heaviest chain incl. merges). */
  readonly criticalPathMinutes: number;
  readonly criticalPath: readonly string[];
  /** Simulated list schedule under the concurrency caps, until the last merge. */
  readonly executionMinutes: number;
  /** executionMinutes + finalize. */
  readonly wallClockMinutes: number;
  readonly schedule: readonly ScheduleEntry[];
  readonly concurrency: number;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function constantsWith(overrides?: Partial<EstimateConstants>): EstimateConstants {
  return { ...ESTIMATE_CONSTANTS, ...overrides };
}

export function estimateNode(
  node: Pick<TaskNode, 'id' | 'size' | 'risk' | 'agent'>,
  options: EstimateOptions = {},
): NodeEstimate {
  const k = constantsWith(options.constants);
  const coderEngine = options.engineOverrides?.get(node.id) ?? node.agent.engine;
  const reviewerEngine = reviewerEngineFor(coderEngine, options.enabled);
  const maxFix = options.maxFixRounds ?? 2;
  const fixRounds = Math.min(maxFix, k.expectedFixRounds[node.risk] + (node.size === 'L' ? k.largeExtraFixRounds : 0));
  const coderMin = k.coderMinutes[node.size] * k.engineTimeFactor[coderEngine];
  const reviewMin = k.reviewerMinutes[node.size] * k.engineTimeFactor[reviewerEngine];
  const verifyMin = k.verifyMinutes[node.size];
  const roundMin = coderMin * k.fixRoundCoderFraction + verifyMin + reviewMin;
  const minutes = coderMin * (1 + k.retryRate) + verifyMin + reviewMin + fixRounds * roundMin;

  const coderUsd = k.coderCostUsd[coderEngine][node.size] * (1 + k.retryRate);
  const reviewOnce = k.reviewerCostUsd[reviewerEngine][node.size];
  const fixUsd = fixRounds * (k.coderCostUsd[coderEngine][node.size] * k.fixRoundCoderFraction + reviewOnce);
  return {
    nodeId: node.id,
    coderEngine,
    reviewerEngine,
    expectedFixRounds: round(fixRounds),
    minutes: round(minutes, 1),
    costUsd: round(coderUsd + reviewOnce + fixUsd),
    breakdown: { coderUsd: round(coderUsd), reviewerUsd: round(reviewOnce), fixUsd: round(fixUsd) },
  };
}

/**
 * Estimate a whole (acyclic) plan. The wall clock comes from a list-scheduling simulation that mirrors the
 * scheduler: a node starts when all deps are merged and a slot is free (global cap and per-engine cap on
 * its coder engine; a cap of 0 is treated as 1 so the estimate terminates), in scheduler priority order;
 * finished nodes go through a single FIFO merge queue.
 */
export function estimatePlan(nodes: readonly TaskNode[], options: EstimateOptions = {}): PlanEstimate {
  const k = constantsWith(options.constants);
  const index = indexGraph(nodes);
  const estimates = new Map(index.ids.map((id) => [id, estimateNode(index.byId.get(id) as TaskNode, options)]));
  const minutesOf = (n: TaskNode) => (estimates.get(n.id)?.minutes ?? 0) + k.mergeMinutes;
  const remaining = longestRemainingPath(nodes, minutesOf);
  const fan = fanOut(nodes);
  const global = Math.max(1, options.concurrency?.global ?? 3);
  const engineCap = (engine: EngineKind) => Math.max(1, options.concurrency?.perEngine[engine] ?? global);

  const mergedAt = new Map<string, number>();
  const started = new Set<string>();
  const running = new Map<string, { start: number; end: number; engine: EngineKind }>();
  const schedule: ScheduleEntry[] = [];
  const priorityKey = (id: string) => ({
    id,
    remaining: remaining.get(id) ?? 0,
    fanOut: fan.get(id) ?? 0,
    risk: index.byId.get(id)?.risk ?? 'low',
  });
  let now = 0;
  let mergeFree = 0;

  // Discrete-event loop: events are task completions (slot released, merge enqueued) and merge ends
  // (dependents released). Completions are processed in time order, so the merge queue is FIFO.
  for (;;) {
    const ready = index.ids
      .filter((id) => !started.has(id))
      .filter((id) => (index.deps.get(id) ?? []).every((d) => (mergedAt.get(d) ?? Number.POSITIVE_INFINITY) <= now))
      .sort((a, b) => comparePriority(priorityKey(a), priorityKey(b)));
    for (const id of ready) {
      if (running.size >= global) break;
      const est = estimates.get(id) as NodeEstimate;
      const busy = [...running.values()].filter((r) => r.engine === est.coderEngine).length;
      if (busy >= engineCap(est.coderEngine)) continue;
      started.add(id);
      running.set(id, { start: now, end: now + est.minutes, engine: est.coderEngine });
    }
    const pendingMerges = [...mergedAt.values()].filter((t) => t > now);
    const next = Math.min(...[...running.values()].map((r) => r.end), ...pendingMerges);
    if (!Number.isFinite(next)) break;
    now = next;
    const done = [...running.entries()]
      .filter(([, r]) => r.end <= now)
      .sort((a, b) => a[1].end - b[1].end || compareNodeIds(a[0], b[0]));
    for (const [id, r] of done) {
      running.delete(id);
      mergeFree = Math.max(r.end, mergeFree) + k.mergeMinutes;
      mergedAt.set(id, mergeFree);
      schedule.push({ nodeId: id, start: round(r.start, 1), end: round(r.end, 1), mergedAt: round(mergeFree, 1) });
    }
  }
  return finish();

  function finish(): PlanEstimate {
    const nodeEstimates = index.ids.map((id) => estimates.get(id) as NodeEstimate);
    const execution = Math.max(0, ...schedule.map((s) => s.mergedAt));
    const finalizeEngine = finalizerEngineFor(
      nodeEstimates.map((e) => e.coderEngine),
      options.enabled,
    );
    const cp = criticalPath(nodes, minutesOf);
    return {
      nodes: nodeEstimates,
      totalCostUsd: round(nodeEstimates.reduce((sum, e) => sum + e.costUsd, 0) + k.finalize.costUsd[finalizeEngine]),
      serialMinutes: round(
        nodeEstimates.reduce((sum, e) => sum + e.minutes + k.mergeMinutes, 0),
        1,
      ),
      criticalPathMinutes: round(cp.length, 1),
      criticalPath: cp.path,
      executionMinutes: round(execution, 1),
      wallClockMinutes: round(execution + k.finalize.minutes, 1),
      schedule: [...schedule].sort((a, b) => a.start - b.start || compareNodeIds(a.nodeId, b.nodeId)),
      concurrency: global,
    };
  }
}
