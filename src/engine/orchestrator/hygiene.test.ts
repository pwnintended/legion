/**
 * Worktree hygiene: what Legion's own commands (setup, verify) and provisioning (copy) leave in a worktree
 * never wedges a merge and never ends up in a commit.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  type Harness,
  node,
  planOutput,
  report,
  requestChangesOutput,
  type Script,
  startHarness,
  taskIdIn,
} from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);

describe('verify and setup leftovers (review finding: dirty integration worktree)', () => {
  it('a verify command that writes files wedges nothing and is never committed', async () => {
    const reviews = new Map<string, number>();
    const script: Script = (ctx) => {
      if (ctx.opts.role === 'planner') return [planOutput([node('T1'), node('T2')])];
      if (ctx.opts.role === 'finalizer') return [approve(ctx)];
      const id = taskIdIn(ctx.message);
      if (ctx.opts.role === 'reviewer') {
        const n = (reviews.get(id) ?? 0) + 1;
        reviews.set(id, n);
        // One fix round for T1: its next commit must not sweep up the previous verify's output.
        return id === 'T1' && n === 1 ? [requestChangesOutput('Polish it')] : [approve(ctx)];
      }
      return [
        { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id} ${reviews.get(id) ?? 0}\n` },
        report(`Implement ${id}`),
      ];
    };
    h = await startHarness({
      script,
      files: {
        'legion.json': JSON.stringify({
          copy: ['.env.local'],
          setup: ['touch setup-output.txt'],
          verify: ['touch verify-stamp.txt', 'echo appended >> README.md'],
        }),
      },
    });
    const harness = h;
    // Untracked and not ignored in the main checkout: copied into every worktree, never committed.
    writeFileSync(join(harness.repo.path, '.env.local'), 'SECRET=1\n');
    const run = await harness.client.call('runs.create', {
      repoPath: harness.repo.path,
      baseRef: 'main',
      title: 'Hygiene',
      issueText: 'x',
      issueUrl: null,
      plannerEngine: 'claude',
      plannerModel: null,
      skipClarify: true,
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    await harness.waitFor(
      () =>
        runOf(harness, run.id).status === 'pr_ready' ||
        harness.engine.store.listTasks(run.id).find((t) => t.status === 'awaiting_human'),
      'pr_ready',
      30_000,
    );
    const tasks = harness.engine.store.listTasks(run.id);
    expect(tasks.map((t) => `${t.nodeId}:${t.status}:${t.error ?? ''}`)).toEqual(['T1:merged:', 'T2:merged:']);
    expect(tasks.find((t) => t.nodeId === 'T1')?.fixRounds).toBe(1);

    const integration = runOf(harness, run.id).integrationBranch as string;
    const files = (rev: string) => harness.repo.git('ls-tree', '-r', '--name-only', rev);
    expect((await files(integration)).split('\n').sort()).toEqual([
      'README.md',
      'legion.json',
      'src/t1.txt',
      'src/t2.txt',
    ]);
    expect(await harness.repo.git('show', `${integration}:README.md`)).toBe('# fixture');
    for (const task of tasks) {
      const touched = await harness.repo.git('log', '--format=', '--name-only', `${task.startSha}..${task.branch}`);
      expect([...new Set(touched.split('\n').filter(Boolean))], task.nodeId).toEqual([
        `src/${task.nodeId.toLowerCase()}.txt`,
      ]);
      // The copy and setup output are still there for the agent and the next verify.
      expect(existsSync(join(task.worktreePath as string, '.env.local'))).toBe(true);
      expect(existsSync(join(task.worktreePath as string, 'setup-output.txt'))).toBe(true);
      expect(existsSync(join(task.worktreePath as string, 'verify-stamp.txt'))).toBe(false);
    }
    const integrationPath = harness.engine.orchestrator.integrationPath(runOf(harness, run.id));
    expect(await harness.repo.git('-C', integrationPath, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '?? .env.local\n?? setup-output.txt',
    );
  });
});
