import { describe, expect, it, vi } from 'vitest';
import { buildAgentTree } from './agents.ts';
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

it('removes retained snapshots on resume and retains each run ID only once', () => {
  const store = new UiStore();
  const lookup = () => null;
  const unique = () => {
    const nodes = buildAgentTree(store.get());
    expect(new Set(nodes.map((n) => n.key)).size).toBe(nodes.length);
    return nodes;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    store.runEvent({ type: 'run', runId: 'r', status: 'running' }, lookup);
    store.runEvent({ type: 'step', runId: 'r', key: 'a', label: 'Agent', kind: 'agent', status: 'started' }, lookup);
    expect(store.get().finishedRuns).toEqual([]);
    expect(
      unique()
        .filter((n) => n.kind === 'run' || n.kind === 'step')
        .map((n) => n.status),
    ).toEqual(['working', 'working']);
    const final = attempt === 2;
    store.runEvent(
      { type: 'step', runId: 'r', key: 'a', label: 'Agent', kind: 'agent', status: final ? 'done' : 'failed' },
      lookup,
    );
    store.runEvent({ type: 'run', runId: 'r', status: final ? 'done' : 'failed' }, lookup);
    expect(store.get().finishedRuns).toHaveLength(1);
    expect(
      unique()
        .filter((n) => n.kind === 'run' || n.kind === 'step')
        .map((n) => n.status),
    ).toEqual(final ? ['done', 'done'] : ['failed', 'failed']);
  }
  // Defensive retention also replaces an existing snapshot of the same ID.
  store.update({ runs: [...store.get().finishedRuns] });
  store.runEvent({ type: 'run', runId: 'r', status: 'done' }, lookup);
  expect(store.get().finishedRuns).toHaveLength(1);
  expect(store.get().runs).toEqual([]);
  unique();
});

it('isolates subagent transcripts, updates the view and bounds finished children', () => {
  const store = new UiStore();
  const owner = { kind: 'orchestrator' } as const;
  for (let i = 0; i < 35; i++) {
    const id = String(i);
    store.subagentEvent(owner, {
      type: 'subagent_started',
      id,
      parent: null,
      agentType: 'Explore',
      description: id,
      prompt: null,
    });
    store.openView({ kind: 'sub', owner, id }, 'child');
    store.subagentEvent(owner, { type: 'subagent_event', id, event: { type: 'text_delta', text: 'hello' } });
    expect(store.get().view?.streaming).toBe('hello');
    expect(store.get().subagents.at(-1)?.activity).toBe('writing');
    store.subagentEvent(owner, { type: 'subagent_done', id, ok: false, result: 'failed' });
    expect(store.get().view?.items.some((i) => i.type === 'assistant' && i.text === 'hello')).toBe(true);
  }
  expect(store.get().items).toEqual([]);
  expect(store.get().subagents).toHaveLength(30);
  expect(store.get().subagents[0]?.id).toBe('5');
  expect(store.get().feed.at(-1)?.kind).toBe('error');
  store.closeView();
  expect(store.get().view).toBeNull();
});

it('feeds steps independently and bounds transcript storage', () => {
  const store = new UiStore();
  for (let i = 0; i < 70; i++) {
    const key = String(i);
    const ref = { kind: 'step', runId: 'r', key } as const;
    store.openView(ref, key);
    store.runEvent({ type: 'agent', runId: 'r', key, event: { type: 'message', text: key } }, () => null);
    expect(store.get().view?.items).toEqual([{ id: 1, type: 'assistant', text: key }]);
  }
  expect(store.transcriptOf({ kind: 'step', runId: 'r', key: '0' })).toBeNull();
  expect(store.transcriptOf({ kind: 'step', runId: 'r', key: '69' })).not.toBeNull();
});

it.each([true, false])('merges Codex metadata with discovery first: %s', (discoveryFirst) => {
  const store = new UiStore();
  const owner = { kind: 'orchestrator' } as const;
  const ref = { kind: 'sub', owner, id: 'child' } as const;
  const discovery = {
    type: 'subagent_started',
    id: 'child',
    parent: null,
    agentType: null,
    description: null,
    prompt: null,
  } as const;
  const spawn = { ...discovery, parent: 'root', agentType: 'explorer', description: 'Inspect files' };
  store.subagentEvent(owner, discoveryFirst ? discovery : spawn);
  store.subagentEvent(owner, {
    type: 'subagent_event',
    id: 'child',
    event: { type: 'message', text: 'Working' },
  });
  store.subagentEvent(owner, {
    type: 'subagent_event',
    id: 'child',
    event: { type: 'tool_call', id: 'tool', name: 'Read', input: { file_path: 'x.ts' }, kind: 'read' },
  });
  const before = store.get().subagents[0];
  const transcript = store.transcriptOf(ref);
  store.subagentEvent(owner, discoveryFirst ? spawn : discovery);
  expect(store.get().subagents).toEqual([
    { ...before, parent: 'root', agentType: 'explorer', description: 'Inspect files' },
  ]);
  expect(store.transcriptOf(ref)).toBe(transcript);
  expect(transcript?.items).toEqual([{ id: 1, type: 'assistant', text: 'Working' }]);
  store.subagentEvent(owner, { type: 'subagent_done', id: 'child', ok: false, result: 'failed' });
  const finished = store.get().subagents[0];
  store.subagentEvent(owner, { ...spawn, description: 'Updated description' });
  expect(store.get().subagents).toEqual([{ ...finished, description: 'Updated description' }]);
  expect(store.transcriptOf(ref)).toBe(transcript);
});
