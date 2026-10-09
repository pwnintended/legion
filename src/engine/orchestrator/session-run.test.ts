/**
 * Direct sessions (`runs.session`): one agent in the project's checkout, talked to directly, stopped between
 * turns and resumed by the human's next message, ended by archiving or stopping the run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@shared/domain';
import { runShort } from '@shared/ids';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeTurnContext } from '../adapters/fake';
import { runMeta } from './meta';
import { type Harness, type Script, startHarness } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function recorder() {
  const turns: FakeTurnContext[] = [];
  const script: Script = (ctx) => {
    turns.push(ctx);
    if (ctx.opts.role !== 'session') throw new Error(`unexpected ${ctx.opts.role} session`);
    return ctx.turn === 0 && !ctx.resumed
      ? [
          { kind: 'write_file', path: 'notes.txt', content: 'edited in place\n' },
          { kind: 'text', text: 'Wrote notes.txt.' },
        ]
      : [{ kind: 'text', text: 'ok' }];
  };
  return { turns, script };
}

async function startSession(harness: Harness, prompt = 'Add a notes file.', worktree = false) {
  const run = await harness.client.call('runs.session', {
    repoPath: harness.repo.path,
    worktree,
    prompt,
    engine: 'claude',
    model: null,
    attachmentIds: null,
  });
  const attempt = await harness.waitFor(() => {
    const id = runMeta(harness.engine.store, run.id).sessionAttemptId;
    return id ? harness.engine.store.getAttempt(id) : null;
  }, 'session attempt');
  return { run, attempt };
}

const status = (harness: Harness, run: Run) => harness.engine.store.requireRun(run.id).status;

/** The session's turn ended and its process was stopped. */
const stopped = (harness: Harness, attemptId: string) =>
  harness.waitFor(
    () =>
      harness.engine.store.getAttempt(attemptId)?.status === 'succeeded' && harness.engine.orchestrator.live.size === 0,
    'session stopped',
  );

describe('a direct session', () => {
  it('works in the checkout itself, with no plan, and takes the human’s follow-ups', async () => {
    const rec = recorder();
    h = await startHarness({ script: rec.script });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    expect(run.status).toBe('session');
    expect(attempt.role).toBe('session');
    expect(attempt.engine).toBe('fake');
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const first = rec.turns[0] as FakeTurnContext;
    expect(first.opts.cwd).toBe(run.repoPath);
    expect(first.opts.permission.mode).toBe('workspace_write');
    expect(first.message).toBe('Add a notes file.');
    await harness.waitFor(() => existsSync(join(harness.repo.path, 'notes.txt')), 'the edit');
    expect(readFileSync(join(harness.repo.path, 'notes.txt'), 'utf8')).toBe('edited in place\n');
    await stopped(harness, attempt.id);
    expect(status(harness, run)).toBe('session');

    // The finished attempt is the one the human sees: a message to it resumes the engine session.
    await harness.client.call('sessions.send', {
      attemptId: attempt.id,
      text: 'Thanks. Now say ok.',
      priority: 'next',
      attachmentIds: null,
    });
    await harness.waitFor(() => rec.turns.length === 2, 'second turn');
    expect(rec.turns[1]?.message).toBe('Thanks. Now say ok.');
    expect(rec.turns[1]?.resumed).toBe(true);
    expect(status(harness, run)).toBe('session');
    expect(harness.engine.store.listTasks(run.id)).toEqual([]);
    expect(harness.engine.store.latestPlan(run.id)).toBeNull();
    const attempts = harness.engine.store.listAttempts(run.id);
    expect(attempts.map((a) => a.role)).toEqual(['session', 'session']);
    expect(attempts[1]?.sessionId).toBe(attempts[0]?.sessionId);
    await stopped(harness, attempts[1]?.id as string);
  }, 60_000);

  it('works in a worktree of its own when asked, leaving the checkout alone', async () => {
    const rec = recorder();
    h = await startHarness({ script: rec.script });
    const harness = h;
    const { run, attempt } = await startSession(harness, 'Add a notes file.', true);
    expect(run.integrationBranch).toBe(`legion/${runShort(run.id)}/integration`);
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const worktree = harness.engine.orchestrator.integrationPath(run);
    expect(rec.turns[0]?.opts.cwd).toBe(worktree);
    expect(rec.turns[0]?.opts.systemPrompt).toContain('worktree');
    await harness.waitFor(() => existsSync(join(worktree, 'notes.txt')), 'the edit');
    expect(existsSync(join(harness.repo.path, 'notes.txt'))).toBe(false);
    expect(await harness.repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    await stopped(harness, attempt.id);

    // Archiving keeps the worktree with its uncommitted edit.
    const archived = await harness.client.call('runs.archive', { runId: run.id });
    expect(archived.status).toBe('done');
    expect(archived.archiveReport?.kept.map((k) => k.kind)).toContain('worktree');
    expect(existsSync(join(worktree, 'notes.txt'))).toBe(true);
  }, 60_000);

  it('sends the human’s prompt layers: their replacement, their additions, then the repository’s', async () => {
    const rec = recorder();
    h = await startHarness({
      script: rec.script,
      settings: {
        roles: { session: { prompt: { append: 'Answer in one line.', replace: 'You pair with the human.' } } },
      },
    });
    const harness = h;
    writeFileSync(join(harness.repo.path, 'legion.json'), '{ "prompts": { "session": "Use pnpm, never npm." } }\n');
    const { attempt } = await startSession(harness);
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    expect(rec.turns[0]?.opts.systemPrompt).toBe(
      [
        'You pair with the human.',
        '## Additional instructions\n\nAnswer in one line.',
        '## Additional instructions for this repository\n\nUse pnpm, never npm.',
      ].join('\n\n'),
    );
    await stopped(harness, attempt.id);
  }, 60_000);

  it('is not woken by an engine restart while it waits for the human', async () => {
    const rec = recorder();
    h = await startHarness({ script: rec.script });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    await stopped(harness, attempt.id);
    await harness.restart();
    await harness.waitFor(() => harness.engine.orchestrator.sessionLoops.has(run.id), 'session loop');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rec.turns).toHaveLength(1);
    expect(harness.engine.store.listAttempts(run.id)).toHaveLength(1);
    expect(harness.engine.store.getAttempt(attempt.id)?.status).toBe('succeeded');

    await harness.client.call('sessions.send', {
      attemptId: attempt.id,
      text: 'One more thing.',
      priority: 'next',
      attachmentIds: null,
    });
    const resumed = await harness.waitFor(() => rec.turns.find((t) => t.resumed), 'resumed turn');
    expect(resumed.message).toBe('One more thing.');
    expect(resumed.opts.cwd).toBe(run.repoPath);
    expect(status(harness, run)).toBe('session');
  }, 60_000);

  it('resumes a turn an engine restart cut off', async () => {
    const turns: FakeTurnContext[] = [];
    h = await startHarness({
      script: (ctx) => {
        turns.push(ctx);
        return ctx.resumed ? [{ kind: 'text', text: 'ok' }] : [{ kind: 'delay', ms: 30_000 }];
      },
    });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    const sessionId = await harness.waitFor(
      () => harness.engine.store.getAttempt(attempt.id)?.sessionId,
      'engine session id',
    );
    await harness.restart();
    const resumed = await harness.waitFor(() => turns.find((t) => t.resumed), 'resumed turn');
    expect(resumed.message).toMatch(/restarted this session in the middle of your turn/);
    const attempts = harness.engine.store.listAttempts(run.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[1]?.sessionId).toBe(sessionId);
    await stopped(harness, attempts[1]?.id as string);
    expect(runMeta(harness.engine.store, run.id).sessionTurnOpen).toBe(false);
  }, 60_000);

  it('ends as done when archived, without a forced cancel', async () => {
    const rec = recorder();
    h = await startHarness({ script: rec.script });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const archived = await harness.client.call('runs.archive', { runId: run.id });
    expect(archived.status).toBe('done');
    expect(archived.archived).toBe(true);
    expect(harness.engine.store.getAttempt(attempt.id)?.status).toBe('succeeded');
    expect(harness.engine.orchestrator.live.size).toBe(0);
    // The work stays in the checkout.
    expect(existsSync(join(harness.repo.path, 'notes.txt'))).toBe(true);
  }, 60_000);

  it('stops for good when cancelled', async () => {
    const rec = recorder();
    h = await startHarness({ script: rec.script });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const cancelled = await harness.client.call('runs.cancel', { runId: run.id });
    expect(cancelled.status).toBe('cancelled');
    await harness.waitFor(() => !harness.engine.orchestrator.sessionLoops.has(run.id), 'loop ended');
    // Its turn had ended: the attempt was already stopped.
    expect(harness.engine.store.getAttempt(attempt.id)?.status).toBe('succeeded');
    expect(harness.engine.store.listAttempts(run.id)).toHaveLength(1);
  }, 60_000);

  it('stops mid-turn when cancelled', async () => {
    h = await startHarness({ script: () => [{ kind: 'delay', ms: 30_000 }] });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    await harness.waitFor(() => harness.engine.orchestrator.live.size === 1, 'live session');
    await harness.client.call('runs.cancel', { runId: run.id });
    await harness.waitFor(() => !harness.engine.orchestrator.sessionLoops.has(run.id), 'loop ended');
    expect(harness.engine.store.getAttempt(attempt.id)?.status).toBe('cancelled');
    expect(harness.engine.orchestrator.live.size).toBe(0);
  }, 60_000);
});
