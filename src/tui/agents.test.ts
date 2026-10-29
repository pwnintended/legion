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
