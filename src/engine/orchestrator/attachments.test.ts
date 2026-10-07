/**
 * Attachments through the lifecycle (fake engines): the planner gets the run's files with its first
 * message and the clarify answers' files with the plan prompt, fresh coders and reviewers get all of them,
 * steer messages carry their own, and the PR body names them.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { sevenPng } from '../attachments/testing';
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

const names = (list: readonly { name: string }[] | null | undefined) => (list ?? []).map((a) => a.name);
const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);

const script: Script = (ctx) => {
  if (ctx.opts.role === 'planner') {
    if (plannerKind(ctx) === 'clarify') {
      return [{ kind: 'output', value: { questions: [{ id: 'q1', question: 'Which style?', options: [] }] } }];
    }
    return [planOutput([node('T1')])];
  }
  if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
  if (ctx.turn === 0) return [{ kind: 'delay', ms: 60_000 }, report('never')];
  const id = taskIdIn(ctx.opts.prompt);
  return [{ kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: 'done\n' }, report(`Implement ${id}`)];
};

describe('attachments in a run', () => {
  it('reach the planner, the clarify follow-up, coders, reviewers, steer messages and the PR body', async () => {
    h = await startHarness({ script });
    const harness = h;
    const { client, claude, codex } = harness;
    const png = await client.call('attachments.add', {
      name: 'seven.png',
      mime: 'image/png',
      dataBase64: sevenPng().toString('base64'),
    });
    const notesPath = join(harness.repo.scratch, 'notes.md');
    writeFileSync(notesPath, '# Notes\n\nKeep it short.\n');
    const notes = await client.call('attachments.add', { name: 'notes.md', path: notesPath });
    expect(png).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(notes).toMatchObject({ kind: 'text', mime: 'text/markdown' });

    await expect(
      client.call('runs.create', {
        repoPath: harness.repo.path,
        baseRef: 'main',
        title: null,
        issueText: 'x',
        issueUrl: null,
        plannerEngine: 'claude',
        plannerModel: null,
        skipClarify: true,
        attachmentIds: ['file_doesnotexist'],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const run = await client.call('runs.create', {
      repoPath: harness.repo.path,
      baseRef: 'main',
      title: 'Match the mockup',
      issueText: 'Make the settings page look like the screenshot.',
      issueUrl: null,
      plannerEngine: 'claude',
      plannerModel: null,
      skipClarify: false,
      attachmentIds: [png.id, notes.id],
    });
    expect(names(run.attachments)).toEqual(['seven.png', 'notes.md']);
    expect(harness.engine.store.getAttachment(png.id)?.runId).toBe(run.id);

    // Clarify: a fresh planner session with both files and a prompt that names them.
    const question = await harness.waitFor(
      () =>
        harness.engine.store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'question'),
      'clarify question',
    );
    const clarify = claude.sessions.find((s) => s.opts.role === 'planner');
    expect(clarify?.resumed).toBe(false);
    expect(names(clarify?.opts.attachments)).toEqual(['seven.png', 'notes.md']);
    expect(clarify?.opts.attachments?.[0]?.path).toMatch(new RegExp(`attachments/${png.sha256}\\.png$`));
    expect(clarify?.opts.prompt).toContain('Attached by the human: `seven.png` (image), `notes.md` (text file).');

    // The answer brings a mockup: only that one travels with the resumed plan prompt.
    const mockup = await client.call('attachments.add', {
      name: 'mockup.png',
      dataBase64: sevenPng().toString('base64'),
    });
    await client.call('runs.answerClarify', {
      runId: run.id,
      answers: [{ questionId: 'q1', answer: 'Like the mockup' }],
      attachmentIds: [mockup.id],
    });
    expect(harness.engine.store.getInboxItem(question.id)).toMatchObject({
      resolution: { attachments: [expect.objectContaining({ id: mockup.id, name: 'mockup.png' })] },
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const planSession = claude.sessions.filter((s) => s.opts.role === 'planner')[1];
    expect(planSession?.resumed).toBe(true);
    expect(names(planSession?.opts.attachments)).toEqual(['mockup.png']);
    expect(planSession?.opts.prompt).toContain('`mockup.png` (image)');

    // Coder (fresh) and reviewer get all three.
    const plan = harness.engine.store.latestPlan(run.id);
    await client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    const attempt = await harness.waitFor(
      () =>
        harness.engine.store
          .listAttempts(run.id)
          .find((a) => a.role === 'coder' && a.status === 'running' && harness.engine.orchestrator.live.has(a.id)),
      'live coder',
    );
    const coder = claude.sessions.find((s) => s.opts.role === 'coder');
    expect(names(coder?.opts.attachments)).toEqual(['seven.png', 'notes.md', 'mockup.png']);

    // A steer message with its own attachment.
    const log = await client.call('attachments.add', {
      name: 'error.log',
      dataBase64: Buffer.from('boom').toString('base64'),
    });
    await client.call('sessions.interrupt', { attemptId: attempt.id });
    await client.call('sessions.send', {
      attemptId: attempt.id,
      text: 'Here is the error',
      priority: 'next',
      attachmentIds: [log.id],
    });
    expect(coder?.session.sent.at(-1)).toMatchObject({ text: 'Here is the error' });
    expect(names(coder?.session.sent.at(-1)?.attachments)).toEqual(['error.log']);
    expect(harness.engine.store.getAttachment(log.id)?.runId).toBe(run.id);

    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const reviewer = codex.sessions.find((s) => s.opts.role === 'reviewer');
    expect(names(reviewer?.opts.attachments)).toEqual(['seven.png', 'notes.md', 'mockup.png']);
    const pr = harness.engine.store
      .listInbox({ runId: run.id, includeResolved: false })
      .find((i) => i.kind === 'pr_ready');
    expect(pr?.kind === 'pr_ready' && pr.payload.body).toContain('Attachments: `seven.png`, `notes.md`, `mockup.png`');
  });
});
