import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FakeEngine } from '../engine/fake/index.ts';
import { type FixtureRepo, makeRepo } from '../git/test-helpers.ts';
import { Session } from '../session.ts';
import { Controller } from './controller.ts';

let repo: FixtureRepo;
let session: Session;
beforeEach(async () => {
  repo = await makeRepo();
  vi.stubEnv('XDG_CONFIG_HOME', join(repo.path, '.xdg'));
  session = await Session.open({ cwd: repo.path, fake: true });
});
afterEach(async () => {
  await session.close();
  repo.cleanup();
  vi.unstubAllEnvs();
});

it('tracks orchestrator subagents and opens their transcript through the agents menu', async () => {
  (session.engine('claude') as FakeEngine).script = () => ({
    text: 'parent reply',
    subagents: [{ type: 'explorer', description: 'inspect files', text: 'child reply' }],
  });
  const controller = new Controller(session);
  await controller.submit('hello');
  await expect.poll(() => controller.store.get().subagents.length).toBe(1);
  const node = controller.agentTree().find((n) => n.kind === 'sub');
  expect(node?.label).toBe('sub agent · explorer · inspect files');
  await controller.command('/agents');
  expect(controller.store.get().menu).toBe('agents');
  if (!node?.ref) throw new Error('Missing subagent');
  controller.openAgent(node.ref);
  expect(controller.store.get().menu).toBeNull();
  expect(controller.store.get().view?.items).toContainEqual(expect.objectContaining({ text: 'child reply' }));
  controller.closeView();
  expect(controller.store.get().view).toBeNull();
});

it('replays a step transcript from its journal after a fake run', async () => {
  mkdirSync(join(repo.path, '.legion', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo.path, '.legion', 'workflows', 'hello.ts'),
    `import { workflow, agent, z } from 'legion';
export default workflow({ name: 'hello', description: 'Hello', input: z.object({}) }, async () => agent('greet', { prompt: 'hello' }));`,
  );
  const run = await session.runs.start('hello', {});
  await session.runs.wait(run);
  // A fresh controller has no in-memory history of the completed run.
  const controller = new Controller(session);
  const entry = session.runs
    .journal(run)
    .all()
    .find((e) => e.kind === 'agent');
  expect(entry).toBeDefined();
  if (!entry) throw new Error('Missing agent step');
  const ref = { kind: 'step' as const, runId: run, key: entry.key };
  expect(controller.store.transcriptOf(ref)).toBeNull();
  controller.openAgent(ref);
  expect(controller.store.get().view?.items.length).toBeGreaterThan(0);
  controller.openAgent({ kind: 'orchestrator' });
  expect(controller.store.get().view).toBeNull();
});

it('tracks subagents from every lead even when talking to the orchestrator', () => {
  const controller = new Controller(session);
  for (const lead of ['alpha', 'beta']) {
    session.team.emit('lead-event', lead, {
      type: 'subagent_started',
      id: 'child',
      parent: null,
      agentType: 'explorer',
      description: lead,
      prompt: null,
    });
    session.team.emit('lead-event', lead, {
      type: 'subagent_event',
      id: 'child',
      event: { type: 'message', text: lead },
    });
    const ref = { kind: 'sub' as const, owner: { kind: 'lead' as const, name: lead }, id: 'child' };
    controller.openAgent(ref);
    expect(controller.store.get().view?.items).toContainEqual(expect.objectContaining({ text: lead }));
  }
  expect(controller.store.get().subagents).toHaveLength(2);
});

it.each([false, true])('restores evicted history after more events, child: %s', (child) => {
  const controller = new Controller(session);
  const owner = { kind: 'step', runId: 'eviction', key: 'step' } as const;
  const ref = child ? { kind: 'sub' as const, owner, id: 'child' } : owner;
  const events = [
    { type: 'message' as const, text: 'earlier' },
    { type: 'message' as const, text: 'later' },
  ];
  const envelopes = events.map((event) => (child ? { type: 'subagent_event' as const, id: 'child', event } : event));
  if (child)
    controller.store.subagentEvent(owner, {
      type: 'subagent_started',
      id: 'child',
      parent: null,
      agentType: null,
      description: null,
      prompt: null,
    });
  const [first, second] = envelopes;
  if (!first || !second) throw new Error('Missing events');
  controller.store.runEvent({ type: 'agent', runId: owner.runId, key: owner.key, event: first }, () => null);
  for (let i = 0; i < 65; i++) {
    if (child)
      controller.store.subagentEvent(owner, {
        type: 'subagent_started',
        id: String(i),
        parent: null,
        agentType: null,
        description: null,
        prompt: null,
      });
    else controller.store.openView({ kind: 'step', runId: 'other', key: String(i) }, 'other');
  }
  controller.store.runEvent({ type: 'agent', runId: owner.runId, key: owner.key, event: second }, () => null);
  expect(controller.store.transcriptIncomplete(ref)).toBe(true);
  const path = session.runs.journal(owner.runId).transcriptPath(owner.key);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, envelopes.map((event) => JSON.stringify({ ts: 1, event })).join('\n'));
  controller.openAgent(ref);
  expect(controller.store.get().view?.items.map((item) => ('text' in item ? item.text : null))).toEqual([
    'earlier',
    'later',
  ]);
  expect(controller.store.transcriptIncomplete(ref)).toBe(false);
});
