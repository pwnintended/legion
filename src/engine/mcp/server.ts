/**
 * Legion MCP server (architecture §7). Streamable HTTP on 127.0.0.1, stateless (a fresh McpServer +
 * transport per POST, so clients that drop `Mcp-Session-Id` work), SSE responses with keep-alive so a tool
 * call can block for hours. Every request needs `Authorization: Bearer <token>`; the token resolves to a
 * `McpBinding` that tool handlers receive.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Role } from '../../shared/domain';

export interface McpBinding {
  runId: string;
  /** null for run-level sessions (planner, finalizer). */
  taskId: string | null;
  attemptId: string;
  role: Role;
}

export type ApproveResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** Implemented by the lifecycle service. Thrown errors become MCP tool errors. */
export interface McpHost {
  onProgress(binding: McpBinding, summary: string): void | Promise<void>;
  /** Resolves when a human answers (may take hours). */
  askHuman(binding: McpBinding, question: string, options?: string[]): Promise<string>;
  approve(
    binding: McpBinding,
    req: { toolName: string; input: Record<string, unknown>; toolUseId?: string },
  ): Promise<ApproveResult>;
  markDone(binding: McpBinding, done: { summary: string; commitMessage: string }): void | Promise<void>;
}

export interface McpServerOptions {
  host: McpHost;
  /** TCP port; default 0 = random free port. */
  port?: number;
  /** Interface to bind; must be loopback (127.0.0.1 default, `::1`/`localhost` accepted). Others throw. */
  bindAddress?: string;
  /** SSE keep-alive comment interval; default 15s. */
  keepAliveMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface McpServerHandle {
  /** e.g. http://127.0.0.1:43123/mcp */
  url: string;
  port: number;
  issueToken(binding: McpBinding): string;
  /** Revokes the token and drops its in-flight requests. */
  revokeToken(token: string): void;
  close(): Promise<void>;
}

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const WRITE_ROLES: ReadonlySet<Role> = new Set<Role>(['coder', 'resolver']);
const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const isLoopback = (a: string | undefined): boolean =>
  a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost';

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

type Log = NonNullable<McpServerOptions['log']>;

function buildServer(binding: McpBinding, host: McpHost, log: Log): McpServer {
  const server = new McpServer({ name: 'legion', version: '1.0.0' });
  const guard =
    <A>(name: string, fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return text(await fn(args));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('warn', `tool ${name} failed`, { runId: binding.runId, attemptId: binding.attemptId, message });
        return text(`Error: ${message}`, true);
      }
    };

  server.registerTool(
    'report_progress',
    {
      description:
        'Report a one-line status update on what you are doing right now (shown on your task card). ' +
        'Call it at meaningful milestones; keep it under ~120 characters. Does not block.',
      inputSchema: { summary: z.string().min(1).describe('One-line progress summary.') },
    },
    guard('report_progress', async ({ summary }: { summary: string }) => {
      await host.onProgress(binding, summary);
      return { ok: true };
    }),
  );

  server.registerTool(
    'request_human_input',
    {
      description:
        'Ask the human operator a question when you are blocked or a decision is genuinely theirs to make ' +
        '(ambiguous requirements, missing credentials, a choice between product trade-offs). Blocks until they ' +
        'answer, which can take a long time; do not use it for things you can decide or look up yourself. ' +
        'Returns {"answer": string}.',
      inputSchema: {
        question: z.string().min(1).describe('A specific, self-contained question.'),
        options: z.array(z.string()).optional().describe('Optional suggested answers the human can pick from.'),
      },
    },
    guard(
      'request_human_input',
      async ({ question, options }: { question: string; options?: string[] | undefined }) => ({
        answer: await host.askHuman(binding, question, options),
      }),
    ),
  );

  server.registerTool(
    'approve',
    {
      description:
        'Permission prompt tool used by Claude Code (--permission-prompt-tool). Asks the human whether a tool ' +
        'call may run. Returns {"behavior":"allow","updatedInput":...} or {"behavior":"deny","message":...}.',
      inputSchema: {
        tool_name: z.string().describe('Name of the tool requesting permission.'),
        input: z.record(z.string(), z.unknown()).describe('The tool input being approved.'),
        tool_use_id: z.string().optional().describe('The tool_use id, if known.'),
      },
    },
    guard(
      'approve',
      async ({
        tool_name,
        input,
        tool_use_id,
      }: {
        tool_name: string;
        input: Record<string, unknown>;
        tool_use_id?: string | undefined;
      }) => {
        const r = await host.approve(binding, {
          toolName: tool_name,
          input,
          ...(tool_use_id !== undefined ? { toolUseId: tool_use_id } : {}),
        });
        // Claude requires updatedInput on allow; echo the original input when the host gave none.
        return r.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: r.updatedInput ?? input }
          : { behavior: 'deny', message: r.message };
      },
    ),
  );

  if (WRITE_ROLES.has(binding.role)) {
    server.registerTool(
      'mark_task_done',
      {
        description:
          'Signal that your assigned task is complete and verified. Call it exactly once, as your final action, ' +
          'after your work is finished and the verify commands pass. Legion commits your changes using ' +
          'commit_message.',
        inputSchema: {
          summary: z.string().min(1).describe('What you did and anything the reviewer should know.'),
          commit_message: z.string().min(1).describe('Commit message for your changes (imperative subject line).'),
        },
      },
      guard('mark_task_done', async ({ summary, commit_message }: { summary: string; commit_message: string }) => {
        await host.markDone(binding, { summary, commitMessage: commit_message });
        return { ok: true };
      }),
    );
  }
  return server;
}

export async function startMcpServer(opts: McpServerOptions): Promise<McpServerHandle> {
  const bind = opts.bindAddress ?? '127.0.0.1';
  if (!LOOPBACK_BIND.has(bind)) throw new Error(`MCP server may only bind to loopback, refusing "${bind}"`);
  const log: Log = opts.log ?? (() => {});
  const keepAliveMs = opts.keepAliveMs ?? 15_000;

  /** sha256(token) hex → entry */
  const tokens = new Map<string, { hash: Buffer; binding: McpBinding; open: Set<ServerResponse> }>();

  const lookup = (req: IncomingMessage) => {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '');
    if (!m?.[1]) return null;
    const hash = sha256(m[1]);
    const entry = tokens.get(hash.toString('hex'));
    return entry && timingSafeEqual(entry.hash, hash) ? entry : null;
  };

  const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.destroy();
      return;
    }
    const entry = lookup(req);
    if (!entry) return reply(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if ((req.url ?? '').split('?')[0] !== MCP_PATH) return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream and no sessions to delete.
      return reply(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      return reply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (err as Error).message }, id: null });
    }
    entry.open.add(res);
    const server = buildServer(entry.binding, opts.host, log);
    const transport = new StreamableHTTPServerTransport({ keepAliveMs });
    res.on('close', () => {
      entry.open.delete(res);
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log('error', 'mcp request failed', { message: err instanceof Error ? err.message : String(err) });
      reply(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    });
  });
  // Tool calls can block for hours: never time out sockets or requests.
  httpServer.requestTimeout = 0;
  httpServer.timeout = 0;
  httpServer.keepAliveTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, bind === 'localhost' ? '127.0.0.1' : bind, resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  const hostPart = bind === '::1' ? '[::1]' : bind === 'localhost' ? '127.0.0.1' : bind;
  log('info', 'mcp server listening', { port });

  return {
    url: `http://${hostPart}:${port}${MCP_PATH}`,
    port,
    issueToken(binding) {
      const token = randomBytes(32).toString('base64url');
      const hash = sha256(token);
      tokens.set(hash.toString('hex'), { hash, binding: { ...binding }, open: new Set() });
      return token;
    },
    revokeToken(token) {
      const key = sha256(token).toString('hex');
      const entry = tokens.get(key);
      tokens.delete(key);
      for (const res of entry?.open ?? []) res.destroy();
    },
    close() {
      for (const e of tokens.values()) for (const res of e.open) res.destroy();
      tokens.clear();
      return new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
