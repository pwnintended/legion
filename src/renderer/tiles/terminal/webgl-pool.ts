/**
 * Caps live WebGL contexts. Chromium evicts the oldest context silently (blank terminals) at ~16 per
 * process; Legion keeps well under that by giving WebGL only to terminals that are visible and focused,
 * and by evicting the least recently used holder when the cap is reached.
 */
export class WebglPool {
  private readonly holders = new Map<string, () => void>();

  constructor(readonly capacity = 6) {}

  get size(): number {
    return this.holders.size;
  }

  has(id: string): boolean {
    return this.holders.has(id);
  }

  /**
   * Take a slot. `evict` runs when the pool needs the slot back (dispose the addon there). The returned
   * release is idempotent and must be called when the holder gives the context up itself.
   */
  acquire(id: string, evict: () => void): () => void {
    this.holders.delete(id);
    while (this.holders.size >= this.capacity) {
      const oldest = this.holders.keys().next();
      if (oldest.done) break;
      const evictOldest = this.holders.get(oldest.value);
      this.holders.delete(oldest.value);
      evictOldest?.();
    }
    this.holders.set(id, evict);
    return () => {
      if (this.holders.get(id) === evict) this.holders.delete(id);
    };
  }

  /** Mark a holder most recently used. */
  touch(id: string): void {
    const evict = this.holders.get(id);
    if (!evict) return;
    this.holders.delete(id);
    this.holders.set(id, evict);
  }
}

export const webglPool = new WebglPool(6);
