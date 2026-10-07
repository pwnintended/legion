/**
 * Highlight requests from the diff tile: hunks are tokenized lazily (only when a row of the hunk is rendered),
 * in a Web Worker when one can be started, otherwise on the main thread. Results are cached per hunk.
 */
import { useSyncExternalStore } from 'react';
import type { HighlightRequest, HighlightResponse, Tok } from './highlighter';

export type { Tok };

/** Highlighted hunks kept (least recently used go first; a hunk shown again is simply re-highlighted). */
export const MAX_HIGHLIGHTED_HUNKS = 1500;
/** Insertion order is recency. */
const cache = new Map<string, (Tok[][] | null)[]>();

function touch(key: string): void {
  const value = cache.get(key);
  if (value === undefined) return;
  cache.delete(key);
  cache.set(key, value);
}

function store(key: string, blocks: (Tok[][] | null)[]): void {
  cache.delete(key);
  cache.set(key, blocks);
  for (const oldest of cache.keys()) {
    if (cache.size <= MAX_HIGHLIGHTED_HUNKS) break;
    cache.delete(oldest);
  }
}
const inflight = new Map<number, { key: string; request: HighlightRequest }>();
const pendingKeys = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let nextId = 1;
let worker: Worker | null | 'failed' = null;
let flushScheduled = false;

function changed(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // Batch many hunk results into one re-render.
  requestAnimationFrame(() => {
    flushScheduled = false;
    version++;
    for (const listener of listeners) listener();
  });
}

function receive(response: HighlightResponse): void {
  const entry = inflight.get(response.id);
  if (!entry) return;
  inflight.delete(response.id);
  pendingKeys.delete(entry.key);
  store(entry.key, response.blocks);
  changed();
}

async function onMainThread(request: HighlightRequest): Promise<void> {
  const { highlight } = await import('./highlighter');
  receive(await highlight(request));
}

function startWorker(): Worker | null {
  if (worker === 'failed') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
      type: 'module',
      name: 'legion-highlight',
    });
    w.onmessage = (event: MessageEvent<HighlightResponse>) => receive(event.data);
    w.onerror = (event) => {
      event.preventDefault();
      worker = 'failed';
      w.terminate();
      // Re-run whatever the worker had in flight on the main thread.
      for (const { request } of inflight.values()) void onMainThread(request);
    };
    worker = w;
    return w;
  } catch {
    worker = 'failed';
    return null;
  }
}

/** Ask for a hunk's tokens (old side, new side). No-op when cached or already requested. */
export function requestHighlight(key: string, lang: string, blocks: string[]): void {
  if (cache.has(key)) {
    touch(key);
    return;
  }
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);
  const request: HighlightRequest = { id: nextId++, lang, blocks };
  inflight.set(request.id, { key, request });
  const w = startWorker();
  if (w) w.postMessage(request);
  else void onMainThread(request);
}

export function highlighted(key: string): (Tok[][] | null)[] | undefined {
  return cache.get(key);
}

/** Re-renders the caller when new highlight results arrive. */
export function useHighlightVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

/** Number of highlighted hunks held (tests, diagnostics). */
export function highlightCacheSize(): number {
  return cache.size;
}

export function highlightBackend(): 'worker' | 'main' | 'idle' {
  return worker === 'failed' ? 'main' : worker ? 'worker' : 'idle';
}
