/**
 * The assistant through the lifecycle service: a conversation run, the human's messages, research, starting
 * the work, the lead reporting to it, status news, and the off switch.
 */
import type { Attempt } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeTurnContext } from '../adapters/fake';
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

const script: Script = (ctx) => {
  if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
  if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
  const id = taskIdIn(ctx.message);
  return [
    { kind: 'delay', ms: 1_200 },
    { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
    report(`Implement ${id}`),
  ];
};

function recorder() {
  const turns: FakeTurnContext[] = [];
  const messages = () => turns.map((t) => t.message);
  const assistant: Script = (ctx) => {
    turns.push(ctx);
    return [{ kind: 'text', text: 'ok' }];
  };
  return { turns, messages, assistant };
}

async function chat(harness: Harness, prompt = 'How is auth done here?') {
  const run = await harness.client.call('runs.chat', {
    repoPath: harness.repo.path,
    baseRef: null,
    prompt,
    engine: 'claude',
    model: null,
    attachmentIds: null,
  });
  const assistant = await harness.waitFor(() => {
    const id = runMeta(harness.engine.store, run.id).assistantAttemptId;
    return id ? harness.engine.store.getAttempt(id) : null;
  }, 'assistant attempt');
  return { run, assistant };
}

describe('the assistant', () => {
  it("opens a conversation run, takes the human's messages, spawns research and relays the report", async () => {
    const rec = recorder();
    h = await startHarness({
      script,
      assistant: rec.assistant,
      research: () => [
        {
          kind: 'output',
          value: { summary: 'Cookie sessions.', findings: [], openQuestions: [], confidence: 'high' },
        },
      ],
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, assistant } = await chat(harness);
    expect(run.status).toBe('chatting');
    expect(run.title).toBe('How is auth done here?');
    expect(assistant).toMatchObject({ role: 'assistant', parentAttemptId: null, status: 'running' });
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    expect(rec.turns[0]?.opts.permission.mode).toBe('coordinate');
    expect(rec.turns[0]?.opts.systemPrompt).toContain('You are the assistant in Legion');
    expect(rec.turns[0]?.opts.prompt).toContain('How is auth done here?');

    // The human talks to the assistant through the live session.
    await harness.client.call('sessions.send', {
      attemptId: assistant.id,
      text: 'And where are the tests?',
      priority: 'next',
      attachmentIds: null,
    });
    await harness.waitFor(() => rec.turns.length === 2, 'second turn');
    expect(rec.turns[1]?.message).toBe('And where are the tests?');

    // Research spawned by the assistant comes back as a wake.
    const spawned = await orchestrator.mcpHost.spawnResearch(binding(store.requireAttempt(assistant.id)), {
      title: 'Auth',
      brief: 'How is auth done?',
      mode: 'single',
    });
    expect(store.requireAttempt(spawned.attemptId).parentAttemptId).toBe(assistant.id);
    await harness.waitFor(() => rec.messages().some((m) => m.includes('Cookie sessions.')), 'report relayed');
    expect(rec.messages().find((m) => m.includes('Cookie sessions.'))).toContain('Update from Legion');
    expect(store.requireRun(run.id).status).toBe('chatting');
    expect(await harness.client.call('messages.list', { runId: run.id })).toHaveLength(1);
  }, 60_000);

  it("starts the work, parents the lead, relays the lead's question and reports status changes", async () => {
    const rec = recorder();
    const leadMessages: string[] = [];
    h = await startHarness({
      script,
      assistant: rec.assistant,
      lead: (ctx) => {
        leadMessages.push(ctx.message);
        return [{ kind: 'text', text: 'ok' }];
      },
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, assistant } = await chat(harness, 'Please add a greeting module.');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const host = orchestrator.mcpHost;
    const asAssistant = binding(store.requireAttempt(assistant.id));

    expect(
      host.startImplementation(asAssistant, { title: 'Greeting module', brief: 'Add src/greet.ts.', clarify: false }),
    ).toEqual({
      runId: run.id,
      status: 'planning',
    });
    expect(store.requireRun(run.id)).toMatchObject({ title: 'Greeting module', issueText: 'Add src/greet.ts.' });
    expect(() => host.startImplementation(asAssistant, { title: 'x', brief: 'y', clarify: false })).toThrow(
      /already started/,
    );

    await harness.waitFor(() => store.requireRun(run.id).status === 'awaiting_approval', 'plan');
    await harness.waitFor(() => rec.messages().some((m) => m.includes('planning → awaiting_approval')), 'status news');
    const news = rec.messages().find((m) => m.includes('planning → awaiting_approval')) as string;
    expect(news).toContain("plan v1 waits for the human's sign-off (inbox)");
    const status = await host.runStatus(asAssistant);
    expect(status).toMatchObject({ status: 'awaiting_approval', plan: { version: 1, approved: false } });
    expect(status.waitingForHuman[0]).toContain('sign-off');

    await harness.client.call('runs.approvePlan', { runId: run.id, planId: store.latestPlan(run.id)?.id as string });
    const lead = await harness.waitFor(() => {
      const id = runMeta(store, run.id).leadAttemptId;
      return id ? store.getAttempt(id) : null;
    }, 'lead');
    expect(lead.parentAttemptId).toBe(assistant.id);
    expect(harness.claude.sessions.find((s) => s.opts.role === 'lead')?.opts.systemPrompt).toContain(
      'your parent, the assistant',
    );

    // The lead asks the human something through the assistant; the assistant answers.
    const question = await host.sendMessage(binding(store.requireAttempt(lead.id)), {
      to: 'lead',
      kind: 'question',
      body: 'Ship behind a flag?',
      replyTo: null,
    });
    expect(question.toAttemptId).toBe(assistant.id);
    await harness.waitFor(() => rec.messages().some((m) => m.includes('Ship behind a flag?')), 'question relayed');
    await host.sendMessage(asAssistant, { to: lead.id, kind: 'answer', body: 'Yes, flag it.', replyTo: question.id });
    await harness.waitFor(() => leadMessages.some((m) => m.includes('Yes, flag it.')), 'answer delivered');

    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 40_000);
    await harness.waitFor(() => rec.messages().some((m) => m.includes('→ pr_ready')), 'pr news');
    expect(host.runStatus(asAssistant)).toMatchObject({
      status: 'pr_ready',
      tasks: [{ nodeId: 'T1', status: 'merged' }],
    });
    expect(store.listAttempts(run.id).filter((a) => a.role === 'assistant')).toHaveLength(1);
    expect(store.requireAttempt(assistant.id).status).toBe('running');

    await harness.client.call('runs.cancel', { runId: run.id });
    await harness.waitFor(() => store.requireAttempt(assistant.id).status !== 'running', 'assistant closed');
    await harness.waitFor(() => !orchestrator.assistantLoops.has(run.id), 'loop gone');
  }, 90_000);

  it('fails a conversation whose assistant keeps dying, and refuses to chat when disabled', async () => {
    h = await startHarness({ script, assistant: () => [{ kind: 'fail', message: 'boom', exitCode: 1 }] });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    orchestrator.leadBackoffMs = 10;
    const { run } = await chat(harness);
    await harness.waitFor(() => store.requireRun(run.id).status === 'failed', 'failed');
    expect(store.requireRun(run.id).error).toContain('the assistant failed: boom');
    expect(runMeta(store, run.id).assistantDisabled).toBe(true);
    expect(store.listAttempts(run.id).filter((a) => a.role === 'assistant')).toHaveLength(3);

    store.updateSettings({ assistant: { enabled: false } });
    await expect(
      harness.client.call('runs.chat', {
        repoPath: harness.repo.path,
        baseRef: null,
        prompt: 'hi',
        engine: 'claude',
        model: null,
        attachmentIds: null,
      }),
    ).rejects.toThrow(/disabled/);
  }, 60_000);
});
