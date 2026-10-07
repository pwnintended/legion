/**
 * Merge bookkeeping across failures and crashes: a merge row stays `pending` until integration is back at
 * a known state, and recovery only ever rolls back the newest unfinished merge when it is still HEAD.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Merge, Run } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { git, gitText } from '../git';
import { settlePendingMerges } from './merge';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const script: Script = (ctx) => {
  if (ctx.opts.role === 'planner') return [planOutput([node('T1'), node('T2', { dependsOn: ['T1'] })])];
  if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
  const id = taskIdIn(ctx.message);
  return [{ kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` }, report(`Implement ${id}`)];
};

async function startRun(harness: Harness): Promise<Run> {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Merges',
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

describe('merge bookkeeping', () => {
  it('an exception after the squash resets integration and closes the row; the retry verifies again', async () => {
    h = await startHarness({ script });
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
    const t1 = await harness.waitFor(
      () => store.listTasks(run.id).find((t) => t.nodeId === 'T1' && t.status === 'awaiting_human'),
      'T1 escalated',
      30_000,
    );
    expect(t1.error).toContain('disk full');
    const integration = harness.engine.orchestrator.integrationPath(run);
    const [row] = store.listMerges(run.id);
    expect(row).toMatchObject({ status: 'reverted', taskId: t1.id });
    expect(await gitText(integration, ['rev-parse', 'HEAD'])).toBe(row?.preSha);

    await harness.client.call('tasks.approveMerge', { taskId: t1.id });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const t1Verifies = store.listVerifications(run.id).filter((v) => v.phase === 'post_merge' && v.taskId === t1.id);
    expect(t1Verifies.length).toBeGreaterThan(0);
    expect(store.listMerges(run.id).map((m) => m.status)).toEqual(['reverted', 'merged', 'merged']);
  });
});

describe('settlePendingMerges (crash points)', () => {
  async function setup() {
    h = await startHarness({ script });
    const harness = h;
    const run = await startRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const o = harness.engine.orchestrator;
    const integration = o.integrationPath(run);
    const store = harness.engine.store;
    const task = store.listTasks(run.id)[1] as { id: string };
    const head = () => gitText(integration, ['rev-parse', 'HEAD']);
    let n = 0;
    const commit = async () => {
      writeFileSync(join(integration, `crash-${++n}.txt`), 'x\n');
      await git(integration, ['add', '-A']);
      await git(integration, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `C${n}`]);
      return head();
    };
    const pending = async (preSha: string): Promise<Merge> => {
      await tick();
      return store.insertMerge({ runId: run.id, taskId: task.id, preSha });
    };
    const settle = () => settlePendingMerges(o, runOf(harness, run.id), integration);
    const status = (m: Merge) => store.listMerges(run.id).find((x) => x.id === m.id);
    const reset = (sha: string) => git(integration, ['reset', '-q', '--hard', sha]);
    return { harness, store, head, commit, pending, settle, status, reset };
  }

  it('before the squash: nothing to undo', async () => {
    const { head, pending, settle, status } = await setup();
    const before = await head();
    const row = await pending(before);
    await settle();
    expect(await head()).toBe(before);
    expect(status(row)).toMatchObject({ status: 'reverted', error: expect.stringContaining('nothing was committed') });
  });

  it('after the squash commit, before it was recorded: rolled back', async () => {
    const { head, commit, pending, settle, status } = await setup();
    const before = await head();
    const row = await pending(before);
    await commit();
    await settle();
    expect(await head()).toBe(before);
    expect(status(row)).toMatchObject({ status: 'reverted', error: expect.stringContaining('rolled back') });
  });

  it('during the post-merge verify (commit recorded): rolled back', async () => {
    const { store, head, commit, pending, settle, status } = await setup();
    const before = await head();
    const row = await pending(before);
    store.recordMergeCommit(row.id, await commit());
    await settle();
    expect(await head()).toBe(before);
    expect(status(row)?.status).toBe('reverted');
  });

  it('after a failed verify reset integration but before the row was closed: nothing to undo', async () => {
    const { store, head, commit, pending, settle, status, reset } = await setup();
    const before = await head();
    const row = await pending(before);
    store.recordMergeCommit(row.id, await commit());
    await reset(before); // the reset ran; the engine died before the row was written
    await settle();
    expect(await head()).toBe(before);
    expect(status(row)).toMatchObject({ status: 'reverted', error: expect.stringContaining('nothing was committed') });
  });

  it('never resets over a later completed merge, and closes every older pending row', async () => {
    const { store, head, commit, pending, settle, status } = await setup();
    const base = await head();
    const stale = await pending(base); // cut off before committing; another merge then completed on top
    const older = await pending(base);
    const laterMerge = await pending(base);
    const later = await commit();
    store.finishMerge(laterMerge.id, 'merged', { postSha: later });
    await settle();
    expect(await head()).toBe(later);
    expect(status(stale)?.status).toBe('reverted');
    expect(status(older)).toMatchObject({ status: 'reverted', error: expect.stringContaining('moved on') });
  });
});
