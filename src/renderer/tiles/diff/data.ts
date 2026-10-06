/** `diff.get` results cached per target and refetched when the target's version changes. */
import type { DiffResult, DiffTarget } from '@shared/rpc';
import { useEffect, useState } from 'react';
import { createStore } from 'zustand/vanilla';
import { rpc } from '../../app/hooks';
import { errorText } from '../plan/kit';

interface Entry {
  version: string;
  data: DiffResult | null;
  error: string | null;
  loading: boolean;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

export function targetKey(target: DiffTarget): string {
  return target.kind === 'task'
    ? `task:${target.taskId}`
    : target.kind === 'run'
      ? `run:${target.runId}`
      : `range:${target.runId}:${target.from}..${target.to}`;
}

/** The diff for a target; `version` changes (e.g. the task's updatedAt) trigger a refetch. */
export function useDiff(target: DiffTarget, version: string): Entry & { refresh: () => void } {
  const key = targetKey(target);
  const [, setTick] = useState(0);
  const entry = cache.get(key);
  const load = (force: boolean) => {
    const current = cache.get(key);
    if (!force && current && current.version === version && (current.data || current.error)) return;
    if (inflight.has(key)) return;
    cache.set(key, { version, data: current?.data ?? null, error: null, loading: true });
    setTick((t) => t + 1);
    const p = rpc('diff.get', { target, contextLines: 3 })
      .then(
        (data) => {
          cache.set(key, { version, data, error: null, loading: false });
        },
        (error: unknown) => {
          cache.set(key, { version, data: current?.data ?? null, error: errorText(error), loading: false });
        },
      )
      .finally(() => {
        inflight.delete(key);
        setTick((t) => t + 1);
      });
    inflight.set(key, p);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by target + version.
  useEffect(() => load(false), [key, version]);
  return {
    ...(entry ?? { version, data: null, error: null, loading: true }),
    refresh: () => load(true),
  };
}

/** Cross-tile request to scroll a diff to a file/line (from the review tile). */
export interface DiffFocus {
  path: string;
  line: number | null;
  nonce: number;
}
export const diffFocus = createStore<Record<string, DiffFocus>>(() => ({}));

export function focusDiff(target: DiffTarget, path: string, line: number | null): void {
  diffFocus.setState({ ...diffFocus.getState(), [targetKey(target)]: { path, line, nonce: Date.now() } });
}
