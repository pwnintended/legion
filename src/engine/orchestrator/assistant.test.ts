/**
 * The assistant through the lifecycle service: a conversation run, the human's messages, research, starting
 * the work, the lead reporting to it, status news, and the off switch.
 */
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attempt } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeTurnContext } from '../adapters/fake';
import type { McpBinding } from '../mcp';
import { deferred } from '../util/async-queue';
import { runMeta } from './meta';
import {
  approve,
  type Harness,
  node,
  plannerKind,
  planOutput,
  report,
  type Script,
  startHarness,
  taskIdIn,
} from './test-harness';

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

const humanMessages = (harness: Harness, attemptId: string) =>
  harness.events
    .filter((e) => e.type === 'agent.event' && e.attemptId === attemptId && e.event.type === 'user_message')
    .map((e) => (e as { event: Extract<AgentEvent, { type: 'user_message' }> }).event);

describe('the conversation record', () => {
  it("records the human's messages in the assistant's transcript, never Legion's wakes", async () => {
    const rec = recorder();
    h = await startHarness({ script, assistant: rec.assistant });
    const harness = h;
    const { run, assistant } = await chat(harness, 'Tidy the logging.');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    await harness.client.call('sessions.send', {
      attemptId: assistant.id,
      text: 'Only the server side.',
      priority: 'next',
      attachmentIds: null,
    });
    await harness.waitFor(() => rec.turns.length === 2, 'second turn');
    // A wake (status news) is not the human's.
    harness.engine.orchestrator.mcpHost.startImplementation(binding(assistant), {
      title: 'Logging',
      brief: 'Tidy server logging.',
      clarify: false,
    });
    await harness.waitFor(() => rec.messages().some((m) => m.startsWith('Update from Legion')), 'wake');
    await harness.waitFor(() => humanMessages(harness, assistant.id).length === 2, 'recorded');
    expect(humanMessages(harness, assistant.id)).toEqual([
      { type: 'user_message', text: 'Tidy the logging.', attachments: [], priority: null },
      { type: 'user_message', text: 'Only the server side.', attachments: [], priority: 'next' },
    ]);
    const transcript = await harness.client.call('attempts.transcript', {
      attemptId: assistant.id,
      sinceSeq: 0,
      limit: 500,
    });
    expect(transcript.entries.filter((e) => e.event.type === 'user_message')).toHaveLength(2);
    expect(run.issueText).toBe('Tidy the logging.');
  }, 60_000);
});

describe('present', () => {
  it('copies files and documents into the store, confines paths, and tells the assistant', async () => {
    const rec = recorder();
    h = await startHarness({ script, assistant: rec.assistant });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, assistant } = await chat(harness, 'Show me the settings page.');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const host = orchestrator.mcpHost;
    // A run-level researcher under the assistant stands in for any agent with files.
    const spawned = await host.spawnResearch(binding(store.requireAttempt(assistant.id)), {
      title: 'Look',
      brief: 'Look around.',
      mode: 'single',
    });
    const agent = binding(store.requireAttempt(spawned.attemptId));

    const dir = await mkdtemp(join(tmpdir(), 'legion-present-'));
    const shot = join(dir, 'shot.png');
    await writeFile(shot, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077', 'hex'));
    await writeFile(join(harness.repo.path, 'NOTES.md'), '# Notes\n');
    const shown = await host.present(agent, {
      title: 'Settings page',
      caption: 'The new list.',
      files: [shot, 'NOTES.md'],
      markdown: '# Summary\n\nAll good.',
    });
    expect(shown.files).toBe(3);
    const [presentation] = store.listPresentations(run.id);
    expect(presentation).toMatchObject({
      title: 'Settings page',
      caption: 'The new list.',
      attemptId: agent.attemptId,
    });
    expect(presentation?.attachments.map((a) => [a.name, a.kind])).toEqual([
      ['shot.png', 'image'],
      ['NOTES.md', 'text'],
      ['settings-page.md', 'text'],
    ]);
    await harness.waitFor(() => harness.events.some((e) => e.type === 'presentation.created'), 'event');
    expect((await harness.client.call('runs.get', { runId: run.id })).presentations).toHaveLength(1);
    await harness.waitFor(() => rec.messages().some((m) => m.includes('showed the human "Settings page"')), 'told');

    // Outside the working directory and the temp dir (the harness itself lives in the temp dir): refused, through
    // symlinks too.
    const outside = '/etc/hosts';
    await expect(host.present(agent, { title: 'x', caption: null, files: [outside], markdown: null })).rejects.toThrow(
      /outside your working directory/,
    );
    await symlink(outside, join(harness.repo.path, 'link.txt'));
    await expect(
      host.present(agent, { title: 'x', caption: null, files: ['link.txt'], markdown: null }),
    ).rejects.toThrow(/outside your working directory/);
    await expect(
      host.present(agent, { title: 'x', caption: null, files: ['nope.png'], markdown: null }),
    ).rejects.toThrow(/does not exist/);
    expect(store.listPresentations(run.id)).toHaveLength(1);
  }, 60_000);
});

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
    expect(news).toContain("plan v1 waits for the human's sign-off (a card in your conversation)");
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

  it("steers the drafting planner and hears the human's inbox answers", async () => {
    const rec = recorder();
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role !== 'planner') return script(ctx, 'claude');
        if (plannerKind(ctx) === 'clarify') {
          return [{ kind: 'output', value: { questions: [{ id: 'q1', question: 'Port or forest?', options: [] }] } }];
        }
        return [{ kind: 'delay', ms: 600 }, planOutput([node('T1')])];
      },
      assistant: rec.assistant,
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, assistant } = await chat(harness, 'Build the slice.');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const host = orchestrator.mcpHost;
    const asAssistant = binding(store.requireAttempt(assistant.id));
    expect(() => host.sendMessage(asAssistant, { to: 'planner', kind: 'brief', body: 'x', replyTo: null })).toThrow(
      /no planner/,
    );
    host.startImplementation(asAssistant, { title: 'Slice', brief: 'Build the slice.', clarify: true });

    // The clarify answers reach the assistant (it cannot see the inbox).
    await harness.waitFor(
      () => store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'question'),
      'question',
    );
    await harness.client.call('runs.answerClarify', {
      runId: run.id,
      answers: [{ questionId: 'q1', answer: 'Forest' }],
      attachmentIds: null,
    });
    await harness.waitFor(
      () => rec.messages().some((m) => m.includes("the human answered the planner's questions")),
      'answers relayed',
    );
    expect(rec.messages().find((m) => m.includes('answered the planner'))).toContain('Port or forest? → Forest');

    // While the planner drafts, it is the assistant's child and a brief reaches its running session.
    const planner = await harness.waitFor(() => {
      const live = store.listAttempts(run.id).filter((a) => a.role === 'planner' && a.status === 'running');
      return live.at(-1);
    }, 'drafting planner');
    expect(planner.parentAttemptId).toBe(assistant.id);
    const brief = await host.sendMessage(asAssistant, {
      to: 'planner',
      kind: 'brief',
      body: 'Boreal forest, no port town.',
      replyTo: null,
    });
    expect(brief.toAttemptId).toBe(planner.id);
    expect(store.getMessage(brief.id)?.deliveredAt).not.toBeNull();
    const plannerSession = harness.claude.sessions.filter((s) => s.opts.role === 'planner').at(-1);
    expect(plannerSession?.session.sent.map((m) => m.text).join('\n')).toContain('Boreal forest, no port town.');
    expect(plannerSession?.opts.mcp).not.toBeNull();

    // With the plan waiting for sign-off, a brief waits for the next planner step; the human's feedback is relayed.
    await harness.waitFor(() => store.requireRun(run.id).status === 'awaiting_approval', 'plan');
    const later = await host.sendMessage(asAssistant, {
      to: 'planner',
      kind: 'brief',
      body: 'Add fog.',
      replyTo: null,
    });
    expect(store.getMessage(later.id)?.deliveredAt).toBeNull();
    await harness.client.call('runs.requestPlanRevision', {
      runId: run.id,
      planId: store.latestPlan(run.id)?.id as string,
      feedback: 'More mist please.',
    });
    await harness.waitFor(() => store.getMessage(later.id)?.deliveredAt, 'queued brief delivered');
    const revising = harness.claude.sessions.filter((s) => s.opts.role === 'planner').at(-1);
    expect(revising?.opts.prompt).toContain('Add fog.');
    await harness.waitFor(
      () => rec.messages().some((m) => m.includes('the human asked for changes to plan v1: More mist please.')),
      'feedback relayed',
    );
  }, 60_000);

  it('passes a brief sent while the planner’s engine starts into its first turn', async () => {
    const rec = recorder();
    h = await startHarness({
      script: (ctx) =>
        ctx.opts.role === 'planner' ? [{ kind: 'delay', ms: 400 }, planOutput([node('T1')])] : script(ctx, 'claude'),
      assistant: rec.assistant,
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, assistant } = await chat(harness, 'Build the slice.');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const asAssistant = binding(store.requireAttempt(assistant.id));

    // Hold the planner's engine start: its attempt runs, its queue is drained, but it is not live yet.
    const release = deferred<void>();
    const starting = deferred<void>();
    const start = harness.claude.start.bind(harness.claude);
    vi.spyOn(harness.claude, 'start').mockImplementation(async (opts) => {
      if (opts.role === 'planner') {
        starting.resolve();
        await release.promise;
      }
      return start(opts);
    });
    orchestrator.mcpHost.startImplementation(asAssistant, {
      title: 'Slice',
      brief: 'Build the slice.',
      clarify: false,
    });
    await starting.promise;
    const brief = await orchestrator.mcpHost.sendMessage(asAssistant, {
      to: 'planner',
      kind: 'brief',
      body: 'Boreal forest, no port town.',
      replyTo: null,
    });
    expect(store.getMessage(brief.id)?.deliveredAt).toBeNull();

    release.resolve();
    await harness.waitFor(() => store.getMessage(brief.id)?.deliveredAt, 'brief delivered');
    const planner = harness.claude.sessions.filter((s) => s.opts.role === 'planner').at(-1);
    expect(planner?.session.sent.map((m) => m.text).join('\n')).toContain('Boreal forest, no port town.');
    await harness.waitFor(() => store.requireRun(run.id).status === 'awaiting_approval', 'plan');
  }, 60_000);

  it('reads the plan and revises it until it is signed off', async () => {
    const rec = recorder();
    const plannerPrompts: string[] = [];
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role !== 'planner') return script(ctx, 'claude');
        plannerPrompts.push(ctx.message);
        const settings = ctx.message.includes('settings panel');
        return [{ kind: 'delay', ms: 600 }, planOutput(settings ? [node('T1'), node('T2')] : [node('T1')])];
      },
      assistant: rec.assistant,
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, assistant } = await chat(harness, 'Add gates.');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const host = orchestrator.mcpHost;
    const asAssistant = binding(store.requireAttempt(assistant.id));
    expect(await host.readPlan(asAssistant, null)).toMatch(/no plan: the work has not been started/);
    await expect(host.revisePlan(asAssistant, 'x')).rejects.toThrow(/start_implementation/);

    host.startImplementation(asAssistant, { title: 'Gates', brief: 'Add gates.', clarify: false });
    await harness.waitFor(() => store.requireRun(run.id).status === 'awaiting_approval', 'plan v1');
    const draft = await host.readPlan(asAssistant, null);
    expect(draft).toContain("# Plan v1: a draft waiting for the human's sign-off");
    expect(draft).toContain('### T1: Task T1');
    expect(await host.readPlan(asAssistant, 'T1: Task T1')).toContain('**Goal**');

    // The plan waits for sign-off: the assistant turns it down with the human's changes.
    const v1 = store.latestPlan(run.id);
    expect(await host.revisePlan(asAssistant, 'Add a settings panel.')).toEqual({
      outcome: 'revising',
      planVersion: 1,
    });
    const signoff = store
      .listInbox({ runId: run.id, includeResolved: true })
      .find((i) => i.kind === 'plan_signoff' && i.payload.planId === v1?.id);
    expect(signoff?.resolution).toEqual({
      approved: false,
      feedback: 'Add a settings panel.',
      by: 'assistant',
    });
    expect(store.requireRun(run.id).status).toBe('planning');
    expect(await host.readPlan(asAssistant, null)).toContain('# Plan v1: the planner is drafting the next version');

    // While the next version is drafted, more changes reach the planner's running turn.
    await harness.waitFor(
      () => store.listAttempts(run.id).some((a) => a.role === 'planner' && a.status === 'running'),
      'revising planner',
    );
    expect(await host.revisePlan(asAssistant, 'Name it Gates.')).toEqual({ outcome: 'steered', planVersion: 1 });
    const revising = harness.claude.sessions.filter((s) => s.opts.role === 'planner').at(-1);
    expect(revising?.session.sent.map((m) => m.text).join('\n')).toContain('Name it Gates.');

    await harness.waitFor(() => store.latestPlan(run.id)?.version === 2, 'plan v2');
    expect(plannerPrompts.some((p) => p.includes('Add a settings panel.'))).toBe(true);
    expect(store.latestPlan(run.id)?.dag.nodes.map((n) => n.id)).toEqual(['T1', 'T2']);
    await harness.waitFor(() => rec.messages().some((m) => m.includes('plan v2 waits')), 'v2 news');
    expect(rec.messages().join('\n')).not.toContain('the human asked for changes');

    await harness.client.call('runs.approvePlan', { runId: run.id, planId: store.latestPlan(run.id)?.id as string });
    expect(await host.readPlan(asAssistant, null)).toContain('# Approved plan (v2)');
    await expect(host.revisePlan(asAssistant, 'x')).rejects.toThrow(/brief the lead/);
  }, 60_000);

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
