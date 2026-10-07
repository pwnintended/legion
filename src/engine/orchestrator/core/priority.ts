import type { Risk } from '@shared/domain';
import { compareNodeIds } from './graph';

export const RISK_RANK: { readonly [R in Risk]: number } = { low: 0, med: 1, high: 2 };

export interface PriorityKey {
  readonly id: string;
  /** Longest remaining path (higher first). */
  readonly remaining: number;
  /** Direct dependents (higher first). */
  readonly fanOut: number;
  /** Risky work first, so failures surface early. */
  readonly risk: Risk;
}

/** Dispatch priority (§8): longest remaining path desc, fan-out desc, risk desc, id asc. */
export function comparePriority(a: PriorityKey, b: PriorityKey): number {
  return (
    b.remaining - a.remaining ||
    b.fanOut - a.fanOut ||
    RISK_RANK[b.risk] - RISK_RANK[a.risk] ||
    compareNodeIds(a.id, b.id)
  );
}
