/**
 * The implementation lead through the lifecycle service: opened at approval, coders parented to it, wakes on
 * questions and board changes, plan amendments (applied or signed off), crash resumption, and the off switch.
 */
import type { Attempt, Run } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeStep } from '../adapters/fake';
import type { McpBinding } from '../mcp';
import { runMeta } from './meta';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const binding = (attempt: Attempt): McpBinding => ({
  runId: attempt.runId,
  taskId: attempt.taskId,
  attemptId: attempt.id,
  role: attempt.role,
  parentAttemptId: attempt.parentAttemptId ?? null,
});

/** Planner plans `nodes`; reviewers approve; coders pause `coderDelayMs`, then write their file and report. */
function script(nodes: ReturnType<typeof node>[], coderDelayMs = 0): Script {
  return (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput(nodes)];
    if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
    const id = taskIdIn(ctx.message);
    const steps: FakeStep[] = coderDelayMs > 0 ? [{ kind: 'delay', ms: coderDelayMs }] : [];
    return [
      ...steps,
      { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
      report(`Implement ${id}`),
    ];
  };
}

async function approvedRun(harness: Harness): Promise<Run> {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Lead run',
    issueText: 'Do the thing.',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
  await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  return run;
}

const leadAttempt = (harness: Harness, runId: string) =>
  harness.waitFor(() => {
    const id = runMeta(harness.engine.store, runId).leadAttemptId;
    return id ? harness.engine.store.getAttempt(id) : null;
  }, 'lead attempt');

const liveCoder = (harness: Harness, runId: string, nodeId: string) =>
  harness.waitFor(() => {
    const task = harness.engine.store.listTasks(runId).find((t) => t.nodeId === nodeId);
    return task
      ? harness.engine.store
          .listAttempts(runId)
          .find((a) => a.taskId === task.id && a.role === 'coder' && a.status === 'running')
      : null;
  }, `coder of ${nodeId}`);

describe('implementation lead', () => {
  it('opens at approval, parents the coders, relays a question and its answer, and sees the board change', async () => {
    const leadMessages: string[] = [];
    h = await startHarness({
      script: script([node('T1')], 600),
      lead: (ctx) => {
        leadMessages.push(ctx.message);
        return [{ kind: 'text', text: 'ok' }];
      },
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = await approvedRun(harness);
    const lead = await leadAttempt(harness, run.id);
    expect(lead.role).toBe('lead');
    expect(lead.parentAttemptId).toBeNull();
    expect(leadMessages[0]).toContain('## Approved plan');
    expect(leadMessages[0]).toContain('**T1**');
    const leadSession = harness.claude.sessions.find((s) => s.opts.role === 'lead');
    expect(leadSession?.opts.permission.mode).toBe('coordinate');
    expect(leadSession?.opts.systemPrompt).toContain('implementation lead');

    const coder = await liveCoder(harness, run.id, 'T1');
    expect(coder.parentAttemptId).toBe(lead.id);
    const coderSession = harness.claude.sessions.find((s) => s.opts.role === 'coder');
    expect(coderSession?.opts.systemPrompt).toContain('ask the lead');

    // The coder asks (as its ask_lead tool would); the lead is woken with the question.
    const host = orchestrator.mcpHost;
    const question = await host.sendMessage(binding(coder), {
      to: 'lead',
      kind: 'question',
      body: 'Tabs or spaces?',
      replyTo: null,
    });
    const answerWait = host.awaitMessage(binding(coder), { replyTo: question.id, timeoutMs: 5_000 });
    await harness.waitFor(() => leadMessages.some((m) => m.includes('Tabs or spaces?')), 'lead woken');
    const wake = leadMessages.find((m) => m.includes('Tabs or spaces?')) as string;
    expect(wake).toContain(`### Question from coder of T1 (${coder.id}) · id ${question.id}`);
    expect(wake).toContain('## Board');
    expect(store.getMessage(question.id)?.deliveredAt).not.toBeNull();

    // The lead answers (as its send_message tool would).
    await host.sendMessage(binding(store.requireAttempt(lead.id)), {
      to: coder.id,
      kind: 'answer',
      body: 'Spaces.',
      replyTo: question.id,
    });
    expect(await answerWait).toMatchObject({ body: 'Spaces.', replyTo: question.id });

    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
    // Board changes reach the lead while the run executes (the final merge ends the lead with the run).
    expect(leadMessages.some((m) => /## Board changes\n\n- T1 \w+ → \w+/.test(m))).toBe(true);
    expect(store.listAttempts(run.id).filter((a) => a.role === 'lead')).toHaveLength(1);
    await harness.waitFor(() => store.requireAttempt(lead.id).status === 'succeeded', 'lead closed');
    expect(await harness.client.call('messages.list', { runId: run.id })).toHaveLength(2);
  }, 60_000);

  it('applies in-scope amendments at once and parks the others for the human', async () => {
    h = await startHarness({ script: script([node('T1', { writes: ['src/t1.txt'] })], 1_500) });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = await approvedRun(harness);
    const lead = await leadAttempt(harness, run.id);
    await liveCoder(harness, run.id, 'T1');
    const host = orchestrator.mcpHost;
    const asLead = binding(store.requireAttempt(lead.id));

    const t2 = node('T2', { writes: ['src/t2.txt'] });
    expect(await host.addTask(asLead, t2)).toEqual({ outcome: 'applied', planVersion: 2, reason: null });
    expect(store.listTasks(run.id).map((t) => t.nodeId)).toEqual(['T1', 'T2']);
    expect(orchestrator.approvedPlan(run.id)?.version).toBe(2);

    // Declares a write outside the plan's area; the fake coder still writes src/t3.txt (the scope check only warns).
    const t3 = node('T3', { writes: ['docs/t3.md'] });
    const pending = await host.addTask(asLead, t3);
    expect(pending).toMatchObject({ outcome: 'pending', planVersion: 3 });
    expect(pending.reason).toContain('outside the approved plan');
    expect(store.listTasks(run.id).map((t) => t.nodeId)).toEqual(['T1', 'T2']);
    const status = await host.planStatus(asLead);
    expect(status.pendingAmendment).toEqual({ version: 3, reason: pending.reason });
    await expect(host.addTask(asLead, node('T4'))).rejects.toThrow(/still waiting/);
    const item = store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'plan_signoff');
    expect(item).toBeTruthy();

    await harness.client.call('inbox.resolve', {
      itemId: item?.id as string,
      resolution: { kind: 'plan_signoff', approved: true, feedback: null },
    });
    expect(store.listTasks(run.id).map((t) => t.nodeId)).toEqual(['T1', 'T2', 'T3']);
    expect(orchestrator.approvedPlan(run.id)?.version).toBe(3);
    expect(runMeta(store, run.id).amendment?.status).toBe('approved');

    // A blocked task can be amended and cancelled; a running one cannot.
    const t4 = node('T4', { dependsOn: ['T1'], writes: ['src/t4.txt'] });
    expect((await host.addTask(asLead, t4)).outcome).toBe('applied');
    expect((await host.amendTask(asLead, 'T4', { title: 'Renamed' })).outcome).toBe('applied');
    expect(orchestrator.approvedNodes(run.id).find((n) => n.id === 'T4')?.title).toBe('Renamed');
    await expect(host.amendTask(asLead, 'T1', { title: 'x' })).rejects.toThrow(/only blocked or queued/);
    expect((await host.cancelTask(asLead, 'T4', 'not needed')).outcome).toBe('applied');
    expect(store.listTasks(run.id).find((t) => t.nodeId === 'T4')?.status).toBe('skipped');

    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 40_000);
    const merged = store
      .listTasks(run.id)
      .filter((t) => t.status === 'merged')
      .map((t) => t.nodeId);
    expect(merged.sort()).toEqual(['T1', 'T2', 'T3']);
    const coders = store.listAttempts(run.id).filter((a) => a.role === 'coder');
    expect(coders.every((a) => a.parentAttemptId === lead.id)).toBe(true);
  }, 60_000);

  it('tells the lead when the human rejects a change', async () => {
    const leadMessages: string[] = [];
    h = await startHarness({
      script: script([node('T1', { writes: ['src/t1.txt'] })], 1_500),
      lead: (ctx) => {
        leadMessages.push(ctx.message);
        return [{ kind: 'text', text: 'ok' }];
      },
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = await approvedRun(harness);
    const lead = await leadAttempt(harness, run.id);
    await liveCoder(harness, run.id, 'T1');
    const pending = await orchestrator.mcpHost.addTask(
      binding(store.requireAttempt(lead.id)),
      node('T2', { risk: 'high', writes: ['src/t2.txt'] }),
    );
    expect(pending.outcome).toBe('pending');
    const plan = store.latestPlan(run.id);
    await harness.client.call('runs.requestPlanRevision', {
      runId: run.id,
      planId: plan?.id as string,
      feedback: 'Too risky.',
    });
    await harness.waitFor(() => leadMessages.some((m) => m.includes('rejected by the human: Too risky.')), 'lead told');
    expect(store.listTasks(run.id).map((t) => t.nodeId)).toEqual(['T1']);
    expect(store.requireRun(run.id).status).toBe('executing');
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
  }, 60_000);

  it('resumes a crashed lead as a new attempt and re-parents its coders', async () => {
    let leadTurns = 0;
    h = await startHarness({
      script: script([node('T1')], 800),
      lead: () =>
        leadTurns++ === 0 ? [{ kind: 'fail', message: 'boom', exitCode: 1 }] : [{ kind: 'text', text: 'back' }],
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    orchestrator.leadBackoffMs = 10;
    const run = await approvedRun(harness);
    await harness.waitFor(
      () => store.listAttempts(run.id).filter((a) => a.role === 'lead').length === 2,
      'second lead',
    );
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const leads = store.listAttempts(run.id).filter((a) => a.role === 'lead');
    expect(leads.map((a) => a.status)).toEqual(['failed', 'succeeded']);
    expect(leads[1]?.sessionId).toBe(leads[0]?.sessionId);
    const coders = store.listAttempts(run.id).filter((a) => a.role === 'coder');
    expect(coders.length).toBeGreaterThan(0);
    expect(coders.every((a) => a.parentAttemptId === leads[1]?.id)).toBe(true);
  }, 60_000);

  it('gives the lead up after repeated failures and runs on without one', async () => {
    h = await startHarness({
      script: script([node('T1')], 1_500),
      lead: () => [{ kind: 'fail', message: 'always', exitCode: 1 }],
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    orchestrator.leadBackoffMs = 10;
    const run = await approvedRun(harness);
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
    expect(runMeta(store, run.id).leadDisabled).toBe(true);
    expect(store.listAttempts(run.id).filter((a) => a.role === 'lead')).toHaveLength(3);

    expect(orchestrator.leadLoops.has(run.id)).toBe(false);
  }, 60_000);

  it('is off when settings say so: no lead attempt, coders without a parent', async () => {
    h = await startHarness({ script: script([node('T1')]), settings: { lead: { enabled: false } } });
    const harness = h;
    const { store } = harness.engine;
    const run = await approvedRun(harness);
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const attempts = store.listAttempts(run.id);
    expect(attempts.some((a) => a.role === 'lead')).toBe(false);
    expect(attempts.filter((a) => a.role === 'coder').every((a) => a.parentAttemptId === null)).toBe(true);
    expect(harness.claude.sessions.find((s) => s.opts.role === 'coder')?.opts.systemPrompt).not.toContain(
      'ask the lead',
    );
  }, 60_000);
});
