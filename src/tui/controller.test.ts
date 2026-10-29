import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FakeEngine } from '../engine/fake/index.ts';
import { type FixtureRepo, makeRepo } from '../git/test-helpers.ts';
import { Session } from '../session.ts';
import { Controller } from './controller.ts';

let repo: FixtureRepo;
let session: Session;
beforeEach(async () => {
  repo = await makeRepo();
  session = await Session.open({ cwd: repo.path, fake: true });
});
afterEach(async () => {
  await session.close();
  repo.cleanup();
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
