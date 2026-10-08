/**
 * The integration pass: plan annotations across human edits, PR status + refresh/polling, cleanup
 * (`runs.archive`), the coder's report on the task row, same-engine review with another model, and engine
 * settings that apply without a restart.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { DEFAULT_SETTINGS, type Run, type Settings, type Task } from '@shared/domain';
import type { ServerEvent } from '@shared/events';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient } from '@shared/rpc-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../adapters/fake';
import { silentLogger } from '../context';
import { git } from '../git';
import { tmp } from '../git/test-helpers';
import { startEngine } from '../index';
import { startPrPolling } from './cleanup';
import { undoAutoEdge } from './core';
import { EngineRegistry } from './registry';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);
const tasksOf = (harness: Harness, runId: string): Task[] => harness.engine.store.listTasks(runId);

function basicScript(nodes: ReturnType<typeof node>[]): Script {
  return (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput(nodes)];
    if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
    const id = taskIdIn(ctx.message);
    return [{ kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` }, report(`Implement ${id}`)];
  };
}

async function createRun(harness: Harness): Promise<Run> {
  return harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Test run',
    issueText: 'Do the thing.',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
}

async function toPrReady(harness: Harness): Promise<Run> {
  const run = await createRun(harness);
  await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
  return runOf(harness, run.id);
}

const legionBranches = async (harness: Harness): Promise<string[]> =>
  (await harness.repo.git('branch', '--list', 'legion/*', '--format=%(refname:short)')).split('\n').filter(Boolean);

const gcAuto = async (harness: Harness): Promise<string | null> => {
  const r = await git(harness.repo.path, ['config', '--local', '--get', 'gc.auto'], { okExitCodes: [0, 1] });
  return r.exitCode === 0 ? r.stdout.trim() : null;
};

describe('plan annotations survive human edits', () => {
  it('keeps an undone auto edge undone across runs.updatePlan (and re-adds it without the annotations)', async () => {
    const shared = (id: string) => node(id, { writes: ['src/shared.txt', `src/${id.toLowerCase()}.txt`] });
    h = await startHarness({ script: basicScript([shared('T1'), shared('T2')]) });
    const harness = h;
    const run = await createRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const v1 = harness.engine.store.latestPlan(run.id);
    if (!v1) throw new Error('no plan');
    expect(v1.dag.nodes.find((n) => n.id === 'T2')?.dependsOn).toEqual(['T1']);
    expect(v1.dag.annotations.filter((a) => a.kind === 'serializing_edge').map((a) => a.nodeIds)).toEqual([
      ['T1', 'T2'],
    ]);

    // The DAG tile undoes the auto edge and sends the annotations along.
    const undone = undoAutoEdge(v1.dag, 'T1', 'T2');
    const v2 = await harness.client.call('runs.updatePlan', {
      runId: run.id,
      basePlanId: v1.id,
      markdown: v1.markdown,
      nodes: undone.nodes,
      annotations: undone.annotations,
    });
    expect(v2.dag.nodes.find((n) => n.id === 'T2')?.dependsOn).toEqual([]);
    expect(v2.dag.annotations.some((a) => a.kind === 'serializing_edge')).toBe(false);
    expect(v2.dag.annotations.find((a) => a.message.startsWith('[overlap_accepted]'))?.nodeIds).toEqual(['T1', 'T2']);

    // A later edit without annotations keeps the base version's decision.
    const renamed = v2.dag.nodes.map((n) => (n.id === 'T1' ? { ...n, title: 'Renamed' } : n));
    const v3 = await harness.client.call('runs.updatePlan', {
      runId: run.id,
      basePlanId: v2.id,
      markdown: v2.markdown,
      nodes: renamed,
    });
    expect(v3.dag.nodes.find((n) => n.id === 'T2')?.dependsOn).toEqual([]);

    // Annotations without the accepted overlap (restoreAutoEdge) serialize the pair again.
    const v4 = await harness.client.call('runs.updatePlan', {
      runId: run.id,
      basePlanId: v3.id,
      markdown: v3.markdown,
      nodes: v3.dag.nodes,
      annotations: [],
    });
    expect(v4.dag.nodes.find((n) => n.id === 'T2')?.dependsOn).toEqual(['T1']);

    // Approval re-validates the stored DAG: the accepted overlap holds there too.
    const v5 = await harness.client.call('runs.updatePlan', {
      runId: run.id,
      basePlanId: v4.id,
      markdown: v4.markdown,
      nodes: undoAutoEdge(v4.dag, 'T1', 'T2').nodes,
      annotations: undoAutoEdge(v4.dag, 'T1', 'T2').annotations,
    });
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: v5.id });
    const plan = harness.engine.orchestrator.approvedPlan(run.id);
    expect(plan?.dag.nodes.find((n) => n.id === 'T2')?.dependsOn).toEqual([]);
  });
});

describe('PR status, task reports and cleanup', () => {
  it('stores the PR and the coder report, refreshes the PR, archives the run when it is merged', async () => {
    h = await startHarness({ script: basicScript([node('T1'), node('T2', { dependsOn: ['T1'] })]) });
    const harness = h;
    const run = await toPrReady(harness);
    const integration = run.integrationBranch as string;
    expect(run).toMatchObject({ pr: null, archived: false });
    expect(tasksOf(harness, run.id).map((t) => t.report)).toEqual([
      { summary: 'Implement T1', commitMessage: 'Implement T1' },
      { summary: 'Implement T2', commitMessage: 'Implement T2' },
    ]);
    expect(await gcAuto(harness)).toBe('0');
    await expect(harness.client.call('runs.refreshPr', { runId: run.id })).rejects.toMatchObject({
      code: 'failed_precondition',
    });

    const created = await harness.client.call('runs.createPr', { runId: run.id, title: null, body: null });
    const pr = { url: 'https://github.invalid/legion/fake/pull/1', number: 1, state: 'open', isDraft: true };
    expect(created.run).toMatchObject({ status: 'done', prUrl: pr.url, pr, archived: false });
    expect(await gcAuto(harness)).toBeNull();

    harness.prHost.setState(integration, { isDraft: false });
    expect(await harness.client.call('runs.refreshPr', { runId: run.id })).toMatchObject({
      pr: { ...pr, isDraft: false },
      archived: false,
    });
    const taskPaths = tasksOf(harness, run.id).map((t) => t.worktreePath as string);
    expect(taskPaths.every((p) => existsSync(p))).toBe(true);

    harness.prHost.setState(integration, { state: 'merged' });
    const merged = await harness.client.call('runs.refreshPr', { runId: run.id });
    expect(merged).toMatchObject({ status: 'done', archived: true, pr: { state: 'merged' } });
    expect(taskPaths.some((p) => existsSync(p))).toBe(false);
    expect(existsSync(harness.engine.orchestrator.integrationPath(run))).toBe(false);
    expect(await legionBranches(harness)).toEqual([]);
    expect((await harness.repo.git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
    expect(await gcAuto(harness)).toBeNull();

    expect((await harness.client.call('runs.list', {})).map((s) => s.run.id)).toEqual([]);
    expect((await harness.client.call('runs.list', { includeArchived: true })).map((s) => s.run.id)).toEqual([run.id]);
    // Idempotent.
    expect(await harness.client.call('runs.archive', { runId: run.id })).toMatchObject({ archived: true });
    expect(harness.events.filter((e) => e.type === 'run.updated' && e.run.archived).length).toBe(1);
  });

  it('keeps the integration branch while the PR is open; the poll finishes a closed PR but keeps its work', async () => {
    h = await startHarness({ script: basicScript([node('T1')]) });
    const harness = h;
    const run = await toPrReady(harness);
    const integration = run.integrationBranch as string;
    await harness.client.call('runs.createPr', { runId: run.id, title: null, body: null });
    const archived = await harness.client.call('runs.archive', { runId: run.id });
    expect(archived).toMatchObject({ archived: true, pr: { state: 'open' } });
    expect(archived.archiveReport?.kept).toEqual([
      { kind: 'branch', name: integration, reason: 'the pull request is open' },
    ]);
    // The task branch went: its squashed content is in integration.
    expect(await legionBranches(harness)).toEqual([integration]);
    expect(existsSync(harness.engine.orchestrator.integrationPath(run))).toBe(false);

    // An archived run is not polled; a closed PR of a live run is: the run is done, nothing is deleted.
    const second = await toPrReady(harness);
    await harness.client.call('runs.createPr', { runId: second.id, title: null, body: null });
    const secondBranches = (await legionBranches(harness)).filter((b) => b !== integration);
    harness.prHost.setState(second.integrationBranch as string, { state: 'closed' });
    harness.prHost.setState(integration, { state: 'merged' });
    const stop = startPrPolling(harness.engine.orchestrator, 20);
    try {
      await harness.waitFor(() => runOf(harness, second.id).pr?.state === 'closed', 'poll sees the closed PR');
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      stop();
    }
    expect(runOf(harness, second.id)).toMatchObject({ status: 'done', archived: false });
    expect(existsSync(harness.engine.orchestrator.integrationPath(second))).toBe(true);
    expect(runOf(harness, run.id).pr?.state).toBe('open');
    expect(await legionBranches(harness)).toEqual([integration, ...secondBranches].sort());

    // Archived by hand later: the closed PR's branch is fully pushed, so it can go.
    const done = await harness.client.call('runs.archive', { runId: second.id });
    expect(done.archiveReport?.kept).toEqual([]);
    expect(await legionBranches(harness)).toEqual([integration]);

    // A closed PR whose branch has local commits that were never pushed: kept.
    const third = await toPrReady(harness);
    await harness.client.call('runs.createPr', { runId: third.id, title: null, body: null });
    harness.prHost.setState(third.integrationBranch as string, { state: 'closed' });
    await harness.client.call('runs.refreshPr', { runId: third.id });
    const thirdPath = harness.engine.orchestrator.integrationPath(third);
    writeFileSync(join(thirdPath, 'later.txt'), 'local only\n');
    await git(thirdPath, ['add', 'later.txt']);
    await git(thirdPath, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'local']);
    const kept = await harness.client.call('runs.archive', { runId: third.id });
    expect(kept.archiveReport?.kept).toEqual([
      {
        kind: 'branch',
        name: third.integrationBranch,
        reason: 'the pull request was closed and the branch is not fully pushed',
      },
    ]);
  });

  it('refuses to archive an active run unless forced; forced, it cancels and drops the empty planner branch', async () => {
    h = await startHarness({ script: basicScript([node('T1')]) });
    const harness = h;
    const run = await createRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    expect(existsSync(harness.engine.orchestrator.integrationPath(run))).toBe(true);
    await expect(harness.client.call('runs.archive', { runId: run.id })).rejects.toMatchObject({
      code: 'failed_precondition',
    });
    expect(runOf(harness, run.id)).toMatchObject({ status: 'awaiting_approval', archived: false });
    const archived = await harness.client.call('runs.archive', { runId: run.id, force: true });
    expect(archived).toMatchObject({ status: 'cancelled', archived: true, archiveReport: { kept: [] } });
    expect(harness.engine.store.listInbox({ runId: run.id, includeResolved: false })).toEqual([]);
    expect(existsSync(harness.engine.orchestrator.integrationPath(run))).toBe(false);
    expect(await legionBranches(harness)).toEqual([]);
  });

  it('a forced archive of a run with unmerged work keeps that work and says so (review finding: data loss)', async () => {
    h = await startHarness({ script: basicScript([node('T1'), node('T2', { dependsOn: ['T1'], risk: 'high' })]) });
    const harness = h;
    const run = await createRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    const t2 = await harness.waitFor(
      () => tasksOf(harness, run.id).find((t) => t.nodeId === 'T2' && t.status === 'awaiting_human'),
      'T2 at the human gate',
      30_000,
    );
    const t1 = tasksOf(harness, run.id).find((t) => t.nodeId === 'T1') as Task;
    const integration = runOf(harness, run.id).integrationBranch as string;
    // A human edited T2's worktree (e.g. during a takeover) without committing.
    writeFileSync(join(t2.worktreePath as string, 'wip.txt'), 'human work\n');

    await expect(harness.client.call('runs.archive', { runId: run.id })).rejects.toMatchObject({
      code: 'failed_precondition',
    });
    const archived = await harness.client.call('runs.archive', { runId: run.id, force: true });
    expect(archived).toMatchObject({ status: 'cancelled', archived: true });
    expect(archived.archiveReport?.kept).toEqual(
      expect.arrayContaining([
        { kind: 'branch', name: integration, reason: 'its work is not merged anywhere (no pull request)' },
      ]),
    );
    // Forced: the task branch and worktree go even with unmerged/uncommitted work; integration never does.
    expect(await legionBranches(harness)).toEqual([integration]);
    expect(existsSync(t2.worktreePath as string)).toBe(false);
    expect(t1.status).toBe('merged');
  });

  it('archiving a cancelled run keeps unmerged task work and dirty worktrees', async () => {
    h = await startHarness({ script: basicScript([node('T1'), node('T2', { dependsOn: ['T1'], risk: 'high' })]) });
    const harness = h;
    const run = await createRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    const t2 = await harness.waitFor(
      () => tasksOf(harness, run.id).find((t) => t.nodeId === 'T2' && t.status === 'awaiting_human'),
      'T2 at the human gate',
      30_000,
    );
    const t1 = tasksOf(harness, run.id).find((t) => t.nodeId === 'T1') as Task;
    const integration = runOf(harness, run.id).integrationBranch as string;
    writeFileSync(join(t2.worktreePath as string, 'wip.txt'), 'human work\n');
    await harness.client.call('runs.cancel', { runId: run.id });

    const archived = await harness.client.call('runs.archive', { runId: run.id });
    expect(archived.archived).toBe(true);
    const kept = archived.archiveReport?.kept ?? [];
    expect(kept.map((k) => `${k.kind}:${k.name}`).sort()).toEqual(
      [`branch:${integration}`, `branch:${t2.branch}`, `worktree:${t2.worktreePath}`].sort(),
    );
    expect(kept.find((k) => k.kind === 'worktree')?.reason).toContain('wip.txt');
    // T1's work is in integration: its branch and worktree are gone. T2's are untouched.
    expect(await legionBranches(harness)).toEqual([integration, t2.branch as string].sort());
    expect(existsSync(t1.worktreePath as string)).toBe(false);
    expect(existsSync(join(t2.worktreePath as string, 'wip.txt'))).toBe(true);

    // "Remove everything": a second archive with discard clears what was kept, integration branch included.
    const cleared = await harness.client.call('runs.archive', { runId: run.id, discard: true });
    expect(cleared).toMatchObject({ archived: true, archiveReport: { kept: [], problems: [] } });
    expect(await legionBranches(harness)).toEqual([]);
    expect(existsSync(t2.worktreePath as string)).toBe(false);
    expect((await harness.repo.git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  });
});

describe('merging locally instead of a PR', () => {
  it('lands the run on the local main as one merge commit; archiving then removes every branch', async () => {
    h = await startHarness({ script: basicScript([node('T1'), node('T2', { dependsOn: ['T1'] })]) });
    const harness = h;
    const run = await toPrReady(harness);
    const landed = await harness.client.call('runs.mergeLocally', { runId: run.id, title: 'Ship it', body: null });
    const main = await harness.repo.git('rev-parse', 'main');
    expect(landed.sha).toBe(main);
    expect(landed.run).toMatchObject({ status: 'done', pr: null, prUrl: null, merged: { into: 'main', sha: main } });
    expect(await harness.repo.git('log', '-1', '--format=%s', 'main')).toBe('Ship it');
    expect(await harness.repo.git('show', 'main:src/t2.txt')).toBe('T2');
    expect(await harness.repo.git('status', '--porcelain')).toBe('');
    expect(harness.prHost.pushes).toEqual([]);
    const item = harness.engine.store
      .listInbox({ runId: run.id, includeResolved: true })
      .find((i) => i.kind === 'pr_ready');
    expect(item?.resolution).toMatchObject({ approved: true, title: 'Ship it', action: 'merge' });
    expect(await gcAuto(harness)).toBeNull();

    const archived = await harness.client.call('runs.archive', { runId: run.id });
    expect(archived.archiveReport?.kept).toEqual([]);
    expect(await legionBranches(harness)).toEqual([]);
  });

  it('leaves the run at the gate when main cannot move', async () => {
    h = await startHarness({ script: basicScript([node('T1')]) });
    const harness = h;
    const run = await toPrReady(harness);
    const before = await harness.repo.git('rev-parse', 'main');
    mkdirSync(join(harness.repo.path, 'src'));
    writeFileSync(join(harness.repo.path, 'src', 't1.txt'), 'mine\n');
    await expect(
      harness.client.call('runs.mergeLocally', { runId: run.id, title: null, body: null }),
    ).rejects.toMatchObject({
      code: 'failed_precondition',
      message: expect.stringMatching(/could not merge into main/),
    });
    expect(runOf(harness, run.id)).toMatchObject({ status: 'pr_ready', merged: null });
    expect(await harness.repo.git('rev-parse', 'main')).toBe(before);
  });
});

describe('gc.auto bookkeeping', () => {
  it('restores the user value after overlapping runs, whichever finishes first', async () => {
    h = await startHarness({ script: basicScript([node('T1')]) });
    const harness = h;
    await git(harness.repo.path, ['config', '--local', 'gc.auto', '50']);
    const approveOne = async () => {
      const run = await createRun(harness);
      await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
      const plan = harness.engine.store.latestPlan(run.id);
      await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
      return run;
    };
    const a = await approveOne();
    const b = await approveOne(); // approved while A is active: sees gc.auto=0
    expect(await gcAuto(harness)).toBe('0');
    await harness.waitFor(() => [a, b].every((r) => runOf(harness, r.id).status === 'pr_ready'), 'pr_ready', 30_000);

    await harness.client.call('runs.createPr', { runId: a.id, title: null, body: null });
    expect(await gcAuto(harness)).toBe('0'); // B still holds the repo
    // Survives an engine restart in between.
    await harness.restart();
    await harness.client.call('runs.createPr', { runId: b.id, title: null, body: null });
    expect(await gcAuto(harness)).toBe('50');
    // Releasing again (archive) changes nothing.
    await harness.client.call('runs.archive', { runId: a.id });
    expect(await gcAuto(harness)).toBe('50');
  });
});

describe('the coder role decides the coding agent', () => {
  it('ignores an engine and model the planner wrote into the plan', async () => {
    h = await startHarness({
      realKinds: true,
      settings: { roles: { coder: { engine: 'claude', models: { claude: 'opus', codex: null } } } },
      script: basicScript([
        { ...node('T1'), agent: { engine: 'codex', model: 'gpt-6.1-sol', effort: null } } as ReturnType<typeof node>,
        node('T2'),
      ]),
    });
    const harness = h;
    const run = await toPrReady(harness);
    const coders = harness.engine.store.listAttempts(run.id).filter((a) => a.role === 'coder');
    expect(coders.map((a) => [a.engine, a.model])).toEqual([
      ['claude', 'opus'],
      ['claude', 'opus'],
    ]);
    expect(harness.codex.sessions.filter((s) => s.opts.role === 'coder')).toHaveLength(0);
    expect(harness.engine.store.latestPlan(run.id)?.dag.nodes.map((n) => n.agent)).toEqual([
      { effort: null },
      { effort: null },
    ]);
  });
});

describe('same-engine review fallback', () => {
  it('reviews and finalizes with a different model of the coder engine when the other engine is off', async () => {
    h = await startHarness({
      realKinds: true,
      settings: { engines: { codex: { enabled: false } }, roles: { coder: { models: { claude: 'opus' } } } },
      script: basicScript([node('T1')]),
    });
    const harness = h;
    const run = await toPrReady(harness);
    const attempts = harness.engine.store.listAttempts(run.id);
    expect(attempts.map((a) => [a.role, a.engine, a.model])).toEqual([
      ['planner', 'claude', null],
      ['lead', 'claude', null],
      ['coder', 'claude', 'opus'],
      ['reviewer', 'claude', 'sonnet'],
      ['finalizer', 'claude', 'sonnet'],
    ]);
    expect(harness.codex.sessions).toHaveLength(0);
  });

  it('uses the configured fallback model when it differs from the coder model', async () => {
    h = await startHarness({
      realKinds: true,
      settings: { engines: { claude: { enabled: false } }, roles: { coder: { engine: 'codex' } } },
      script: basicScript([node('T1')]),
    });
    const harness = h;
    harness.engine.store.updateSettings({ engines: { codex: { fallbackReviewModel: 'gpt-review' } } });
    const run = await harness.client.call('runs.create', {
      repoPath: harness.repo.path,
      baseRef: 'main',
      title: 'Codex only',
      issueText: 'Do the thing.',
      issueUrl: null,
      plannerEngine: 'codex',
      plannerModel: null,
      skipClarify: true,
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const reviewer = harness.engine.store.listAttempts(run.id).find((a) => a.role === 'reviewer');
    expect(reviewer).toMatchObject({ engine: 'codex', model: 'gpt-review' });
  });
});

describe('engine settings without a restart', () => {
  it('rebuilds an engine whose binary path changed, leaving injected engines alone', () => {
    let settings: Settings = DEFAULT_SETTINGS;
    const codex = new FakeEngine();
    const registry = new EngineRegistry({
      dataDir: '/tmp/legion-registry',
      env: {},
      version: 'test',
      log: silentLogger,
      settings: () => settings,
      fake: false,
      overrides: { codex },
    });
    const before = registry.get('claude');
    expect(registry.reconfigure()).toEqual([]);
    settings = {
      ...DEFAULT_SETTINGS,
      engines: {
        claude: { ...DEFAULT_SETTINGS.engines.claude, path: '/nonexistent/claude' },
        codex: { ...DEFAULT_SETTINGS.engines.codex, path: '/nonexistent/codex' },
      },
    };
    expect(registry.reconfigure()).toEqual(['claude']);
    expect(registry.get('claude')).not.toBe(before);
    expect(registry.get('codex')).toBe(codex);
    expect(registry.reconfigure()).toEqual([]);
  });

  it('applies settings.set to the running engine and re-probes', async () => {
    const dir = tmp('legion-settings-');
    const engine = await startEngine({
      dataDir: dir.path,
      env: { PATH: '/usr/bin:/bin' },
      log: silentLogger,
      engines: { codex: new FakeEngine() },
      probeOnStart: false,
      recover: false,
    });
    try {
      const channel = new MessageChannel();
      engine.connect(channel.port1);
      const client = createRpcClient<RpcContract, ServerEvent>(channel.port2, { timeoutMs: 10_000 });
      const before = engine.registry.get('claude');
      await client.call('settings.set', { engines: { claude: { path: '/nonexistent/claude' } } });
      expect(engine.registry.get('claude')).not.toBe(before);
      const [claude] = await client.call('engines.list', {});
      expect(claude).toMatchObject({ kind: 'claude', installed: false });
      // Unrelated settings changes keep the instance.
      const after = engine.registry.get('claude');
      await client.call('settings.set', { budget: { warnAtPct: 50 } });
      expect(engine.registry.get('claude')).toBe(after);
      client.close({ closePort: true });
    } finally {
      await engine.close();
      dir.cleanup();
    }
  });
});

describe('final verify on gates', () => {
  /** True only in the final verify: integration worktree, no task. */
  const inFinal = '[ "$LEGION_TASK_ID" = _integration ]';

  it('runs the repo-level gates, records them as gate rows and names them in the PR body', async () => {
    const legion = {
      gates: {
        commands: {
          check: 'echo final-ok',
          advisory: { run: `! ${inFinal} || { echo 'STYLE NITS'; exit 1; }`, blocking: false },
        },
      },
    };
    h = await startHarness({ script: basicScript([node('T1')]), files: { 'legion.json': JSON.stringify(legion) } });
    const harness = h;
    const run = await toPrReady(harness);
    const rows = harness.engine.store
      .listVerifications(run.id)
      .filter((v) => v.phase === 'final')
      .sort((a, b) => (a.gate ?? '').localeCompare(b.gate ?? ''));
    // Repo-level gates only: no task verify command, no scope / secrets.
    expect(rows.map((r) => [r.gate, r.kind, r.command, r.status, r.blocking])).toEqual([
      ['advisory', 'command', legion.gates.commands.advisory.run, 'fail', false],
      ['check', 'command', 'echo final-ok', 'pass', true],
    ]);
    const item = harness.engine.store
      .listInbox({ runId: run.id, includeResolved: true })
      .find((i) => i.kind === 'pr_ready');
    const body = item?.kind === 'pr_ready' ? item.payload.body : '';
    expect(body).toContain('| Gate | Command | Result | Duration |');
    expect(body).toContain('| check | `echo final-ok` | ✅ passed |');
    expect(body).toContain('| advisory |');
    expect(body).toContain('⚠️ warning: exit 1');
    expect(body).toContain('<summary>Output of <code>advisory</code></summary>');
  }, 60_000);

  it('a failing blocking gate escalates, naming the gate', async () => {
    const legion = { gates: { commands: { smoke: `! ${inFinal} || { echo 'SMOKE FAILED'; exit 1; }` } } };
    h = await startHarness({ script: basicScript([node('T1')]), files: { 'legion.json': JSON.stringify(legion) } });
    const harness = h;
    const run = await createRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    const item = await harness.waitFor(
      () =>
        harness.engine.store
          .listInbox({ runId: run.id, includeResolved: false })
          .find((i) => i.kind === 'escalation' && i.payload.reason === 'verify_failed'),
      'final verify escalation',
      30_000,
    );
    expect(runOf(harness, run.id).status).toBe('integrating');
    expect(item.kind === 'escalation' ? item.payload.summary : '').toContain('Final verification failed on');
    expect(item.kind === 'escalation' ? item.payload.summary : '').toContain(': smoke.');
    const final = harness.engine.store.listVerifications(run.id).filter((v) => v.phase === 'final');
    expect(final.map((v) => [v.gate, v.status, v.summary])).toEqual([['smoke', 'fail', 'SMOKE FAILED']]);
  }, 60_000);

  it('falls back to the merged tasks verify commands when no repo gate resolves', async () => {
    h = await startHarness({ script: basicScript([node('T1')]) });
    const harness = h;
    const run = await toPrReady(harness);
    const final = harness.engine.store.listVerifications(run.id).filter((v) => v.phase === 'final');
    expect(final.map((v) => [v.gate, v.command, v.status])).toEqual([['test', 'test -f src/t1.txt', 'pass']]);
  }, 60_000);
});
