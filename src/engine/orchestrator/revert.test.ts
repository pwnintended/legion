/** `tasks.revertHunk`: one hunk of a task's diff taken back out of its worktree, and the patch it applies. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hunkPatch } from './revert';
import { type Harness, node, planOutput, startHarness } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('hunk patch', () => {
  it('writes one hunk as a unified diff git can apply', () => {
    const patch = hunkPatch('src/a.ts', {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      header: '',
      lines: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'keep' },
        { kind: 'del', oldLine: 2, newLine: null, text: 'old' },
        { kind: 'add', oldLine: null, newLine: 2, text: 'new' },
        { kind: 'no_newline', oldLine: null, newLine: null, text: '' },
      ],
    });
    expect(patch).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
  });
});

describe('tasks.revertHunk', () => {
  it("takes a hunk back out of a running task's worktree (left for its next commit), and refuses a stale one", async () => {
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role === 'planner') return [planOutput([node('T1', { writes: ['README.md'] })])];
        return [
          { kind: 'write_file', path: 'README.md', content: '# changed by the agent\n' },
          { kind: 'delay', ms: 60_000 },
        ];
      },
    });
    const harness = h;
    const run = await harness.client.call('runs.create', {
      repoPath: harness.repo.path,
      baseRef: null,
      title: null,
      issueText: 'Revert',
      issueUrl: null,
      plannerEngine: 'claude',
      plannerModel: null,
      skipClarify: true,
    });
    await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    const task = await harness.waitFor(() => {
      const t = harness.engine.store.listTasks(run.id)[0];
      return t?.status === 'running' &&
        harness.events.some(
          (e) => e.type === 'agent.event' && e.event.type === 'file_change' && e.event.path === 'README.md',
        )
        ? t
        : undefined;
    }, 'coder edits');
    const worktree = task.worktreePath as string;
    const original = readFileSync(join(harness.repo.path, 'README.md'), 'utf8');
    const diff = await harness.client.call('diff.get', { target: { kind: 'task', taskId: task.id }, contextLines: 3 });
    const file = diff.files.find((f) => f.path === 'README.md');
    const hunk = file?.hunks[0];
    if (!hunk) throw new Error('no hunk');

    const result = await harness.client.call('tasks.revertHunk', { taskId: task.id, path: 'README.md', hunk });
    expect(result).toEqual({ committed: false });
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe(original);
    // The same hunk again no longer matches what is there.
    await expect(
      harness.client.call('tasks.revertHunk', { taskId: task.id, path: 'README.md', hunk }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      harness.client.call('tasks.revertHunk', { taskId: task.id, path: '../outside.md', hunk }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await harness.client.call('runs.cancel', { runId: run.id });
  });
});
