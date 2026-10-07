/**
 * Human retry of an escalated task resumes the step that failed (re-review, re-merge, continue fixing)
 * instead of re-coding from scratch; `tasks.restart` is the explicit "start over".
 */
import type { InboxItem, Run, Task } from '@shared/domain';
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
const taskOf = (harness: Harness, runId: string): Task => harness.engine.store.listTasks(runId)[0] as Task;
const escalation = (harness: Harness, runId: string) =>
  harness.engine.store
    .listInbox({ runId, includeResolved: false })
    .find((i): i is Extract<InboxItem, { kind: 'escalation' }> => i.kind === 'escalation');
const coders = (harness: Harness) => harness.claude.sessions.filter((s) => s.opts.role === 'coder');

async function startRun(harness: Harness): Promise<Run> {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Retry',
    issueText: 'x',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
  await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  return run;
}

/** One task; the reviewer behaves as `review()` says at the time it runs. */
function script(review: (ctx: Parameters<Script>[0]) => ReturnType<Script>): Script {
  return (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
    if (ctx.opts.role === 'finalizer') return [approve(ctx)];
    if (ctx.opts.role === 'reviewer') return review(ctx);
    const id = taskIdIn(ctx.message);
    return [{ kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` }, report(`Implement ${id}`)];
  };
}

describe('tasks.retry resumes the failed step', () => {
  it('a reviewer failure is retried as a re-review, keeping the committed work', async () => {
    let reviewerUp = false;
    h = await startHarness({
      script: script((ctx) => (reviewerUp ? [approve(ctx)] : [{ kind: 'fail', message: 'not logged in' }])),
    });
    const harness = h;
    const run = await startRun(harness);
    const item = await harness.waitFor(() => escalation(harness, run.id), 'reviewer escalation', 30_000);
    expect(item.payload).toMatchObject({ actions: ['retry', 'skip', 'abort'], resume: 'review' });
    const before = taskOf(harness, run.id);
    const commit = await harness.repo.git('rev-parse', before.branch as string);

    reviewerUp = true;
    const retried = await harness.client.call('tasks.retry', { taskId: before.id, note: null });
    expect(retried.status).toBe('reviewing');
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    expect(coders(harness)).toHaveLength(1);
    expect(taskOf(harness, run.id)).toMatchObject({ status: 'merged', attemptCount: 1 });
    expect(harness.engine.store.getInboxItem(item.id)?.resolution).toEqual({ action: 'retry', note: null });
    expect(await harness.repo.git('rev-parse', before.branch as string)).toBe(commit);
  });

  it('exhausted fix rounds are retried as one more fix round in the same session, with the note', async () => {
    let approveNow = false;
    h = await startHarness({
      settings: { limits: { maxFixRounds: 1 } },
      script: script((ctx) => (approveNow ? [approve(ctx)] : [requestChangesOutput(`Problem ${Math.random()}`)])),
    });
    const harness = h;
    const run = await startRun(harness);
    const item = await harness.waitFor(() => escalation(harness, run.id), 'fix rounds exhausted', 30_000);
    expect(item.payload).toMatchObject({ reason: 'fix_rounds_exhausted', resume: 'fix' });
    expect(coders(harness)).toHaveLength(2); // coder + one fix round (resumed)

    approveNow = true;
    const task = taskOf(harness, run.id);
    const retried = await harness.client.call('tasks.retry', { taskId: task.id, note: 'Use the short name' });
    expect(retried).toMatchObject({ status: 'fixing', fixRounds: 1, attemptCount: 1 });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const fixer = coders(harness).at(-1);
    expect(fixer?.resumed).toBe(true);
    expect(fixer?.opts.prompt).toContain('Use the short name');
    expect(new Set(coders(harness).map((s) => s.id)).size).toBe(1);
  });

  it('a failed merge step is retried as a re-merge', async () => {
    h = await startHarness({ script: script((ctx) => [approve(ctx)]) });
    const harness = h;
    const store = harness.engine.store;
    const original = store.insertVerification.bind(store);
    let thrown = false;
    store.insertVerification = (input) => {
      if (input.phase === 'post_merge' && !thrown) {
        thrown = true;
        throw new Error('disk full');
      }
      return original(input);
    };
    const run = await startRun(harness);
    const item = await harness.waitFor(() => escalation(harness, run.id), 'merge escalation', 30_000);
    expect(item.payload.resume).toBe('merge');
    const retried = await harness.client.call('tasks.retry', { taskId: taskOf(harness, run.id).id, note: null });
    expect(['approved', 'merging', 'merged']).toContain(retried.status);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    expect(coders(harness)).toHaveLength(1);
  });
});

describe('tasks.restart', () => {
  it('starts over from scratch (also as the restart answer to an escalation)', async () => {
    let reviewerUp = false;
    h = await startHarness({
      script: script((ctx) => (reviewerUp ? [approve(ctx)] : [{ kind: 'fail', message: 'not logged in' }])),
    });
    const harness = h;
    const run = await startRun(harness);
    const item = await harness.waitFor(() => escalation(harness, run.id), 'reviewer escalation', 30_000);
    reviewerUp = true;
    await harness.client.call('inbox.resolve', {
      itemId: item.id,
      resolution: { kind: 'escalation', action: 'restart', note: 'Start clean' },
    });
    expect(harness.engine.store.getInboxItem(item.id)?.resolution).toEqual({ action: 'restart', note: 'Start clean' });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const fresh = coders(harness);
    expect(fresh).toHaveLength(2);
    expect(fresh[1]?.resumed).toBe(false);
    expect(fresh[1]?.opts.prompt).toContain('Start clean');
  });

  it('is refused for tasks that are not failed or awaiting a human', async () => {
    h = await startHarness({ script: script((ctx) => [approve(ctx)]) });
    const harness = h;
    const run = await startRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    await expect(harness.client.call('tasks.restart', { taskId: taskOf(harness, run.id).id })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
