import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './async-queue';

describe('AsyncQueue', () => {
  it('delivers buffered and later items, then ends', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const collected: number[] = [];
    const done = (async () => {
      for await (const item of queue) collected.push(item);
    })();
    queue.push(2);
    await Promise.resolve();
    queue.push(3);
    queue.end();
    queue.push(4);
    await done;
    expect(collected).toEqual([1, 2, 3]);
  });

  it('rejects a waiting consumer on fail', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const next = iterator.next();
    queue.fail(new Error('broken'));
    await expect(next).rejects.toThrow('broken');
  });

  it('allows a single consumer', () => {
    const queue = new AsyncQueue<number>();
    queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrow(/single consumer/);
  });
});
