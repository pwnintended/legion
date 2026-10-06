/**
 * Single-consumer async queue: producers `push`, one consumer iterates with `for await`.
 * `end()` finishes the iteration after buffered items are drained; `fail(err)` rejects the pending read.
 * Used by adapters to expose `AgentSession.events`.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiter: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;
  private ended = false;
  private error: unknown = null;
  private iterating = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(item: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter && this.buffer.length === 0) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.error = error;
    this.ended = true;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iterating) throw new Error('AsyncQueue supports a single consumer');
    this.iterating = true;
    return {
      next: () => {
        const item = this.buffer.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) {
          return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.ended = true;
        this.buffer.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** A promise with its resolve/reject exposed. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
