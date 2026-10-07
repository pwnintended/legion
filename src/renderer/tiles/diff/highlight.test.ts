import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A worker double that "highlights" synchronously-ish (next microtask). */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(request: { id: number; blocks: string[] }): void {
    queueMicrotask(() => this.onmessage?.({ data: { id: request.id, blocks: request.blocks.map(() => null) } }));
  }
  terminate(): void {}
}

describe('highlight cache', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps at most MAX_HIGHLIGHTED_HUNKS hunks, evicting the least recently used', async () => {
    const { requestHighlight, highlighted, highlightCacheSize, MAX_HIGHLIGHTED_HUNKS } = await import('./highlight');
    requestHighlight('keep', 'ts', ['a']);
    await Promise.resolve();
    for (let i = 0; i < MAX_HIGHLIGHTED_HUNKS + 50; i++) {
      requestHighlight(`hunk${i}`, 'ts', ['a']);
      await Promise.resolve();
      // `keep` is on screen: the diff tile asks for it again on every render.
      if (i % 100 === 0) requestHighlight('keep', 'ts', ['a']);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(highlightCacheSize()).toBe(MAX_HIGHLIGHTED_HUNKS);
    expect(highlighted('keep')).toBeDefined();
    expect(highlighted('hunk0')).toBeUndefined();
    expect(highlighted(`hunk${MAX_HIGHLIGHTED_HUNKS + 49}`)).toBeDefined();
  });
});
