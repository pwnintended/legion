/**
 * Live tests against the real `codex` CLI (`pnpm test:live`, LEGION_LIVE=1). Low effort, tiny prompts,
 * temp dirs, a temp Legion CODEX_HOME (only auth.json is linked from the user's home).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { permissionProfileFor, type Role, type SessionOptions } from '@shared/engine';
import { ReviewOutputSchema, reviewOutputJsonSchema } from '@shared/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodexEngine } from './index';
import { collectEvents } from './test-utils';

const LIVE = process.env.LEGION_LIVE === '1';

let root: string;
let engine: CodexEngine;
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;

async function workdir(name: string): Promise<string> {
  const dir = await mkdtemp(join(root, `${name}-`));
  await writeFile(join(dir, 'README.md'), '# scratch\n');
  return dir;
}

function options(role: Role, cwd: string, prompt: string, extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    role,
    cwd,
    prompt,
    effort: 'low',
    systemPrompt: 'You are a Legion test agent. Keep every answer as short as possible.',
    permission: permissionProfileFor(role),
    mcp: null,
    env,
    ...extra,
  };
}

const messages = (events: { type: string; text?: string }[]) =>
  events.flatMap((e) => (e.type === 'message' && e.text ? [e.text] : [])).join('\n');

describe.skipIf(!LIVE)('codex adapter (live)', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'legion-codex-live-'));
    engine = new CodexEngine({ codexHome: join(root, 'codex-home'), env, clientVersion: 'live-test' });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('probe reports version, login and models', async () => {
    const info = await engine.probe();
    expect(info).toMatchObject({ kind: 'codex', installed: true, loggedIn: true, error: null });
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.models.length).toBeGreaterThan(0);
  });

  it('start → message → turn_complete (read-only)', async () => {
    const cwd = await workdir('plain');
    const session = await engine.start(options('planner', cwd, 'Reply with exactly the word: pong'));
    const stream = collectEvents(session);
    const started = await stream.next('session_started');
    expect(started.sessionId).toBe(session.id);
    expect(started.version).toMatch(/^\d+\.\d+/);
    const done = await stream.next('turn_complete');
    expect(done.isError).toBe(false);
    expect(messages(stream.events).toLowerCase()).toContain('pong');
    expect(stream.events.some((e) => e.type === 'usage')).toBe(true);
    await session.close();
    await stream.done;
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
  });

  it('structured output validates against the shared zod schema', async () => {
    const cwd = await workdir('structured');
    const session = await engine.start(
      options(
        'reviewer',
        cwd,
        'Review an empty change. There is one acceptance criterion, id "AC1": "The repository has a README". ' +
          'Check README.md exists, then approve with no findings and a one-sentence summary.',
        { outputSchema: reviewOutputJsonSchema },
      ),
    );
    const stream = collectEvents(session);
    const done = await stream.next('turn_complete');
    expect(done.isError).toBe(false);
    const review = ReviewOutputSchema.parse(done.structuredOutput);
    expect(review.verdict).toBe('approve');
    await session.close();
  });

  it('approval round-trip (workspace-write + on-request): decline, then the turn continues', async () => {
    const cwd = await workdir('approval');
    const session = await engine.start(
      options(
        'coder',
        cwd,
        'Run exactly this command and nothing else, requesting escalated permissions because it needs network ' +
          'access: `curl -sS -o /dev/null -w "%{http_code}" https://example.com`. If it is declined, reply "declined".',
      ),
    );
    const stream = collectEvents(session);
    const request = await stream.next('approval_request');
    expect(request.tool).toBe('shell');
    expect(JSON.stringify(request.input)).toContain('curl');
    await session.respond(request.requestId, { behavior: 'deny', message: 'no network', interrupt: false });
    const done = await stream.next('turn_complete');
    expect(done.isError).toBe(false);
    expect(stream.events.some((e) => e.type === 'tool_result' && !e.ok && e.output === 'declined')).toBe(true);
    expect(messages(stream.events).toLowerCase()).toContain('declined');
    await session.close();
  });

  it('deny with interrupt (cancel) stops the turn', async () => {
    const cwd = await workdir('cancel');
    const session = await engine.start(
      options(
        'coder',
        cwd,
        'Run exactly this command, requesting escalated permissions because it needs network access: ' +
          '`curl -sS -o /dev/null -w "%{http_code}" https://example.com`. Then reply with the status code.',
      ),
    );
    const stream = collectEvents(session);
    const request = await stream.next('approval_request');
    await session.respond(request.requestId, { behavior: 'deny', message: 'stop', interrupt: true });
    expect(await stream.next('turn_complete')).toMatchObject({ isError: true, reason: 'interrupted' });
    await session.close();
  });

  // file_change events come from apply_patch items only; files written by shell commands show up as
  // tool_call kind command (the orchestrator's own diff of the worktree is the source of truth).
  it('writes files in the worktree without asking and reports file changes', async () => {
    const cwd = await workdir('edit');
    const session = await engine.start(
      options(
        'coder',
        cwd,
        'Using your apply_patch file editing tool (not a shell command), create a file named hello.txt ' +
          'containing exactly the line "hi". Then reply "done".',
      ),
    );
    const stream = collectEvents(session);
    const done = await stream.next('turn_complete');
    expect(done.isError).toBe(false);
    expect(stream.events.some((e) => e.type === 'approval_request')).toBe(false);
    expect(await readFile(join(cwd, 'hello.txt'), 'utf8')).toContain('hi');
    expect(stream.events.some((e) => e.type === 'file_change' && e.path === 'hello.txt')).toBe(true);
    await session.close();
  });

  it('send steers the active turn, then starts a follow-up turn', async () => {
    const cwd = await workdir('steer');
    const session = await engine.start(
      options('coder', cwd, 'Run the shell command `sleep 6`, then reply with the word "first".'),
    );
    const stream = collectEvents(session);
    await stream.next('tool_call');
    await session.send('Change of plan: after the sleep, reply with the word "second" instead of "first".');
    await stream.next('turn_complete');
    expect(messages(stream.events).toLowerCase()).toContain('second');
    await session.send('Now reply with just the word "third".');
    const second = await stream.next('turn_complete');
    expect(second.isError).toBe(false);
    expect(messages(stream.events).toLowerCase()).toContain('third');
    await session.close();
  });

  it('interrupt stops the turn and keeps the session usable', async () => {
    const cwd = await workdir('interrupt');
    const session = await engine.start(options('coder', cwd, 'Run the shell command `sleep 30`, then reply "slept".'));
    const stream = collectEvents(session);
    await stream.next('tool_call');
    const before = Date.now();
    await session.interrupt();
    const interrupted = await stream.next('turn_complete');
    expect(interrupted).toMatchObject({ isError: true, reason: 'interrupted' });
    expect(Date.now() - before).toBeLessThan(20_000);
    await session.send('Reply with just the word "ok".');
    const next = await stream.next('turn_complete');
    expect(next.isError).toBe(false);
    await session.close();
  });

  it('resume carries the thread context into a new process', async () => {
    const cwd = await workdir('resume');
    const first = await engine.start(options('planner', cwd, 'Remember the word "zebra". Reply "ok".'));
    const firstStream = collectEvents(first);
    await firstStream.next('turn_complete');
    const threadId = first.id;
    await first.close();

    const resumed = await engine.resume(
      threadId,
      options('planner', cwd, 'What word did I ask you to remember? Reply with just that word.'),
    );
    const stream = collectEvents(resumed);
    expect((await stream.next('session_started')).sessionId).toBe(threadId);
    await stream.next('turn_complete');
    expect(messages(stream.events).toLowerCase()).toContain('zebra');
    await resumed.close();
  });

  it('calls a Legion MCP tool over streamable HTTP with a bearer token', async () => {
    const token = `tok-${Math.random().toString(36).slice(2)}`;
    const calls: string[] = [];
    let unauthorized = 0;
    const http: Server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        unauthorized += 1;
        res.writeHead(401).end();
        return;
      }
      const server = new McpServer({ name: 'legion', version: '0.0.1' });
      server.registerTool(
        'report_progress',
        { description: 'Report a one-line progress summary to Legion.', inputSchema: { summary: z.string() } },
        async ({ summary }) => {
          calls.push(summary);
          return { content: [{ type: 'text', text: '{"ok":true}' }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => void transport.close());
      await server.connect(transport);
      let body = '';
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
      const cwd = await workdir('mcp');
      const session = await engine.start(
        options(
          'coder',
          cwd,
          'Call the legion MCP tool report_progress with summary "hello from codex", then reply "reported".',
          { mcp: { url, token } },
        ),
      );
      const stream = collectEvents(session);
      const done = await stream.next('turn_complete');
      expect(done.isError).toBe(false);
      expect(calls).toEqual(['hello from codex']);
      expect(unauthorized).toBe(0);
      expect(stream.events.find((e) => e.type === 'tool_call')).toMatchObject({
        kind: 'mcp',
        name: 'mcp__legion__report_progress',
      });
      expect(stream.events.some((e) => e.type === 'approval_request')).toBe(false);
      await session.close();
    } finally {
      http.close();
    }
  });
});
