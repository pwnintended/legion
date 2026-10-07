import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentSession, permissionProfileFor, type SessionOptions } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import {
  AGENT_OUTPUT_JSON_SCHEMAS,
  ClarifyOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  TaskReportSchema,
} from '@shared/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/helpers';
import { FAKE_PLAN_OUTPUT, FakeEngine, type FakeSession, fakeOutputFor } from './index';

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => dir.cleanup());

const options = (overrides: Partial<SessionOptions> = {}): SessionOptions => ({
  role: 'coder',
  cwd: dir.path,
  prompt: 'do the thing',
  permission: permissionProfileFor('coder', ['pnpm test']),
  mcp: null,
  env: {},
  ...overrides,
});

const iterators = new WeakMap<AgentSession, AsyncIterator<AgentEvent>>();

/** Collect events until the predicate matches (inclusive). Sessions have a single consumer. */
async function until(session: AgentSession, done: (event: AgentEvent) => boolean): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let iterator = iterators.get(session);
  if (!iterator) {
    iterator = session.events[Symbol.asyncIterator]();
    iterators.set(session, iterator);
  }
  for (;;) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
    if (done(next.value)) return events;
  }
}

const isTurnComplete = (event: AgentEvent) => event.type === 'turn_complete';

describe('FakeEngine', () => {
  it('probes as installed', async () => {
    const info = await new FakeEngine().probe();
    expect(info).toMatchObject({ kind: 'fake', installed: true, loggedIn: true, error: null });
  });

  it('emits session_started, text, tools and schema-derived output', async () => {
    const engine = new FakeEngine();
    const session = await engine.start(options({ role: 'reviewer', outputSchema: AGENT_OUTPUT_JSON_SCHEMAS.review }));
    expect(session.id).toMatch(/^fake-session-/);
    const events = await until(session, isTurnComplete);
    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: session.id });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['text_delta', 'message', 'tool_call', 'tool_result', 'usage', 'turn_complete']),
    );
    const last = events.at(-1);
    if (last?.type !== 'turn_complete') throw new Error('expected turn_complete');
    expect(last.isError).toBe(false);
    expect(ReviewOutputSchema.parse(last.structuredOutput).verdict).toBe('approve');
    await session.close();
    const rest = await until(session, () => false);
    expect(rest).toEqual([{ type: 'exited', code: 0 }]);
    expect(engine.sessions).toHaveLength(1);
  });

  it('produces valid output for every agent schema', () => {
    expect(ClarifyOutputSchema.safeParse(fakeOutputFor(AGENT_OUTPUT_JSON_SCHEMAS.clarify)).success).toBe(true);
    expect(PlanOutputSchema.safeParse(fakeOutputFor(AGENT_OUTPUT_JSON_SCHEMAS.plan)).success).toBe(true);
    expect(ReviewOutputSchema.safeParse(fakeOutputFor(AGENT_OUTPUT_JSON_SCHEMAS.review)).success).toBe(true);
    expect(TaskReportSchema.safeParse(fakeOutputFor(AGENT_OUTPUT_JSON_SCHEMAS.taskReport)).success).toBe(true);
    expect(fakeOutputFor(null)).toBeNull();
    expect(PlanOutputSchema.parse(FAKE_PLAN_OUTPUT).dag.nodes).toHaveLength(2);
  });

  it('edits a file in cwd', async () => {
    const session = await new FakeEngine({ script: 'edit' }).start(
      options({ outputSchema: AGENT_OUTPUT_JSON_SCHEMAS.taskReport }),
    );
    const events = await until(session, isTurnComplete);
    expect(readFileSync(join(dir.path, 'FAKE_CHANGE.md'), 'utf8')).toBe('fake change\n');
    expect(events).toContainEqual({ type: 'file_change', path: 'FAKE_CHANGE.md', added: 1, removed: 0 });
    const last = events.at(-1);
    expect(last?.type === 'turn_complete' && TaskReportSchema.parse(last.structuredOutput).status).toBe('done');
    await session.close();
  });

  it('refuses to write outside cwd', async () => {
    const session = await new FakeEngine({
      script: () => [{ kind: 'write_file', path: '../escape.txt', content: 'x' }],
    }).start(options());
    const events = await until(session, (e) => e.type === 'exited');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('outside cwd') }),
    );
    expect(events.at(-1)).toEqual({ type: 'exited', code: 1 });
    expect(existsSync(join(dir.path, '..', 'escape.txt'))).toBe(false);
  });

  it('asks for approval and continues when allowed', async () => {
    const session = (await new FakeEngine({ script: 'approval' }).start(options())) as FakeSession;
    const before = await until(session, (e) => e.type === 'approval_request');
    const request = before.at(-1);
    if (request?.type !== 'approval_request') throw new Error('expected approval_request');
    expect(request).toMatchObject({ tool: 'Bash', requestId: 'fake-approval-1' });
    await expect(session.respond('unknown', { behavior: 'deny', message: 'x', interrupt: false })).rejects.toThrow();
    await session.respond(request.requestId, { behavior: 'allow', scope: 'once', updatedInput: null });
    await until(session, isTurnComplete);
    expect(existsSync(join(dir.path, 'APPROVED.md'))).toBe(true);
    expect(session.decisions.get('fake-approval-1')?.behavior).toBe('allow');
    await session.close();
  });

  it('skips the guarded steps when denied', async () => {
    const session = await new FakeEngine({ script: 'approval' }).start(options());
    await until(session, (e) => e.type === 'approval_request');
    await session.respond('fake-approval-1', { behavior: 'deny', message: 'no', interrupt: false });
    const events = await until(session, isTurnComplete);
    expect(events).toContainEqual({ type: 'message', text: 'Approval denied: no' });
    expect(existsSync(join(dir.path, 'APPROVED.md'))).toBe(false);
    await session.close();
  });

  it('fails with an error, a failed turn and a non-zero exit', async () => {
    const session = await new FakeEngine({ script: 'fail' }).start(options());
    const events = await until(session, () => false);
    expect(events.slice(-3)).toEqual([
      { type: 'error', message: 'fake failure', retryable: true },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'fake failure' },
      { type: 'exited', code: 1 },
    ]);
    await expect(session.send('again')).rejects.toThrow(/closed/);
  });

  it('runs a new turn per send and supports interrupt', async () => {
    const engine = new FakeEngine({
      script: ({ turn, message }) =>
        turn === 0 ? [{ kind: 'delay', ms: 10_000 }] : [{ kind: 'text', text: `echo ${message}` }],
    });
    const session = await engine.start(options());
    await until(session, (e) => e.type === 'session_started');
    await session.interrupt();
    const interrupted = await until(session, isTurnComplete);
    expect(interrupted.at(-1)).toEqual({
      type: 'turn_complete',
      structuredOutput: null,
      isError: true,
      reason: 'interrupted',
    });
    await session.send('hello');
    const second = await until(session, isTurnComplete);
    expect(second).toContainEqual({ type: 'message', text: 'echo hello' });
    await session.close();
  });

  it('resume keeps the session id and exitAfterTurn ends the stream', async () => {
    const engine = new FakeEngine({ script: 'structured', exitAfterTurn: true });
    const session = await engine.resume(
      'existing-session',
      options({ outputSchema: AGENT_OUTPUT_JSON_SCHEMAS.clarify }),
    );
    expect(session.id).toBe('existing-session');
    const events = await until(session, () => false);
    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: 'existing-session' });
    expect(events.at(-1)).toEqual({ type: 'exited', code: 0 });
    expect(engine.sessions[0]?.resumed).toBe(true);
  });

  it('closes when the abort signal fires', async () => {
    const controller = new AbortController();
    const session = await new FakeEngine({ script: () => [{ kind: 'delay', ms: 10_000 }] }).start(
      options({ signal: controller.signal }),
    );
    controller.abort();
    const events = await until(session, () => false);
    expect(events.at(-1)).toEqual({ type: 'exited', code: 0 });
  });
});
