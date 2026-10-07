/**
 * A tiny keyed query cache for read-only RPCs that are not part of the event-sourced store (project info, git
 * history, directory listings, file contents): stale-while-revalidate, shared between tiles, bounded (LRU).
 *
 *   const log = useQuery(`log:${projectId}`, () => rpc('git.log', { projectId, limit: 50 }));
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export interface QueryEntry<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** When `data` was fetched (ms), 0 = never. */
  at: number;
}

const EMPTY: QueryEntry<never> = { data: null, error: null, loading: true, at: 0 };
const MAX_ENTRIES = 300;

const entries = new Map<string, QueryEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function set(key: string, entry: QueryEntry<unknown>): void {
  entries.delete(key);
  entries.set(key, entry);
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    if (!inflight.has(oldest)) entries.delete(oldest);
  }
  emit();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch `key` now (deduplicated with a fetch in flight). Keeps the previous data while loading. */
export function fetchQuery<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const previous = entries.get(key) as QueryEntry<T> | undefined;
  set(key, { data: previous?.data ?? null, error: null, loading: true, at: previous?.at ?? 0 });
  const promise = fetcher().then(
    (data) => {
      inflight.delete(key);
      set(key, { data, error: null, loading: false, at: Date.now() });
      return data;
    },
    (error: unknown) => {
      inflight.delete(key);
      set(key, { data: previous?.data ?? null, error: errorText(error), loading: false, at: previous?.at ?? 0 });
      throw error;
    },
  );
  inflight.set(key, promise);
  return promise;
}

/** Mark matching entries stale (they refetch on next use) and refetch nothing now. */
export function invalidateQueries(prefix: string): void {
  let changed = false;
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix) && entry.at !== -1) {
      entries.set(key, { ...entry, at: -1 });
      changed = true;
    }
  }
  if (changed) emit();
}

export function peekQuery<T>(key: string): QueryEntry<T> | undefined {
  return entries.get(key) as QueryEntry<T> | undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render the caller whenever any query entry changes (for views that read several via `peekQuery`). */
export function useQueryVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Is `key` missing, invalidated or older than `staleMs`? */
export function isStale(key: string, staleMs: number): boolean {
  const entry = entries.get(key);
  if (!entry) return true;
  if (inflight.has(key)) return false;
  return entry.at === -1 || (entry.at > 0 && Date.now() - entry.at > staleMs);
}

/**
 * The entry for `key` (null = disabled), fetched on first use and again once older than `staleMs` (or
 * invalidated). `refresh()` refetches now.
 */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: { staleMs?: number } = {},
): QueryEntry<T> & { refresh: () => void } {
  const staleMs = options.staleMs ?? 30_000;
  useSyncExternalStore(subscribe, () => version);
  const entry = key ? ((entries.get(key) as QueryEntry<T> | undefined) ?? EMPTY) : EMPTY;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by `key`; the fetcher is captured per key.
  useEffect(() => {
    if (!key) return;
    const current = entries.get(key);
    const stale = !current || current.at === -1 || (current.at > 0 && Date.now() - current.at > staleMs);
    if ((stale || (current.at === 0 && !current.loading && !current.error)) && !inflight.has(key))
      void fetchQuery(key, fetcher).catch(() => {});
  }, [key, entry.at]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by `key`.
  const refresh = useCallback(() => {
    if (key) void fetchQuery(key, fetcher).catch(() => {});
  }, [key]);
  return { ...entry, refresh };
}
