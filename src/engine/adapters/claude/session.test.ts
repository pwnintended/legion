import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentSession, permissionProfileFor, type Role, type SessionOptions } from '@shared/engine';
import type { AgentEvent, AgentEventOf } from '@shared/events';
import { AGENT_OUTPUT_JSON_SCHEMAS, ClarifyOutputSchema } from '@shared/schemas';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../context';
import { ClaudeEngine } from './engine';
import { ClaudeSession, type SessionTiming } from './session';
import { FakeChild, type FixtureLine, fixtureSessionId, loadFixture, replayFixture } from './testing';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const CWD = '/tmp/legion-fixture';
const FAST: Partial<SessionTiming> = { coalesceMs: 0, interruptTimeoutMs: 50, closeGraceMs: 50, killTimeoutMs: 50 };

function options(role: Role, overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    role,
    cwd: CWD,
    prompt: 'hi',
    model: 'haiku',
    permission: permissionProfileFor(role, []),
    mcp: null,
    env: { PATH: '/usr/bin:/bin' },
    ...overrides,
  };
}

/** Engine whose spawn hands out FakeChilds (recorded in `spawned`). */
function fakeEngine(timing: Partial<SessionTiming> = FAST) {
  const spawned: { child: FakeChild; args: readonly string[]; env: Record<string, string> }[] = [];
  const engine = new ClaudeEngine({
    binaryPath: process.execPath, // any executable; never run
    log: silentLogger,
    timing,
    spawn: (_command, args, { env }) => {
      const child = new FakeChild();
      spawned.push({ child, args, env });
      return child;
    },
  });
  return { engine, spawned };
}

const iterators = new WeakMap<AgentSession, AsyncIterator<AgentEvent>>();
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
const all = (session: AgentSession) => until(session, () => false);
const isTurnComplete = (e: AgentEvent) => e.type === 'turn_complete';
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);
const fixture = (name: string): FixtureLine[] => loadFixture(join(FIXTURES, name));

describe('ClaudeSession (fixture replay)', () => {
  it('plays a Read turn end to end and exits on close', async () => {
    const { engine, spawned } = fakeEngine();
    const lines = fixture('read.jsonl');
    const session = await engine.start(options('reviewer', { prompt: 'read it' }));
    const [{ child, args }] = spawned as [(typeof spawned)[number]];
    const preassigned = session.id;
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(preassigned);
    expect(child.written[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'read it' } });

    const replay = replayFixture(child, lines);
    const turn = await until(session, isTurnComplete);
    expect(turn[0]).toMatchObject({ type: 'session_started', model: 'claude-haiku-4-5-20251001' });
    expect(session.id).toBe(fixtureSessionId(lines));
    expect(of(turn, 'tool_call')[0]).toMatchObject({ name: 'Read', kind: 'read' });
    expect(turn.at(-1)).toMatchObject({ type: 'turn_complete', isError: false });

    await session.close();
    await replay;
    expect(await all(session)).toEqual([{ type: 'exited', code: 0 }]);
    expect(child.stdinEnded).toBe(true);
    expect(child.signals).toEqual([]);
  });

  it('round-trips a denied approval over the control protocol', async () => {
    const { engine, spawned } = fakeEngine();
    const session = await engine.start(options('coder'));
    const { child } = spawned[0] as (typeof spawned)[number];
    const replay = replayFixture(child, fixture('approval-denied.jsonl'));

    const before = await until(session, (e) => e.type === 'approval_request');
    expect(of(before, 'file_change')).toEqual([{ type: 'file_change', path: 'notes.txt', added: 1, removed: 0 }]);
    const request = before.at(-1);
    if (request?.type !== 'approval_request') throw new Error('expected approval_request');
    expect(request.tool).toBe('Bash');
    await session.respond(request.requestId, { behavior: 'deny', message: 'Not allowed by Legion.', interrupt: false });
    const written = child.written.at(-1);
    expect(written).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.requestId,
        response: { behavior: 'deny', message: 'Not allowed by Legion.', toolUseID: expect.any(String) },
      },
    });
    await expect(
      session.respond(request.requestId, { behavior: 'deny', message: 'x', interrupt: false }),
    ).rejects.toThrow(/no pending approval/);

    const after = await until(session, isTurnComplete);
    expect(of(after, 'message').at(-1)?.text).toBe('DENIED');
    await session.close();
    await replay;
  });

  it('interrupts via the control protocol and accepts the next message', async () => {
    const { engine, spawned } = fakeEngine();
    const session = await engine.start(options('reviewer'));
    const { child } = spawned[0] as (typeof spawned)[number];
    const replay = replayFixture(child, fixture('interrupt.jsonl'));

    await until(session, (e) => e.type === 'session_started');
    const interrupted = session.interrupt();
    const turn = await until(session, isTurnComplete);
    await interrupted;
    expect(child.written.at(1)).toEqual({
      type: 'control_request',
      request_id: 'legion-interrupt-1',
      request: { subtype: 'interrupt' },
    });
    expect(turn.at(-1)).toEqual({
      type: 'turn_complete',
      structuredOutput: null,
      isError: true,
      reason: 'interrupted',
    });
    expect(child.signals).toEqual([]);

    await session.send('Reply with exactly: still here');
    const next = await until(session, isTurnComplete);
    expect(of(next, 'session_started')).toEqual([]);
    expect(of(next, 'message').at(-1)?.text).toBe('still here');
    expect(next.at(-1)).toMatchObject({ isError: false });
    await session.close();
    await replay;
  });

  it('reports structured output on turn_complete', async () => {
    const { engine, spawned } = fakeEngine();
    const session = await engine.start(options('planner', { outputSchema: AGENT_OUTPUT_JSON_SCHEMAS.clarify }));
    const { child, args } = spawned[0] as (typeof spawned)[number];
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1] as string)).toEqual(AGENT_OUTPUT_JSON_SCHEMAS.clarify);
    const replay = replayFixture(child, fixture('structured.jsonl'));
    const turn = await until(session, isTurnComplete);
    const done = turn.at(-1);
    expect(done?.type === 'turn_complete' && ClarifyOutputSchema.parse(done.structuredOutput).questions).toHaveLength(
      1,
    );
    await session.close();
    await replay;
  });

  it('resumes with --resume and keeps the id', async () => {
    const { engine, spawned } = fakeEngine();
    const lines = fixture('resume.jsonl');
    const id = fixtureSessionId(lines);
    const session = await engine.resume(id, options('planner', { prompt: 'What was the codeword?' }));
    const { child, args } = spawned[0] as (typeof spawned)[number];
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', id]);
    expect(args).not.toContain('--session-id');
    expect(session.id).toBe(id);
    const replay = replayFixture(child, lines);
    const turn = await until(session, isTurnComplete);
    expect(turn[0]).toMatchObject({ type: 'session_started', sessionId: id });
    expect(of(turn, 'message').at(-1)?.text).toBe('ZEBRA-17');
    await session.close();
    await replay;
  });

  it('writes the MCP config to a private temp file and removes it on exit', async () => {
    const { engine, spawned } = fakeEngine();
    const session = await engine.start(
      options('reviewer', { mcp: { url: 'http://127.0.0.1:1/mcp', token: 'secret' } }),
    );
    const { child, args } = spawned[0] as (typeof spawned)[number];
    const path = args[args.indexOf('--mcp-config') + 1] as string;
    expect(args.join(' ')).not.toContain('secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: {
        legion: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer secret' } },
      },
    });
    const replay = replayFixture(child, fixture('mcp.jsonl'));
    const turn = await until(session, isTurnComplete);
    expect(of(turn, 'tool_call').find((e) => e.kind === 'mcp')?.name).toBe('mcp__legion__echo');
    await session.close();
    await replay;
    await all(session);
    expect(existsSync(path)).toBe(false);
  });

  it('strips parent Claude Code session variables from the child env', async () => {
    const { engine, spawned } = fakeEngine();
    await engine.start(
      options('reviewer', { env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', HOME: '/h' } }),
    );
    expect(spawned[0]?.env).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('ClaudeSession (lifecycle)', () => {
  function session(timing: Partial<SessionTiming> = FAST, overrides: Partial<SessionOptions> = {}) {
    const child = new FakeChild();
    const s = new ClaudeSession({
      child,
      sessionId: 'sid',
      opts: options('coder', overrides),
      log: silentLogger,
      timing,
    });
    return { child, session: s };
  }
  const init = { type: 'system', subtype: 'init', session_id: 'sid', model: 'm', claude_code_version: '2.1.289' };
  const success = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, modelUsage: {} };

  it('escalates close: stdin end, SIGTERM, SIGKILL', async () => {
    const { child, session: s } = session();
    child.onKill = (signal) => {
      if (signal === 'SIGKILL') child.exit(null, signal);
    };
    await s.close();
    expect(child.stdinEnded).toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await all(s)).toEqual([{ type: 'exited', code: null }]);
    await s.close(); // idempotent
  });

  it('closing mid-turn terminates at once and ends the turn as interrupted', async () => {
    const { child, session: s } = session({ ...FAST, closeGraceMs: 10_000 });
    s.begin('work');
    child.send(init);
    await until(s, (e) => e.type === 'session_started');
    await s.close();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(await all(s)).toEqual([
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'interrupted' },
      { type: 'exited', code: null },
    ]);
    await expect(s.send('more')).rejects.toThrow(/closed/);
  });

  it('reports a crash mid-turn with the stderr tail', async () => {
    const { child, session: s } = session();
    s.begin('work');
    child.stderr.write('Error: invalid flag --bogus\n');
    child.exit(1);
    expect(await all(s)).toEqual([
      { type: 'error', message: 'Error: invalid flag --bogus', retryable: false },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'process_exited' },
      { type: 'exited', code: 1 },
    ]);
  });

  it('falls back to SIGINT when the interrupt request goes unanswered', async () => {
    const { child, session: s } = session();
    s.begin('work');
    child.send(init);
    child.onKill = (signal) => {
      if (signal === 'SIGINT') {
        child.send({ ...success, subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' });
      }
    };
    await until(s, (e) => e.type === 'session_started');
    await s.interrupt();
    expect(child.signals).toEqual(['SIGINT']);
    const events = await until(s, isTurnComplete);
    expect(events.at(-1)).toMatchObject({ isError: true, reason: 'interrupted' });
  });

  it('kills the process when neither interrupt nor SIGINT ends the turn', async () => {
    const { child, session: s } = session();
    s.begin('work');
    child.onKill = (signal) => {
      if (signal === 'SIGTERM') child.exit(null, signal);
    };
    await s.interrupt();
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    expect(await all(s)).toEqual([
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'interrupted' },
      { type: 'exited', code: null },
    ]);
  });

  it('does nothing on interrupt when idle', async () => {
    const { child, session: s } = session();
    await s.interrupt();
    expect(child.written).toEqual([]);
  });

  it('sends follow-ups as user messages, priority now included', async () => {
    const { child, session: s } = session();
    await s.send('steer', 'now');
    await s.send('later');
    await child.waitFor((m) => m.type === 'user', 1);
    expect(child.written).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'steer' },
        parent_tool_use_id: null,
        session_id: '',
        priority: 'now',
      },
      { type: 'user', message: { role: 'user', content: 'later' }, parent_tool_use_id: null, session_id: '' },
    ]);
  });

  it('answers allow-for-session with session-scoped permission updates', async () => {
    const { child, session: s } = session();
    s.begin('work');
    child.send({
      type: 'control_request',
      request_id: 'perm-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'make' },
        tool_use_id: 'tu1',
        title: 'Run make?',
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'make' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      },
    });
    const [request] = await until(s, (e) => e.type === 'approval_request');
    expect(request).toEqual({
      type: 'approval_request',
      requestId: 'perm-1',
      tool: 'Bash',
      input: { command: 'make' },
      reason: 'Run make?',
    });
    await s.respond('perm-1', { behavior: 'allow', scope: 'session', updatedInput: null });
    const { msg } = await child.waitFor((m) => m.type === 'control_response');
    expect(msg).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'perm-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'make' },
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'make' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
          toolUseID: 'tu1',
        },
      },
    });
  });

  it('drops approvals the CLI withdraws', async () => {
    const { child, session: s } = session();
    s.begin('work');
    child.send({
      type: 'control_request',
      request_id: 'p',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
    });
    await until(s, (e) => e.type === 'approval_request');
    child.send({ type: 'control_cancel_request', request_id: 'p' });
    child.send(success);
    await until(s, isTurnComplete);
    await expect(s.respond('p', { behavior: 'allow', scope: 'once', updatedInput: null })).rejects.toThrow();
  });

  it('declines control requests it does not support', async () => {
    const { child, session: s } = session();
    child.send({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } });
    child.send({ type: 'control_request', request_id: 'e1', request: { subtype: 'elicitation' } });
    const first = await child.waitFor((m) => m.type === 'control_response');
    const second = await child.waitFor((m) => m.type === 'control_response', first.index + 1);
    expect(first.msg).toEqual({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'h1', error: 'Legion does not handle hook_callback' },
    });
    expect(second.msg).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'e1', response: { action: 'decline' } },
    });
    await s.close();
  });

  it('coalesces text deltas', async () => {
    const { child, session: s } = session({ ...FAST, coalesceMs: 20 });
    s.begin('x');
    const delta = (text: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
    child.send(delta('a'));
    child.send(delta('b'));
    child.send(delta('c'));
    child.send({ type: 'assistant', message: { content: [{ type: 'text', text: 'abc' }] } });
    child.send(delta('d'));
    const events = await until(s, (e) => e.type === 'text_delta' && e.text === 'd');
    expect(events).toEqual([
      { type: 'text_delta', text: 'abc' },
      { type: 'message', text: 'abc' },
      { type: 'text_delta', text: 'd' },
    ]);
    await s.close();
  });

  it('closes when the abort signal fires', async () => {
    const controller = new AbortController();
    const { child, session: s } = session(FAST, { signal: controller.signal });
    child.onKill = (signal) => child.exit(null, signal);
    controller.abort();
    expect(await all(s)).toEqual([{ type: 'exited', code: null }]);
    expect(child.stdinEnded).toBe(true);
  });
});
