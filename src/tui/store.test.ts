import { describe, expect, it, vi } from 'vitest';
import { UiStore } from './store.ts';

describe('UiStore', () => {
  it('batches cached step notifications while retaining all replayed steps', () => {
    vi.useFakeTimers();
    try {
      const store = new UiStore({
        runs: [{ id: 'resume', workflow: 'feature', steps: [], startedAt: 0 }],
      });
      const changed = vi.fn();
      store.subscribe(changed);
      for (let n = 0; n < 150; n++) {
        store.runEvent(
          { type: 'step', runId: 'resume', key: `step-${n}`, kind: 'agent', status: 'cached', label: `Step ${n}` },
          () => null,
        );
      }
      expect(store.get().runs[0]?.steps).toHaveLength(150);
      expect(changed).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(store.get().runs[0]?.steps.every((s) => s.status === 'cached')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a burst of urgent updates once, after the burst', async () => {
    const store = new UiStore({
      runs: [{ id: 'resume', workflow: 'feature', steps: [], startedAt: 0 }],
    });
    const changed = vi.fn();
    store.subscribe(changed);
    for (let n = 0; n < 150; n++) {
      store.runEvent(
        { type: 'step', runId: 'resume', key: `step-${n}`, kind: 'agent', status: 'done', label: `Step ${n}` },
        () => null,
      );
      store.runEvent({ type: 'log', runId: 'resume', message: `log ${n}` }, () => null);
    }
    expect(changed).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.get().runs[0]?.steps).toHaveLength(150);
  });

  it('folds the tool calls between two replies into one item, before the next reply', () => {
    const store = new UiStore();
    store.assistantEvent({ type: 'text_delta', text: 'Looking.' });
    store.assistantEvent({ type: 'tool_call', id: 'a', name: 'Read', input: { file_path: 'x.ts' }, kind: 'read' });
    store.assistantEvent({ type: 'tool_result', id: 'a', ok: true, output: '…' });
    store.assistantEvent({
      type: 'tool_call',
      id: 'b',
      name: 'Bash',
      input: { command: 'pnpm test' },
      kind: 'command',
    });
    store.assistantEvent({ type: 'tool_result', id: 'b', ok: false, output: '1 failed\nmore' });
    store.assistantEvent({ type: 'file_change', path: 'x.ts', added: 3, removed: 1 });
    store.assistantEvent({ type: 'file_change', path: 'x.ts', added: 2, removed: 0 });
    store.assistantEvent({ type: 'message', text: 'Done.' });
    store.assistantEvent({ type: 'turn_complete', structuredOutput: null, isError: false, reason: null });
    const items = store.get().items.map(({ id: _, ...i }) => i);
    expect(items).toEqual([
      { type: 'assistant', text: 'Looking.' },
      {
        type: 'tools',
        calls: [
          { tool: 'Read', line: 'Read x.ts', ok: true, error: null },
          { tool: 'Bash', line: 'Bash pnpm test', ok: false, error: '1 failed' },
        ],
        files: [{ path: 'x.ts', added: 5, removed: 1 }],
      },
      { type: 'assistant', text: 'Done.' },
    ]);
  });

  it('counts the output tokens of the current turn', () => {
    const store = new UiStore();
    store.assistantEvent({ type: 'usage', inputTokens: 10, outputTokens: 100, costUsd: null });
    store.setBusy(true);
    store.assistantEvent({ type: 'usage', inputTokens: 20, outputTokens: 340, costUsd: 0.01 });
    const { tokens, costUsd } = store.get();
    expect(tokens && tokens.output - tokens.outputAtTurnStart).toBe(240);
    expect(costUsd).toBe(0.01);
  });
});
