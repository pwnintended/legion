/**
 * `diff.get` results cached per target and refetched when the target's version changes.
 *
 * - A version bump while a fetch is in flight is not lost: when the fetch lands, the cache compares it with
 *   the latest requested version and fetches again (a running task's diff never stays stale).
 * - The cache is a small LRU: entries no mounted tile uses are evicted beyond `max` (full `DiffResult`s are
 *   large).
 * - Every tile showing a target re-renders when its entry changes (not just the one that asked).
 */
import type { DiffResult, DiffTarget } from '@shared/rpc';
import { useEffect, useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';
import { rpc } from '../../app/hooks';
import { errorText } from '../plan/kit';

export interface DiffEntry {
  version: string;
  data: DiffResult | null;
  error: string | null;
  loading: boolean;
}

export function targetKey(target: DiffTarget): string {
  switch (target.kind) {
    case 'task':
      return `task:${target.taskId}`;
    case 'run':
      return `run:${target.runId}`;
    case 'range':
      return `range:${target.runId}:${target.from}..${target.to}`;
    case 'commit':
      return `commit:${target.projectId}:${target.sha}`;
  }
}

type Fetch = (target: DiffTarget) => Promise<DiffResult>;

export class DiffCache {
  /** Insertion order is recency (least recently used first). */
  private readonly entries = new Map<string, DiffEntry>();
  /** key → version being fetched. */
  private readonly inflight = new Map<string, string>();
  /** key → the latest version (and target) a tile asked for; `force` = refetch even if that version is cached. */
  private readonly wanted = new Map<string, { target: DiffTarget; version: string; force: boolean }>();
  /** key → number of mounted users (never evicted while > 0). */
  private readonly users = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly fetch: Fetch,
    readonly max = 16,
  ) {}

  get(key: string): DiffEntry | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A mounted tile shows `key`: keep it cached. Returns the release function. */
  retain(key: string): () => void {
    this.users.set(key, (this.users.get(key) ?? 0) + 1);
    return () => {
      const n = (this.users.get(key) ?? 1) - 1;
      if (n > 0) this.users.set(key, n);
      else this.users.delete(key);
      this.evict();
    };
  }

  /** Make sure the cache holds `version` of `target` (fetching it if needed). */
  request(target: DiffTarget, version: string, force = false): void {
    const key = targetKey(target);
    const current = this.entries.get(key);
    if (current) {
      // Touch: most recently used.
      this.entries.delete(key);
      this.entries.set(key, current);
    }
    if (this.inflight.has(key)) {
      // Compared with what landed when the fetch finishes.
      this.wanted.set(key, { target, version, force: force || this.wanted.get(key)?.force === true });
      return;
    }
    this.wanted.set(key, { target, version, force: false });
    if (!force && current && current.version === version && !current.loading && (current.data || current.error)) return;
    this.start(key);
  }

  private start(key: string): void {
    const want = this.wanted.get(key);
    if (!want) return;
    const { target, version } = want;
    this.wanted.set(key, { target, version, force: false });
    const previous = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, { version, data: previous?.data ?? null, error: null, loading: true });
    this.inflight.set(key, version);
    this.emit();
    this.fetch(target)
      .then(
        (data) => this.entries.set(key, { version, data, error: null, loading: false }),
        (error: unknown) =>
          this.entries.set(key, {
            version,
            data: this.entries.get(key)?.data ?? null,
            error: errorText(error),
            loading: false,
          }),
      )
      .finally(() => {
        this.inflight.delete(key);
        const latest = this.wanted.get(key);
        // The version moved on (or a refresh was asked for) while this fetch was in flight.
        if (latest && (latest.version !== version || latest.force)) this.start(key);
        else {
          this.evict();
          this.emit();
        }
      });
  }

  private evict(): void {
    if (this.entries.size <= this.max) return;
    for (const key of [...this.entries.keys()]) {
      if (this.entries.size <= this.max) break;
      if (this.users.has(key) || this.inflight.has(key)) continue;
      this.entries.delete(key);
      this.wanted.delete(key);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const diffs = new DiffCache((target) => rpc('diff.get', { target, contextLines: 3 }));

/** The diff for a target; `version` changes (e.g. the task's updatedAt) trigger a refetch. */
export function useDiff(target: DiffTarget, version: string): DiffEntry & { refresh: () => void } {
  const key = targetKey(target);
  const entry = useSyncExternalStore(diffs.subscribe, () => diffs.get(key));
  useEffect(() => diffs.retain(key), [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by target + version.
  useEffect(() => diffs.request(target, version), [key, version]);
  return {
    ...(entry ?? { version, data: null, error: null, loading: true }),
    refresh: () => diffs.request(target, version, true),
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
