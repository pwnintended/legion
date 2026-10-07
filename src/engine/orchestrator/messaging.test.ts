/**
 * Agent-to-agent messaging through the lifecycle service: hierarchy on open, the MCP host's send / wait /
 * list, and delivery of queued messages when an engine session is resumed.
 */
import type { Attempt, Run } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeStep } from '../adapters/fake';
import type { McpBinding } from '../mcp';
import type { AgentRun } from './live-session';
import { type Harness, startHarness } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Every fake session: one short turn, then idle until `send` or `close`. */
const idle = (): FakeStep[] => [{ kind: 'text', text: 'ready' }];

function newRun(harness: Harness): Run {
  return harness.engine.store.createRun({
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Messaging',
    issueText: 'Talk to each other.',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
  });
}

async function open(
  harness: Harness,
  run: Run,
  role: 'planner' | 'coder',
  extra: { parentAttemptId?: string | null; resumeSessionId?: string | null; prompt?: string } = {},
): Promise<AgentRun> {
  const session = await harness.engine.orchestrator.openSession({
    run,
    taskId: null,
    role,
    engine: 'claude',
    model: null,
    effort: null,
    prompt: { prompt: extra.prompt ?? `go ${role}`, systemPrompt: 'test' },
    outputSchema: null,
    cwd: harness.repo.path,
    ...(extra.parentAttemptId !== undefined ? { parentAttemptId: extra.parentAttemptId } : {}),
    ...(extra.resumeSessionId ? { resumeSessionId: extra.resumeSessionId } : {}),
  });
  await session.nextTurn();
  return session;
}

const binding = (attempt: Attempt): McpBinding => ({
  runId: attempt.runId,
  taskId: attempt.taskId,
  attemptId: attempt.id,
  role: attempt.role,
  parentAttemptId: attempt.parentAttemptId ?? null,
});

describe('agent messaging', () => {
  it('a child asks its lead, the lead waits, answers, and the child unblocks', async () => {
    h = await startHarness({ script: idle });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = newRun(harness);
    const lead = await open(harness, run, 'planner');
    const child = await open(harness, run, 'coder', { parentAttemptId: lead.attempt.id });
    const leadRow = store.requireAttempt(lead.attempt.id);
    const childRow = store.requireAttempt(child.attempt.id);
    expect(childRow.parentAttemptId).toBe(leadRow.id);
    expect(leadRow.parentAttemptId).toBeNull();

    const host = orchestrator.mcpHost;
    expect(await host.listAgents(binding(childRow))).toEqual({
      parent: { attemptId: leadRow.id, role: 'planner', nodeId: null, status: 'running' },
      children: [],
    });
    expect(await host.listAgents(binding(leadRow))).toMatchObject({
      parent: null,
      children: [{ attemptId: childRow.id, role: 'coder' }],
    });

    // The lead waits first; the child's question resolves it immediately.
    const leadWait = host.awaitMessage(binding(leadRow), { replyTo: null, timeoutMs: null });
    const question = await host.sendMessage(binding(childRow), {
      to: leadRow.id,
      kind: 'question',
      body: 'Which db?',
      replyTo: null,
    });
    const received = await leadWait;
    expect(received).toMatchObject({ id: question.id, kind: 'question', body: 'Which db?' });
    expect(received?.deliveredAt).not.toBeNull();

    // The child waits for the reply to its question; an unrelated message does not satisfy it.
    const childWait = host.awaitMessage(binding(childRow), { replyTo: question.id, timeoutMs: null });
    await host.sendMessage(binding(leadRow), { to: childRow.id, kind: 'status', body: 'thinking', replyTo: null });
    let settled = false;
    void childWait.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    const answer = await host.sendMessage(binding(leadRow), {
      to: childRow.id,
      kind: 'answer',
      body: 'sqlite',
      replyTo: question.id,
    });
    expect(await childWait).toMatchObject({ id: answer.id, body: 'sqlite', replyTo: question.id });

    // The status message is still queued for the child; a later wait returns it at once.
    const status = await host.awaitMessage(binding(childRow), { replyTo: null, timeoutMs: 1000 });
    expect(status).toMatchObject({ kind: 'status', body: 'thinking' });
    expect(store.listMessages(run.id).every((m) => m.deliveredAt !== null)).toBe(true);
    expect(await harness.client.call('messages.list', { runId: run.id })).toHaveLength(3);

    // Nothing left: a timed wait returns null.
    expect(await host.awaitMessage(binding(childRow), { replyTo: null, timeoutMs: 20 })).toBeNull();
    await lead.close();
    await child.close();
  });

  it('refuses sends outside the parent/child edge and bad reply_to ids', async () => {
    h = await startHarness({ script: idle });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = newRun(harness);
    const lead = await open(harness, run, 'planner');
    const a = await open(harness, run, 'coder', { parentAttemptId: lead.attempt.id });
    const b = await open(harness, run, 'coder', { parentAttemptId: lead.attempt.id });
    const stranger = await open(harness, run, 'coder');
    const host = orchestrator.mcpHost;
    const send = async (from: AgentRun, to: AgentRun, replyTo: string | null = null) =>
      host.sendMessage(binding(store.requireAttempt(from.attempt.id)), {
        to: to.attempt.id,
        kind: 'status',
        body: 'x',
        replyTo,
      });
    await expect(send(a, b)).rejects.toThrow(/ask your lead/);
    await expect(send(lead, stranger)).rejects.toThrow(/not one of your agents/);
    await expect(send(stranger, lead)).rejects.toThrow(/not one of your agents/);
    await expect(send(a, lead, 'msg_nope')).rejects.toThrow(/unknown reply_to/);
    expect(store.listMessages(run.id)).toEqual([]);
    for (const s of [lead, a, b, stranger]) await s.close();
  });

  it('delivers queued messages with the prompt when the engine session is resumed, once', async () => {
    h = await startHarness({ script: idle });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = newRun(harness);
    const lead = await open(harness, run, 'planner');
    const child = await open(harness, run, 'coder', { parentAttemptId: lead.attempt.id });
    const sessionId = child.sessionId;
    await child.close();
    await harness.waitFor(() => !orchestrator.live.has(child.attempt.id), 'child gone');

    const host = orchestrator.mcpHost;
    const brief = await host.sendMessage(binding(store.requireAttempt(lead.attempt.id)), {
      to: child.attempt.id,
      kind: 'brief',
      body: 'Also update the docs.',
      replyTo: null,
    });
    expect(store.getMessage(brief.id)?.deliveredAt).toBeNull();

    // A fix round: a new attempt continuing the same engine session inherits the parent and the mail.
    const resumed = await open(harness, run, 'coder', {
      resumeSessionId: sessionId,
      prompt: 'Fix the review findings.',
    });
    const row = store.requireAttempt(resumed.attempt.id);
    expect(row.id).not.toBe(child.attempt.id);
    expect(row.parentAttemptId).toBe(lead.attempt.id);
    const record = harness.claude.sessions.find((s) => s.session === resumed.session);
    expect(record?.resumed).toBe(true);
    expect(record?.opts.prompt).toContain(`### Brief from planner (${lead.attempt.id}) · id ${brief.id}`);
    expect(record?.opts.prompt).toContain('Also update the docs.');
    expect(record?.opts.prompt).toMatch(/---\n\nFix the review findings\.$/);
    expect(store.getMessage(brief.id)?.deliveredAt).not.toBeNull();

    // Resuming again carries nothing: the message was delivered exactly once.
    await resumed.close();
    await harness.waitFor(() => !orchestrator.live.has(resumed.attempt.id), 'resumed gone');
    const again = await open(harness, run, 'coder', { resumeSessionId: sessionId, prompt: 'Again.' });
    const record2 = harness.claude.sessions.find((s) => s.session === again.session);
    expect(record2?.opts.prompt).toBe('Again.');
    await again.close();
    await lead.close();
  });

  it('rejects a blocked wait when the waiting session ends', async () => {
    h = await startHarness({ script: idle });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const run = newRun(harness);
    const lead = await open(harness, run, 'planner');
    const child = await open(harness, run, 'coder', { parentAttemptId: lead.attempt.id });
    const wait = orchestrator.mcpHost.awaitMessage(binding(store.requireAttempt(child.attempt.id)), {
      replyTo: null,
      timeoutMs: null,
    });
    await child.close();
    await expect(wait).rejects.toThrow(/session ended/);
    await lead.close();
  });
});
