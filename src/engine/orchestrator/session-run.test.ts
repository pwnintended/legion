/**
 * Direct sessions (`runs.session`): one agent in the project's checkout, talked to directly, kept open across
 * engine restarts, ended by archiving or stopping the run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@shared/domain';
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

async function startSession(harness: Harness, prompt = 'Add a notes file.') {
  const run = await harness.client.call('runs.session', {
    repoPath: harness.repo.path,
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

    await harness.client.call('sessions.send', {
      attemptId: attempt.id,
      text: 'Thanks. Now say ok.',
      priority: 'next',
      attachmentIds: null,
    });
    await harness.waitFor(() => rec.turns.length === 2, 'second turn');
    expect(rec.turns[1]?.message).toBe('Thanks. Now say ok.');
    expect(status(harness, run)).toBe('session');
    expect(harness.engine.store.listTasks(run.id)).toEqual([]);
    expect(harness.engine.store.latestPlan(run.id)).toBeNull();
    expect(harness.engine.store.listAttempts(run.id).map((a) => a.role)).toEqual(['session']);
  }, 60_000);

  it('resumes its engine session after an engine restart', async () => {
    const rec = recorder();
    h = await startHarness({ script: rec.script });
    const harness = h;
    const { run, attempt } = await startSession(harness);
    await harness.waitFor(() => rec.turns.length === 1, 'first turn');
    const sessionId = await harness.waitFor(
      () => harness.engine.store.getAttempt(attempt.id)?.sessionId,
      'engine session id',
    );
    await harness.restart();
    const resumed = await harness.waitFor(() => rec.turns.find((t) => t.resumed), 'resumed turn');
    expect(resumed.opts.cwd).toBe(run.repoPath);
    const attempts = harness.engine.store.listAttempts(run.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[1]?.sessionId).toBe(sessionId);
    expect(status(harness, run)).toBe('session');
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
    expect(harness.engine.store.getAttempt(attempt.id)?.status).toBe('cancelled');
    expect(harness.engine.store.listAttempts(run.id)).toHaveLength(1);
  }, 60_000);
});
