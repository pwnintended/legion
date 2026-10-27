/** A counting semaphore. `size` may be a function: a lower limit takes effect as slots are released. */
export class Semaphore {
  private used = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly size: () => number;

  constructor(size: number | (() => number)) {
    this.size = typeof size === 'function' ? size : () => size;
  }

  async acquire(): Promise<() => void> {
    if (this.used < Math.max(1, this.size())) this.used++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      while (this.waiters.length > 0 && this.used < Math.max(1, this.size())) {
        this.used++;
        this.waiters.shift()?.();
      }
    };
  }
}
