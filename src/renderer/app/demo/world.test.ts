import { checkScope } from '@engine/orchestrator/core/scope';
import { latestVerifications, taskGates } from '@renderer/tiles/review/evidence';
import { describe, expect, it } from 'vitest';
import { DemoClient } from './client';
import { createDemoWorld, type DemoWorld } from './fixtures';
import { withLifecycleDemo } from './lifecycle';
import { type DemoStage, extendDemoWorld } from './plan-review';

const NOW = 1_000_000_000_000;

function world(stage: DemoStage): DemoWorld {
  const w = createDemoWorld(NOW);
  extendDemoWorld(w, NOW, stage);
  return withLifecycleDemo(w, NOW);
}

/**
 * The demo world is assembled from several fixture modules (fixtures.ts, sessions.ts, plan-review.ts) that
 * describe the same tasks, so they must agree: a transcript that edits a file outside its node's declared
 * touches turns the review pack's scope gate red for reasons nobody intended.
 */
describe('demo world', () => {
  for (const stage of ['fixing', 'gate'] as const) {
    it(`keeps every task's file changes inside its declared touches (${stage})`, () => {
      const w = world(stage);
      for (const task of w.tasks) {
        const plan = w.plans
          .filter((p) => p.runId === task.runId)
          .sort((a, b) => a.version - b.version)
          .at(-1);
        const node = plan?.dag.nodes.find((n) => n.id === task.nodeId);
        if (!node) continue;
        const files = w.attempts
          .filter((a) => a.taskId === task.id)
          .flatMap((a) => w.transcripts[a.id] ?? [])
          .flatMap((e) => (e.type === 'file_change' ? [e.path] : []));
        const label = `${task.runId}/${task.nodeId}`;
        expect({ label, outOfScope: checkScope(node, files).outOfScope }).toEqual({ label, outOfScope: [] });
      }
    });
  }

  it('reviews only judge acceptance criteria their node declares', () => {
    const w = world('gate');
    for (const review of w.reviews.filter((r) => r.taskId !== null)) {
      const task = w.tasks.find((t) => t.id === review.taskId);
      const node = w.plans.find((p) => p.runId === review.runId)?.dag.nodes.find((n) => n.id === task?.nodeId);
      const ids = new Set(node?.acceptanceCriteria.map((c) => c.id));
      for (const c of review.criteria) expect(ids.has(c.id), `${review.id} ${c.id}`).toBe(true);
    }
  });

  it("shows T4's six persisted gates green, its scope row agreeing with checkScope", () => {
    const w = world('gate');
    const task = w.tasks.find((t) => t.id === 'task_authv2demo01t4');
    const node = w.plans.find((p) => p.runId === task?.runId)?.dag.nodes.find((n) => n.id === 'T4');
    if (!task || !node) throw new Error('T4 missing');
    const files = w.attempts
      .filter((a) => a.taskId === task.id)
      .flatMap((a) => w.transcripts[a.id] ?? [])
      .flatMap((e) => (e.type === 'file_change' ? [e.path] : []));
    const gates = taskGates({
      taskId: task.id,
      node,
      verifications: w.verifications,
      attempts: w.attempts,
      diffstats: { att_authv2t4code: { files } },
    });
    expect(gates.map((g) => g.label)).toHaveLength(6);
    expect(gates.every((g) => g.status === 'pass')).toBe(true);
    const scope = checkScope(node, files);
    const total = scope.inScope.length + scope.outOfScope.length;
    expect(scope.outOfScope).toEqual([]);
    expect(gates.find((g) => g.kind === 'scope')?.evidence).toBe(`${total}/${total} files declared`);
  });

  it('gives every merged task the test, typecheck, lint, scope and secrets gates', () => {
    const w = world('gate');
    for (const task of w.tasks.filter((t) => t.status === 'merged')) {
      const names = latestVerifications(w.verifications, task.id).map((v) => v.gate);
      for (const gate of ['test', 'typecheck', 'lint', 'scope', 'secrets'])
        expect(names, `${task.id} ${gate}`).toContain(gate);
    }
  });

  it('shows a warn-only gate failure on a reviewed task', () => {
    const w = world('gate');
    const failed = w.verifications.filter((v) => v.phase === 'task' && v.status === 'fail');
    expect(failed.some((v) => v.blocking === false)).toBe(true);
  });

  it('round-trips projects.setGates', async () => {
    const client = new DemoClient({ live: false, now: NOW });
    const [project] = await client.call('projects.list', {});
    if (!project) throw new Error('no demo project');
    const before = await client.call('projects.gates', { projectId: project.id });
    expect(before.detected.map((g) => g.name)).toEqual(['test', 'typecheck', 'lint']);
    expect(before.resolved.map((g) => g.source)).toContain('verify');
    const gates = { commands: { smoke: 'pnpm smoke' }, scope: 'warn' as const, secrets: 'warn' as const };
    const after = await client.call('projects.setGates', { projectId: project.id, revision: before.revision, gates });
    expect(after.gates).toEqual(gates);
    expect(after.settings.scope).toBe('warn');
    expect(after.resolved.find((g) => g.name === 'smoke')?.source).toBe('config');
    expect(await client.call('projects.gates', { projectId: project.id })).toEqual(after);
    await expect(
      client.call('projects.setGates', { projectId: project.id, revision: before.revision, gates }),
    ).rejects.toMatchObject({ code: 'conflict' });
    client.dispose();
  });
});
