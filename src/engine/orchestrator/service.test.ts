/**
 * Lifecycle service behaviours beyond the happy path: plan revisions and edits, the high-risk gate,
 * escalations, budget, cancel, rate limits, takeover / hand-back, steering, and the MCP tools.
 */
import { MessageChannel } from 'node:worker_threads';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { InboxItem, Run, Task } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeStep } from '../adapters/fake';
import { HANDBACK_PROMPT } from './live-session';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const openInbox = (harness: Harness, runId: string): InboxItem[] =>
  harness.engine.store.listInbox({ runId, includeResolved: false });
const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);
const taskOf = (harness: Harness, runId: string, nodeId: string): Task =>
  harness.engine.store.listTasks(runId).find((t) => t.nodeId === nodeId) as Task;

/** Planner returns `nodes`; reviewers approve; coders write their file unless `coder` says otherwise. */
function basicScript(
  nodes: ReturnType<typeof node>[],
  coder: (ctx: Parameters<Script>[0], id: string) => FakeStep[] | null = () => null,
): Script {
  return (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput(nodes)];
    if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
    const id = taskIdIn(ctx.message);
    return (
      coder(ctx, id) ?? [
        { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
        report(`Implement ${id}`),
      ]
    );
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

async function startExecuting(harness: Harness): Promise<Run> {
  const run = await createRun(harness);
  await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  return run;
}

const liveCoder = (harness: Harness, runId: string, nodeId: string) =>
  harness.waitFor(() => {
    const task = taskOf(harness, runId, nodeId);
    const attempt = task
      ? harness.engine.store
          .listAttempts(runId)
          .find((a) => a.taskId === task.id && a.role === 'coder' && a.status === 'running' && a.sessionId)
      : undefined;
    return attempt && harness.engine.orchestrator.live.has(attempt.id) ? attempt : undefined;
  }, `live coder of ${nodeId}`);

describe('plan revisions and edits', () => {
  it('revises with feedback, versions human edits, rejects stale or invalid edits, approves via the inbox', async () => {
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role !== 'planner') return basicScript([])(ctx, 'claude');
        const revised = ctx.message.includes('Revision requested');
        return [planOutput(revised ? [node('T1'), node('T2', { dependsOn: ['T1'] })] : [node('T1')])];
      },
    });
    const harness = h;
    const run = await createRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan v1');
    const v1 = harness.engine.store.latestPlan(run.id);
    expect(v1).toMatchObject({ version: 1, source: 'agent', feedback: null });

    await harness.client.call('runs.requestPlanRevision', {
      runId: run.id,
      planId: v1?.id as string,
      feedback: 'Add a test task',
    });
    await harness.waitFor(() => harness.engine.store.latestPlan(run.id)?.version === 2, 'plan v2');
    const v2 = harness.engine.store.latestPlan(run.id);
    expect(v2).toMatchObject({ source: 'agent', feedback: 'Add a test task' });
    expect(v2?.dag.nodes.map((n) => n.id)).toEqual(['T1', 'T2']);
    const planners = harness.claude.sessions.filter((s) => s.opts.role === 'planner');
    expect(planners.map((s) => s.resumed)).toEqual([false, true]);
    expect(planners[1]?.opts.prompt).toContain('Add a test task');

    await expect(
      harness.client.call('runs.updatePlan', {
        runId: run.id,
        basePlanId: v1?.id as string,
        markdown: 'stale',
        nodes: v1?.dag.nodes ?? [],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const cyclic = (v2?.dag.nodes ?? []).map((n) => (n.id === 'T1' ? { ...n, dependsOn: ['T2'] } : n));
    await expect(
      harness.client.call('runs.updatePlan', {
        runId: run.id,
        basePlanId: v2?.id as string,
        markdown: 'x',
        nodes: cyclic,
      }),
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('cycle') });
    const edited = (v2?.dag.nodes ?? []).map((n) => (n.id === 'T2' ? { ...n, title: 'Renamed' } : n));
    const v3 = await harness.client.call('runs.updatePlan', {
      runId: run.id,
      basePlanId: v2?.id as string,
      markdown: '# Edited',
      nodes: edited,
    });
    expect(v3).toMatchObject({ version: 3, source: 'user', markdown: '# Edited' });
    await expect(
      harness.client.call('runs.approvePlan', { runId: run.id, planId: v2?.id as string }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const signoffs = openInbox(harness, run.id);
    expect(signoffs).toHaveLength(1);
    expect(signoffs[0]).toMatchObject({ kind: 'plan_signoff', payload: { planId: v3.id, version: 3 } });
    await harness.client.call('inbox.resolve', {
      itemId: signoffs[0]?.id as string,
      resolution: { kind: 'plan_signoff', approved: true, feedback: null },
    });
    expect(runOf(harness, run.id).status).toBe('executing');
    expect(harness.engine.store.listTasks(run.id).map((t) => t.nodeId)).toEqual(['T1', 'T2']);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('log', '-1', '--format=%s', integration)).toBe('T2: Renamed');
  });
});

describe('human gates and escalations', () => {
  it('holds a high-risk task for a human, takes requested changes, merges on approval', async () => {
    h = await startHarness({
      script: basicScript([node('T1', { risk: 'high' })], (ctx, id) =>
        ctx.message.includes('Note from the human')
          ? [{ kind: 'write_file', path: 'src/t1.txt', content: 'renamed\n' }, report(`Rework ${id}`)]
          : null,
      ),
    });
    const harness = h;
    const run = await startExecuting(harness);
    const gate = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'escalation'),
      'high-risk gate',
    );
    expect(taskOf(harness, run.id, 'T1').status).toBe('awaiting_human');
    expect(gate.kind === 'escalation' && gate.payload).toMatchObject({ reason: 'other', actions: ['skip', 'abort'] });

    const task = taskOf(harness, run.id, 'T1');
    const fixing = await harness.client.call('tasks.requestChanges', { taskId: task.id, feedback: 'Call it renamed' });
    expect(fixing.status).toBe('fixing');
    expect(harness.engine.store.getInboxItem(gate.id)?.resolution).toEqual({ action: 'edit', note: 'Call it renamed' });

    const second = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'escalation'),
      'second gate',
    );
    const fixer = harness.claude.sessions.filter((s) => s.opts.role === 'coder').at(-1);
    expect(fixer?.resumed).toBe(true);
    expect(fixer?.opts.prompt).toContain('Call it renamed');
    await harness.client.call('tasks.approveMerge', { taskId: task.id });
    expect(harness.engine.store.getInboxItem(second.id)?.resolution).toEqual({
      action: 'retry',
      note: 'approved for merge',
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('show', `${integration}:src/t1.txt`)).toBe('renamed');
  });

  it('fails a task after its attempts, blocks dependents, retries with a note, then skips', async () => {
    h = await startHarness({
      settings: { limits: { maxRetries: 1 } },
      script: basicScript(
        [node('T1'), node('T2', { dependsOn: ['T1'] }), node('T3', { dependsOn: ['T2'] })],
        (_ctx, id) => (id === 'T1' ? [{ kind: 'fail', message: 'compiler exploded', retryable: false }] : null),
      ),
    });
    const harness = h;
    const run = await startExecuting(harness);
    const first = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'escalation'),
      'attempts exhausted',
    );
    expect(first.kind === 'escalation' && first.payload).toMatchObject({
      reason: 'attempts_exhausted',
      actions: ['retry', 'skip', 'edit', 'abort'],
    });
    expect(taskOf(harness, run.id, 'T1')).toMatchObject({ status: 'failed', attemptCount: 2 });
    expect(taskOf(harness, run.id, 'T2').status).toBe('blocked');
    expect(taskOf(harness, run.id, 'T3').status).toBe('blocked');

    await harness.client.call('inbox.resolve', {
      itemId: first.id,
      resolution: { kind: 'escalation', action: 'retry', note: 'Try a smaller change' },
    });
    const second = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'escalation' && i.id !== first.id),
      'second escalation',
    );
    const retried = harness.claude.sessions.filter((s) => taskIdIn(s.opts.prompt) === 'T1');
    expect(retried).toHaveLength(4);
    expect(retried[2]?.opts.prompt).toContain('Try a smaller change');

    await harness.client.call('inbox.resolve', {
      itemId: second.id,
      resolution: { kind: 'escalation', action: 'skip', note: null },
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    expect(harness.engine.store.listTasks(run.id).map((t) => t.status)).toEqual(['skipped', 'merged', 'merged']);
    const pr = openInbox(harness, run.id).find((i) => i.kind === 'pr_ready');
    expect(pr?.kind === 'pr_ready' && pr.payload.body).toContain('Skipped by a human: T1');
  });
});

describe('budget, cancel and rate limits', () => {
  it('pauses at the budget and resumes when it is raised', async () => {
    h = await startHarness({
      settings: { budget: { perRunUsd: 0.05 } },
      script: basicScript([node('T1'), node('T2')], (_ctx, id) => [
        { kind: 'usage', inputTokens: 100, outputTokens: 10, costUsd: 0.04 },
        { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
        report(`Implement ${id}`),
      ]),
    });
    const harness = h;
    const run = await startExecuting(harness);
    const budget = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'budget'),
      'budget item',
    );
    expect(runOf(harness, run.id).paused).toBe(true);
    expect(budget.kind === 'budget' && budget.payload.limitUsd).toBe(0.05);
    expect(budget.kind === 'budget' && budget.payload.spentUsd).toBeGreaterThanOrEqual(0.05);
    expect(harness.host).toContainEqual(expect.objectContaining({ type: 'notify', title: 'Budget reached' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runOf(harness, run.id).status).toBe('executing');

    await harness.client.call('inbox.resolve', {
      itemId: budget.id,
      resolution: { kind: 'budget', action: 'raise', newLimitUsd: 10 },
    });
    expect(runOf(harness, run.id).paused).toBe(false);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
  });

  it('cancels a run: sessions closed, tasks and attempts cancelled, inbox dismissed', async () => {
    h = await startHarness({
      script: basicScript([node('T1'), node('T2', { dependsOn: ['T1'] })], () => [
        { kind: 'approval', tool: 'Bash', input: { command: 'rm -rf build' }, reason: 'clean' },
      ]),
    });
    const harness = h;
    const run = await startExecuting(harness);
    await harness.waitFor(() => openInbox(harness, run.id).find((i) => i.kind === 'approval'), 'approval');
    const cancelled = await harness.client.call('runs.cancel', { runId: run.id });
    expect(cancelled.status).toBe('cancelled');
    expect(harness.engine.store.listTasks(run.id).map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
    expect(
      harness.engine.store
        .listAttempts(run.id)
        .filter((a) => a.role === 'coder')
        .map((a) => a.status),
    ).toEqual(['cancelled']);
    expect(openInbox(harness, run.id)).toEqual([]);
    expect(harness.engine.orchestrator.live.size).toBe(0);
    await harness.waitFor(
      () =>
        harness.host.filter((m) => m.type === 'power').at(-1)?.type === 'power' &&
        (harness.host.filter((m) => m.type === 'power').at(-1) as { preventSleep: boolean }).preventSleep === false,
      'power off',
    );
    await expect(harness.client.call('runs.pause', { runId: run.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('waits out a rate limit without charging the attempt', async () => {
    const starts: number[] = [];
    let resetsAt = 0;
    h = await startHarness({
      script: basicScript([node('T1')], (ctx, id) => {
        starts.push(Date.now());
        if (starts.length > 1) return null;
        resetsAt = Date.now() + 400;
        return [
          { kind: 'emit', event: { type: 'rate_limit', engine: 'claude', window: '5h', usedPct: 99, resetsAt } },
          { kind: 'fail', message: `API error 429: rate limit reached for ${id} (${ctx.opts.role})`, retryable: true },
        ];
      }),
    });
    const harness = h;
    const run = await startExecuting(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBeGreaterThanOrEqual(resetsAt);
    expect(taskOf(harness, run.id, 'T1').attemptCount).toBe(1);
  });
});

describe('live sessions', () => {
  it('takes a session over in a terminal and resumes it when the terminal exits', async () => {
    h = await startHarness({
      realKinds: true,
      script: basicScript([node('T1')], (ctx) =>
        ctx.message === HANDBACK_PROMPT
          ? [{ kind: 'write_file', path: 'src/t1.txt', content: 'human + agent\n' }, report('Finish after takeover')]
          : [{ kind: 'delay', ms: 60_000 }],
      ),
    });
    const harness = h;
    const run = await startExecuting(harness);
    const attempt = await liveCoder(harness, run.id, 'T1');
    expect(attempt.engine).toBe('claude');

    const { terminalId } = await harness.client.call('sessions.takeover', {
      attemptId: attempt.id,
      cols: 100,
      rows: 30,
    });
    const pty = harness.ptys[0];
    const task = taskOf(harness, run.id, 'T1');
    expect(pty).toMatchObject({ cmd: 'claude', args: ['--resume', attempt.sessionId], cwd: task.worktreePath });
    expect(harness.engine.store.requireAttempt(attempt.id)).toMatchObject({
      status: 'interrupted',
      error: 'taken over by a human',
    });
    // Same takeover again → same terminal; the renderer re-attaches by terminalId.
    await expect(
      harness.client.call('sessions.takeover', { attemptId: attempt.id, cols: 100, rows: 30 }),
    ).resolves.toEqual({ terminalId });
    const port = new MessageChannel();
    await expect(
      harness.client.call(
        'terminals.open',
        { target: { kind: 'attempt', attemptId: attempt.id }, cols: 100, rows: 30, terminalId },
        { transfer: [port.port1] },
      ),
    ).resolves.toEqual({ terminalId, pid: pty?.pid });
    port.port2.close();
    await expect(
      harness.client.call('sessions.send', { attemptId: attempt.id, text: 'hi', priority: 'next' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });

    pty?.exit(0);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const handedBack = harness.claude.sessions.filter((s) => s.opts.role === 'coder');
    expect(handedBack.map((s) => s.resumed)).toEqual([false, true]);
    expect(harness.engine.store.requireAttempt(attempt.id)).toMatchObject({ status: 'succeeded', error: null });
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('show', `${integration}:src/t1.txt`)).toBe('human + agent');
  });

  it('steers a session: interrupt, then a follow-up message continues the task', async () => {
    h = await startHarness({
      script: basicScript([node('T1')], (ctx) =>
        ctx.turn === 0
          ? [{ kind: 'delay', ms: 60_000 }, report('never')]
          : [{ kind: 'write_file', path: 'src/t1.txt', content: `${ctx.message}\n` }, report('Steered')],
      ),
    });
    const harness = h;
    const run = await startExecuting(harness);
    const attempt = await liveCoder(harness, run.id, 'T1');
    await harness.client.call('sessions.interrupt', { attemptId: attempt.id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(taskOf(harness, run.id, 'T1').status).toBe('running');
    await harness.client.call('sessions.send', { attemptId: attempt.id, text: 'use the short name', priority: 'next' });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('show', `${integration}:src/t1.txt`)).toBe('use the short name');
  });

  it('serves the Legion MCP tools to the session that owns the token', async () => {
    h = await startHarness({
      script: basicScript([node('T1')], (ctx) =>
        ctx.turn === 0
          ? [
              { kind: 'write_file', path: 'src/t1.txt', content: 'T1\n' },
              { kind: 'delay', ms: 60_000 },
            ]
          : [],
      ),
    });
    const harness = h;
    const run = await startExecuting(harness);
    const attempt = await liveCoder(harness, run.id, 'T1');
    const mcp = harness.claude.sessions.find((s) => s.opts.role === 'coder')?.opts.mcp;
    if (!mcp) throw new Error('the coder got no MCP connection');
    expect(mcp.url).toBe(harness.engine.mcp.url);
    expect(harness.claude.sessions[0]?.opts.env.MCP_TOOL_TIMEOUT).toBe(String(24 * 60 * 60 * 1000));
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
      }),
    );
    const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text;

    await client.callTool({ name: 'report_progress', arguments: { summary: 'halfway there' } });
    expect(taskOf(harness, run.id, 'T1').progress).toBe('halfway there');

    const asking = client.callTool({
      name: 'request_human_input',
      arguments: { question: 'Which color?', options: ['red', 'blue'] },
    });
    const question = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'question'),
      'agent question',
    );
    expect(question).toMatchObject({ attemptId: attempt.id, payload: { source: 'agent' } });
    await harness.client.call('inbox.resolve', {
      itemId: question.id,
      resolution: { kind: 'question', answers: [{ questionId: 'q1', answer: 'red' }] },
    });
    expect(JSON.parse(text(await asking) ?? '{}')).toEqual({ answer: 'red' });

    const approving = client.callTool({
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'ls' } },
    });
    const approval = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'approval'),
      'approval via MCP',
    );
    await harness.client.call('inbox.resolve', {
      itemId: approval.id,
      resolution: { kind: 'approval', decision: { behavior: 'deny', message: 'not now', interrupt: false } },
    });
    expect(JSON.parse(text(await approving) ?? '{}')).toEqual({ behavior: 'deny', message: 'not now' });

    await client.callTool({
      name: 'mark_task_done',
      arguments: { summary: 'Wrote T1', commit_message: 'Add t1 from mark_task_done' },
    });
    await client.close();
    // Steer into a turn that ends without structured output: the mark_task_done report is used.
    await harness.client.call('sessions.send', { attemptId: attempt.id, text: 'wrap up', priority: 'now' });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const task = taskOf(harness, run.id, 'T1');
    expect(await harness.repo.git('log', '-1', '--format=%s', task.branch as string)).toBe(
      'Add t1 from mark_task_done',
    );
  });
});
