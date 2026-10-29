import { expect, it } from 'vitest';
import { type AgentOwner, agentKey, type SubagentView, subagentLabel } from './agents.ts';

it('keys owners and their subagents', () => {
  const owners: AgentOwner[] = [
    { kind: 'orchestrator' },
    { kind: 'lead', name: 'reviewer' },
    { kind: 'step', runId: 'run', key: 'build' },
  ];
  const keys = ['orchestrator', 'lead:reviewer', 'step:run:build'];
  owners.forEach((owner, i) => {
    expect(agentKey(owner)).toBe(keys[i]);
    expect(agentKey({ kind: 'sub', owner, id: 'child' })).toBe(`${keys[i]}/sub:child`);
  });
});

it('labels subagents with optional type and a bounded single-line description', () => {
  const view: SubagentView = {
    owner: { kind: 'orchestrator' },
    id: 'child',
    parent: null,
    agentType: 'Explore',
    description: '  Find\n files  ',
    status: 'working',
    activity: null,
    startedAt: 0,
    endedAt: null,
  };
  expect(subagentLabel(view)).toBe('sub agent · Explore · Find files');
  expect(subagentLabel({ ...view, agentType: null })).toBe('sub agent · Find files');
  expect(subagentLabel({ ...view, description: 'x'.repeat(81) })).toBe(`sub agent · Explore · ${'x'.repeat(79)}…`);
  expect(subagentLabel({ ...view, agentType: null, description: null })).toBe('sub agent');
});

it('orders nested owners, runs, steps and children with unique selectable refs', async () => {
  const { UiStore } = await import('./store.ts');
  const { buildAgentTree } = await import('./agents.ts');
  const store = new UiStore();
  store.update({
    team: ['lead', 'nested'].map((name, depth) => ({
      name,
      depth,
      role: 'builder',
      status: 'idle',
      doing: null,
      progress: null,
      runs: 0,
      waiting: 0,
      inbox: 0,
      costUsd: 0,
    })),
  });
  const sub = (owner: AgentOwner, id: string, parent: string | null = null) =>
    store.subagentEvent(owner, {
      type: 'subagent_started',
      id,
      parent,
      agentType: null,
      description: id,
      prompt: null,
    });
  sub({ kind: 'orchestrator' }, 'root');
  sub({ kind: 'orchestrator' }, 'child', 'root');
  sub({ kind: 'lead', name: 'lead' }, 'lead-child');
  for (const [id, owner, done] of [
    ['r', undefined, false],
    ['f', 'lead', true],
    ['a', 'lead', false],
  ] as const) {
    store.update({
      runs: [
        ...store.get().runs,
        {
          id,
          owner,
          workflow: 'build',
          startedAt: 0,
          steps: [
            {
              key: 'code',
              label: 'Code',
              kind: 'agent',
              status: done ? 'done' : 'started',
              detail: null,
              activity: null,
              engine: null,
              startedAt: 0,
              endedAt: null,
            },
          ],
        },
      ],
    });
    sub({ kind: 'step', runId: id, key: 'code' }, id);
    if (done) store.runEvent({ type: 'run', runId: id, status: 'done' }, () => null);
  }
  const nodes = buildAgentTree(store.get());
  expect(nodes.map((n) => [n.label, n.depth, n.status, n.talkable, n.ref === null])).toEqual([
    ['orchestrator', 0, 'idle', true, false],
    ['sub agent · root', 1, 'working', false, false],
    ['sub agent · child', 2, 'working', false, false],
    ['build r', 1, 'working', false, true],
    ['Code', 2, 'working', false, false],
    ['sub agent · r', 3, 'working', false, false],
    ['lead', 1, 'idle', true, false],
    ['sub agent · lead-child', 2, 'working', false, false],
    ['build a', 2, 'working', false, true],
    ['Code', 3, 'working', false, false],
    ['sub agent · a', 4, 'working', false, false],
    ['build f', 2, 'done', false, true],
    ['Code', 3, 'done', false, false],
    ['sub agent · f', 4, 'working', false, false],
    ['nested', 2, 'idle', true, false],
  ]);
  expect(nodes.every((n) => n.ref === null || n.key === agentKey(n.ref))).toBe(true);
});
