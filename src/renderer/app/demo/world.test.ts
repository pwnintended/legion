import { checkScope } from '@engine/orchestrator/core/scope';
import { describe, expect, it } from 'vitest';
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
});
