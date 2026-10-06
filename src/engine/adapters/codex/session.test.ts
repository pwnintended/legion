/**
 * Session lifecycle against a fake app-server that replays recorded transcripts
 * (`fixtures/replay-app-server.mjs`): handshake, events, approvals, steer, interrupt, resume, unknown
 * server requests, crashes. No real codex involved.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionProfileFor, type SessionOptions } from '@shared/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureName, fixturePath, REPLAY_SERVER } from './fixtures';
import { CodexSession, type OpenMode } from './session';
import { collectEvents } from './test-utils';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'legion-codex-session-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function options(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    role: 'coder',
    cwd: dir,
    prompt: 'go',
    permission: permissionProfileFor('coder'),
    mcp: null,
    env: { PATH: process.env.PATH ?? '' },
    ...overrides,
  };
}

async function open(transcript: string, overrides: Partial<SessionOptions> = {}, mode: OpenMode = { kind: 'start' }) {
  const session = await CodexSession.open(options(overrides), mode, {
    command: process.execPath,
    args: [REPLAY_SERVER, transcript],
    codexHome: join(dir, 'home'),
    clientVersion: 'test',
  });
  return { session, stream: collectEvents(session) };
}

async function synthetic(name: string, entries: unknown[]): Promise<string> {
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return path;
}

const handshake = (threadId = 't1') => [
  { dir: 'out', msg: { id: 1, method: 'initialize' } },
  { dir: 'in', msg: { id: 1, result: { userAgent: 'legion/0.160.0 (test)', codexHome: '/h' } } },
  { dir: 'out', msg: { method: 'initialized' } },
  { dir: 'out', msg: { id: 2, method: 'thread/start' } },
  { dir: 'in', msg: { id: 2, result: { thread: { id: threadId }, model: 'gpt-test' } } },
  { dir: 'out', msg: { id: 3, method: 'turn/start' } },
  { dir: 'in', msg: { id: 3, result: { turn: { id: 'u1', status: 'inProgress' } } } },
  { dir: 'in', msg: { method: 'turn/started', params: { threadId, turn: { id: 'u1' } } } },
];
const completed = (threadId = 't1', turnId = 'u1') => ({
  dir: 'in',
  msg: { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null } } },
});

const fixture = (name: FixtureName) => fixturePath(name);

describe('CodexSession (replayed transcripts)', () => {
  it('plain turn: session_started → text → turn_complete, clean exit on close', async () => {
    const { session, stream } = await open(fixture('plain'), {
      role: 'reviewer',
      permission: permissionProfileFor('reviewer'),
    });
    const started = await stream.next('session_started');
    expect(started).toEqual({
      type: 'session_started',
      sessionId: '01a1132d-7551-7e62-b1c3-0e2317654640',
      model: 'gpt-6.1-sol',
      version: '0.160.0',
    });
    expect(session.id).toBe(started.sessionId);
    expect(await stream.next('turn_complete')).toMatchObject({ isError: false });
    await session.close();
    await stream.done;
    expect(stream.events.map((e) => e.type)).toEqual([
      'session_started',
      'text_delta',
      'message',
      'usage',
      'rate_limit',
      'turn_complete',
      'exited',
    ]);
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
    await expect(session.send('more')).rejects.toThrow('session is closed');
    await session.close(); // idempotent
  });

  it('approval round-trip: decline continues the turn', async () => {
    const { session, stream } = await open(fixture('approval'));
    const request = await stream.next('approval_request');
    expect(request).toMatchObject({ requestId: '0', tool: 'shell' });
    await expect(session.respond('nope', { behavior: 'deny', message: 'x', interrupt: false })).rejects.toThrow();
    await session.respond(request.requestId, { behavior: 'deny', message: 'not now', interrupt: false });
    expect(await stream.next('message')).toBeTruthy();
    expect(await stream.next('turn_complete')).toMatchObject({ isError: false });
    await session.close();
    await stream.done;
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 }); // replayer exits 3 on a wrong decision
  });

  it('structured output', async () => {
    const { session, stream } = await open(fixture('structured'), { outputSchema: { type: 'object' } });
    expect(await stream.next('turn_complete')).toEqual({
      type: 'turn_complete',
      structuredOutput: { sum: 5, greeting: 'Hello' },
      isError: false,
      reason: null,
    });
    await session.close();
  });

  it('interrupt stops the running command and keeps the session', async () => {
    const { session, stream } = await open(fixture('interrupt'));
    await stream.next('tool_call');
    await session.interrupt();
    expect(await stream.next('turn_complete')).toEqual({
      type: 'turn_complete',
      structuredOutput: null,
      isError: true,
      reason: 'interrupted',
    });
    expect(stream.events.some((e) => e.type === 'exited')).toBe(false);
    await session.close();
    await stream.done;
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
  });

  it('send steers the active turn, then starts a new turn when idle', async () => {
    const { session, stream } = await open(fixture('steer'));
    await stream.next('tool_call');
    await session.send('Change of plan');
    await stream.next('turn_complete');
    await session.send('Reply third');
    await stream.next('turn_complete');
    await session.close();
    await stream.done;
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
    const messages = stream.events.flatMap((e) => (e.type === 'message' ? [e.text] : []));
    expect(messages).toContain('third');
  });

  it('resume uses thread/resume', async () => {
    const { session, stream } = await open(
      fixture('resume'),
      {},
      {
        kind: 'resume',
        threadId: '01a1132d-b94c-74e0-a7e7-15620c683c88',
      },
    );
    expect(await stream.next('session_started')).toMatchObject({ sessionId: '01a1132d-b94c-74e0-a7e7-15620c683c88' });
    expect(await stream.next('message')).toEqual({ type: 'message', text: 'zebra' });
    await stream.next('turn_complete');
    await session.close();
  });
});

describe('CodexSession (synthetic transcripts)', () => {
  it('answers unknown server requests with an error and currentTime/read with the time', async () => {
    const path = await synthetic('unknown', [
      ...handshake(),
      { dir: 'in', msg: { id: 'srv-1', method: 'item/tool/call', params: { threadId: 't1', tool: 'x' } } },
      { dir: 'out', msg: { id: 'srv-1', error: { code: -32601, message: 'unsupported' } } },
      { dir: 'in', msg: { id: 'srv-2', method: 'account/chatgptAuthTokens/refresh', params: {} } },
      { dir: 'out', msg: { id: 'srv-2', error: { code: -32601, message: 'unsupported' } } },
      { dir: 'in', msg: { id: 'srv-3', method: 'currentTime/read', params: { threadId: 't1' } } },
      { dir: 'out', msg: { id: 'srv-3', result: { currentTimeAt: 0 } } },
      completed(),
    ]);
    const { session, stream } = await open(path);
    await stream.next('turn_complete');
    await session.close();
    await stream.done;
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
  });

  it('auto-accepts pre-approved commands without asking', async () => {
    const path = await synthetic('preapproved', [
      ...handshake(),
      {
        dir: 'in',
        msg: {
          id: 9,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 't1',
            turnId: 'u1',
            itemId: 'c1',
            command: "/bin/zsh -lc 'pnpm test'",
            commandActions: [{ type: 'unknown', command: 'pnpm test' }],
          },
        },
      },
      { dir: 'out', msg: { id: 9, result: { decision: 'accept' } } },
      completed(),
    ]);
    const { session, stream } = await open(path, { permission: permissionProfileFor('coder', ['pnpm test']) });
    await stream.next('turn_complete');
    await session.close();
    await stream.done;
    expect(stream.events.some((e) => e.type === 'approval_request')).toBe(false);
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
  });

  it('ignores notifications from other (sub-agent) threads', async () => {
    const path = await synthetic('subthread', [
      ...handshake(),
      completed('sub-thread', 'sub-turn'),
      {
        dir: 'in',
        msg: {
          method: 'item/agentMessage/delta',
          params: { threadId: 'sub-thread', turnId: 'x', itemId: 'm', delta: 'no' },
        },
      },
      completed(),
    ]);
    const { session, stream } = await open(path);
    await stream.next('turn_complete');
    await session.close();
    await stream.done;
    expect(stream.events.filter((e) => e.type === 'turn_complete')).toHaveLength(1);
    expect(stream.events.some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('a crash mid-turn ends the turn and the stream', async () => {
    const path = await synthetic('crash', [
      ...handshake(),
      {
        dir: 'in',
        msg: {
          method: 'item/started',
          params: {
            threadId: 't1',
            turnId: 'u1',
            item: { type: 'commandExecution', id: 'c1', command: 'sleep 1', cwd: dir, commandActions: [] },
          },
        },
      },
      { dir: 'exit', code: 7 },
    ]);
    const { stream } = await open(path);
    await stream.done;
    expect(stream.events.map((e) => e.type)).toEqual([
      'session_started',
      'tool_call',
      'error',
      'tool_result',
      'turn_complete',
      'exited',
    ]);
    expect(stream.events.at(-2)).toEqual({
      type: 'turn_complete',
      structuredOutput: null,
      isError: true,
      reason: 'exited',
    });
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 7 });
  });

  it('coalesces text deltas', async () => {
    const delta = (text: string) => ({
      dir: 'in',
      msg: { method: 'item/agentMessage/delta', params: { threadId: 't1', turnId: 'u1', itemId: 'm', delta: text } },
    });
    const path = await synthetic('deltas', [...handshake(), delta('a'), delta('b'), delta('c'), completed()]);
    const { session, stream } = await open(path);
    await stream.next('turn_complete');
    await session.close();
    expect(stream.events.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'abc' }]);
  });

  it('rejects open() when the handshake fails and kills the process', async () => {
    const path = await synthetic('resume-fails', [
      { dir: 'out', msg: { id: 1, method: 'initialize' } },
      { dir: 'in', msg: { id: 1, result: { userAgent: 'legion/0.160.0' } } },
      { dir: 'out', msg: { method: 'initialized' } },
      { dir: 'out', msg: { id: 2, method: 'thread/resume' } },
      { dir: 'in', msg: { id: 2, error: { code: -32600, message: 'no rollout found for thread id x' } } },
    ]);
    await expect(open(path, {}, { kind: 'resume', threadId: 'x' })).rejects.toThrow(/no rollout found/);
  });

  it('rejects open() when the binary cannot be spawned', async () => {
    await expect(
      CodexSession.open(
        options(),
        { kind: 'start' },
        {
          command: join(dir, 'missing-codex'),
          args: [],
          codexHome: dir,
          clientVersion: 'test',
        },
      ),
    ).rejects.toThrow(/failed to start/);
  });

  it('closes when the abort signal fires', async () => {
    const path = await synthetic('abort', [...handshake(), completed()]);
    const controller = new AbortController();
    const { stream } = await open(path, { signal: controller.signal });
    await stream.next('turn_complete');
    controller.abort();
    await stream.done;
    expect(stream.events.at(-1)?.type).toBe('exited');
  });
});
