/**
 * Live tests against the user's real `claude` CLI (haiku, tiny prompts). Run with `pnpm test:live`.
 * Set `LEGION_RECORD_DIR=<dir>` to also record every transcript (raw material for `fixtures/`).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type AgentSession, permissionProfileFor, type Role, type SessionOptions } from '@shared/engine';
import type { AgentEvent, AgentEventOf } from '@shared/events';
import { AGENT_OUTPUT_JSON_SCHEMAS, ClarifyOutputSchema } from '@shared/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tempDir } from '../../test/helpers';
import { ClaudeEngine, type SpawnFn } from './index';
import { recordingSpawn } from './testing';

const LIVE = process.env.LEGION_LIVE === '1';
const RECORD_DIR = process.env.LEGION_RECORD_DIR ?? null;

const baseSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });

function engine(recordAs?: string): ClaudeEngine {
  let spawn = baseSpawn;
  if (RECORD_DIR && recordAs) {
    mkdirSync(RECORD_DIR, { recursive: true });
    let n = 0;
    spawn = (command, args, options) => {
      n += 1;
      return recordingSpawn(baseSpawn, join(RECORD_DIR, `${recordAs}${n > 1 ? `-${n}` : ''}.jsonl`))(
        command,
        args,
        options,
      );
    };
  }
  return new ClaudeEngine({ env: process.env as Record<string, string>, spawn });
}

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir('legion-claude-live-');
  writeFileSync(join(dir.path, 'hello.txt'), 'The secret word is PAPAYA.\n');
});
afterEach(() => dir.cleanup());

function options(role: Role, prompt: string, overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    role,
    cwd: dir.path,
    prompt,
    model: 'haiku',
    effort: 'low',
    permission: permissionProfileFor(role, []),
    mcp: null,
    env: process.env as Record<string, string>,
    ...overrides,
  };
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

const isTurnComplete = (event: AgentEvent) => event.type === 'turn_complete';
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);
const lastTurn = (events: AgentEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== 'turn_complete') throw new Error(`expected turn_complete, got ${JSON.stringify(last)}`);
  return last;
};
const text = (events: AgentEvent[]) =>
  of(events, 'message')
    .map((e) => e.text)
    .join('\n');

async function closeAndDrain(session: AgentSession): Promise<AgentEvent[]> {
  await session.close();
  return until(session, () => false);
}

describe.skipIf(!LIVE)('Claude adapter (live)', () => {
  it('probes the installed CLI', async () => {
    const info = await engine().probe();
    expect(info).toMatchObject({ kind: 'claude', installed: true, loggedIn: true, error: null });
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('starts, reads a file and completes the turn', async () => {
    const session = await engine('read').start(
      options('reviewer', 'Use the Read tool to read hello.txt, then reply with only the secret word.'),
    );
    const events = await until(session, isTurnComplete);
    const started = events[0];
    expect(started).toMatchObject({ type: 'session_started', sessionId: session.id });
    expect(started?.type === 'session_started' && started.model).toMatch(/haiku/);
    const read = of(events, 'tool_call').find((e) => e.name === 'Read');
    expect(read?.kind).toBe('read');
    expect(of(events, 'tool_result').find((e) => e.id === read?.id)?.ok).toBe(true);
    expect(of(events, 'text_delta').length).toBeGreaterThan(0);
    expect(text(events)).toContain('PAPAYA');
    expect(of(events, 'usage')[0]?.costUsd).toBeGreaterThan(0);
    expect(lastTurn(events)).toMatchObject({ isError: false, reason: null });
    const rest = await closeAndDrain(session);
    expect(rest.at(-1)?.type).toBe('exited');
  });

  it('returns structured output that validates with the shared zod schema', async () => {
    const session = await engine('structured').start(
      options(
        'planner',
        'Issue: "Add a --verbose flag to the CLI." Ask exactly one short clarifying question (id "q1", two options). Do not use any tools.',
        { outputSchema: AGENT_OUTPUT_JSON_SCHEMAS.clarify },
      ),
    );
    const events = await until(session, isTurnComplete);
    const done = lastTurn(events);
    expect(done.isError).toBe(false);
    const parsed = ClarifyOutputSchema.parse(done.structuredOutput);
    expect(parsed.questions.length).toBeGreaterThanOrEqual(1);
    expect(of(events, 'tool_call').some((e) => e.name === 'StructuredOutput')).toBe(false);
    await closeAndDrain(session);
  });

  it('edits without asking, round-trips an approval for a shell command, turn continues', async () => {
    // acceptEdits allows edits (and file-creating commands like `touch`) inside cwd; running code asks.
    const session = await engine('approval').start(
      options(
        'coder',
        `First use the Write tool to create notes.txt containing the single line: hello\nThen run exactly this shell command with the Bash tool: node -e "require('fs').writeFileSync('made-by-node.txt', 'x')"\nIf it is denied, do not retry; reply with exactly: DENIED`,
      ),
    );
    const before = await until(session, (e) => e.type === 'approval_request' || isTurnComplete(e));
    expect(of(before, 'tool_call').find((e) => e.name === 'Write')?.kind).toBe('edit');
    expect(of(before, 'file_change')).toContainEqual({ type: 'file_change', path: 'notes.txt', added: 1, removed: 0 });
    expect(existsSync(join(dir.path, 'notes.txt'))).toBe(true);
    const request = before.at(-1);
    if (request?.type !== 'approval_request') throw new Error(`expected approval_request, got ${request?.type}`);
    expect(request.tool).toBe('Bash');
    expect(JSON.stringify(request.input)).toContain('made-by-node.txt');
    await session.respond(request.requestId, { behavior: 'deny', message: 'Not allowed by Legion.', interrupt: false });
    const after = await until(session, isTurnComplete);
    expect(of(after, 'tool_result').some((e) => !e.ok)).toBe(true);
    expect(lastTurn(after).isError).toBe(false);
    expect(text(after)).toContain('DENIED');
    expect(existsSync(join(dir.path, 'made-by-node.txt'))).toBe(false);
    await closeAndDrain(session);
  });

  it('lets a planner chain version probes with reads and denies writes, without any approval_request', async () => {
    // `dontAsk` denied the whole chain on `npm -v` (not on the CLI's read-only set); the host policy answers instead.
    const session = await engine('planner-shell').start(
      options(
        'planner',
        `Run these with the Bash tool, one call each, in this order, never retrying a denied one:\n1) ls -a; node -v; npm -v; which node\n2) touch made-by-planner.txt\nThen reply with exactly: DONE`,
      ),
    );
    const events = await until(session, isTurnComplete);
    const bash = of(events, 'tool_call').filter((e) => e.name === 'Bash');
    const results = bash.map((call) => of(events, 'tool_result').find((r) => r.id === call.id)?.ok);
    expect(results).toEqual([true, false]);
    expect(of(events, 'approval_request')).toEqual([]);
    expect(existsSync(join(dir.path, 'made-by-planner.txt'))).toBe(false);
    expect(lastTurn(events)).toMatchObject({ isError: false });
    await closeAndDrain(session);
  });

  it('interrupts a turn and keeps the session usable', async () => {
    const session = await engine('interrupt').start(
      options('reviewer', 'Count from 1 to 300, one number per line, no other text.'),
    );
    await until(session, (e) => e.type === 'text_delta');
    await session.interrupt();
    const interrupted = await until(session, isTurnComplete);
    expect(lastTurn(interrupted)).toMatchObject({ isError: true, reason: 'interrupted' });
    await session.send('Reply with exactly: still here');
    const next = await until(session, isTurnComplete);
    expect(lastTurn(next).isError).toBe(false);
    expect(text(next).toLowerCase()).toContain('still here');
    await closeAndDrain(session);
  });

  it('resumes a session with its context', async () => {
    const claude = engine('resume');
    const first = await claude.start(options('planner', 'Remember the codeword ZEBRA-17. Reply with just: OK'));
    const firstEvents = await until(first, isTurnComplete);
    expect(lastTurn(firstEvents).isError).toBe(false);
    const firstCost = of(firstEvents, 'usage').at(-1)?.costUsd ?? 0;
    const id = first.id;
    await closeAndDrain(first);

    const resumed = await claude.resume(id, options('planner', 'What was the codeword? Reply with just the codeword.'));
    const events = await until(resumed, isTurnComplete);
    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: id });
    expect(resumed.id).toBe(id);
    expect(text(events)).toContain('ZEBRA-17');
    // Cost on a resumed session is cumulative (includes the first process's spend).
    expect(of(events, 'usage').at(-1)?.costUsd ?? 0).toBeGreaterThan(firstCost);
    await closeAndDrain(resumed);
  });

  it('calls a tool on a local MCP HTTP server with the bearer token', async () => {
    const token = `tok-${Math.random().toString(36).slice(2)}`;
    const seenAuth: (string | undefined)[] = [];
    const server = await startMcpServer(token, seenAuth);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      const session = await engine('mcp').start(
        options('reviewer', 'Call the mcp__legion__echo tool with text "hi" and reply with exactly what it returned.', {
          mcp: { url, token },
        }),
      );
      const events = await until(session, isTurnComplete);
      const call = of(events, 'tool_call').find((e) => e.name === 'mcp__legion__echo');
      expect(call?.kind).toBe('mcp');
      expect(of(events, 'tool_result').find((e) => e.id === call?.id)?.output).toContain('ECHO:hi');
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((auth) => auth === `Bearer ${token}`)).toBe(true);
      await closeAndDrain(session);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/** Stateless streamable-HTTP MCP server with one `echo` tool; rejects requests without the bearer token. */
async function startMcpServer(token: string, seenAuth: (string | undefined)[]): Promise<Server> {
  const http = createServer(async (req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const mcp = new McpServer({ name: 'legion-test', version: '0.0.0' });
    mcp.registerTool(
      'echo',
      { description: 'Echoes text back, prefixed.', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text: `ECHO:${text}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return http;
}
