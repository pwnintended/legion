import type { DiffResult, DiffTarget } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { DiffCache, targetKey } from './data';

/** A fetch whose calls resolve when the test says so; each result records which call produced it. */
function controlledFetch() {
  const calls: { target: DiffTarget; resolve: (r: DiffResult) => void; reject: (e: unknown) => void }[] = [];
  const fetch = (target: DiffTarget) =>
    new Promise<DiffResult>((resolve, reject) => calls.push({ target, resolve, reject }));
  const result = (n: number): DiffResult => ({ from: `from${n}`, to: `to${n}`, files: [] });
  return { calls, fetch, result };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const task = (id: string): DiffTarget => ({ kind: 'task', taskId: id });

describe('DiffCache', () => {
  it('refetches when the version changed while a fetch was in flight', async () => {
    const { calls, fetch, result } = controlledFetch();
    const cache = new DiffCache(fetch);
    cache.request(task('t1'), 'v1');
    expect(calls).toHaveLength(1);
    // The task moves on while v1 is loading: no second concurrent fetch...
    cache.request(task('t1'), 'v2');
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(result(1));
    await flush();
    // ...but one for v2 as soon as v1 lands, instead of keeping the stale diff.
    expect(calls).toHaveLength(2);
    expect(cache.get('task:t1')).toMatchObject({ version: 'v2', loading: true, data: result(1) });
    calls[1]?.resolve(result(2));
    await flush();
    expect(cache.get('task:t1')).toEqual({ version: 'v2', data: result(2), error: null, loading: false });
  });

  it('serves a cached version, refetches on refresh (also mid-flight), and keeps old data on errors', async () => {
    const { calls, fetch, result } = controlledFetch();
    const cache = new DiffCache(fetch);
    cache.request(task('t1'), 'v1');
    calls[0]?.resolve(result(1));
    await flush();
    cache.request(task('t1'), 'v1');
    expect(calls).toHaveLength(1);
    cache.request(task('t1'), 'v1', true);
    expect(calls).toHaveLength(2);
    cache.request(task('t1'), 'v1', true);
    calls[1]?.reject(new Error('git exploded'));
    await flush();
    expect(calls).toHaveLength(3);
    calls[2]?.reject(new Error('still broken'));
    await flush();
    expect(cache.get('task:t1')).toMatchObject({ data: result(1), error: 'still broken', loading: false });
  });

  it('evicts the least recently used entries no tile shows', async () => {
    const { calls, fetch, result } = controlledFetch();
    const cache = new DiffCache(fetch, 2);
    const release = cache.retain('task:t1');
    for (const id of ['t1', 't2', 't3', 't4']) {
      cache.request(task(id), 'v1');
      calls.at(-1)?.resolve(result(1));
      await flush();
    }
    expect(cache.size).toBe(2);
    // t1 is still on screen; t2 (least recently used) and t3 went.
    expect(cache.get('task:t1')).toBeDefined();
    expect(cache.get('task:t2')).toBeUndefined();
    expect(cache.get('task:t4')).toBeDefined();
    release();
    cache.request(task('t5'), 'v1');
    calls.at(-1)?.resolve(result(1));
    await flush();
    expect(cache.get('task:t1')).toBeUndefined();
    expect(targetKey({ kind: 'range', runId: 'r', from: 'a', to: 'b' })).toBe('range:r:a..b');
  });

  it('notifies subscribers when an entry changes', async () => {
    const { calls, fetch, result } = controlledFetch();
    const cache = new DiffCache(fetch);
    let notified = 0;
    cache.subscribe(() => notified++);
    cache.request(task('t1'), 'v1');
    calls[0]?.resolve(result(1));
    await flush();
    expect(notified).toBe(2);
  });
});
