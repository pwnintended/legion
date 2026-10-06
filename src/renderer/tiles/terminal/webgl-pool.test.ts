import { describe, expect, it } from 'vitest';
import { WebglPool } from './webgl-pool';

describe('WebglPool', () => {
  it('evicts the least recently used holder when full', () => {
    const pool = new WebglPool(2);
    const evicted: string[] = [];
    pool.acquire('a', () => evicted.push('a'));
    pool.acquire('b', () => evicted.push('b'));
    pool.touch('a');
    pool.acquire('c', () => evicted.push('c'));
    expect(evicted).toEqual(['b']);
    expect(pool.size).toBe(2);
    expect(pool.has('a') && pool.has('c')).toBe(true);
  });

  it('release frees the slot and is idempotent; a stale release cannot drop a newer holder', () => {
    const pool = new WebglPool(1);
    const releaseA = pool.acquire('a', () => {});
    releaseA();
    releaseA();
    expect(pool.size).toBe(0);
    const stale = pool.acquire('a', () => {});
    pool.acquire('a', () => {});
    stale();
    expect(pool.has('a')).toBe(true);
  });

  it('never exceeds capacity', () => {
    const pool = new WebglPool(6);
    for (let i = 0; i < 20; i++) pool.acquire(`t${i}`, () => {});
    expect(pool.size).toBe(6);
  });
});
