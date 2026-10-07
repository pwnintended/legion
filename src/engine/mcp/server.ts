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
import { type AgentMessage, MESSAGE_KINDS, type MessageKind, type Role, type TaskNode } from '../../shared/domain';
import { COORDINATOR_ROLES } from '../../shared/engine';
import { PlanOutputNodeSchema } from '../../shared/schemas';

export interface McpBinding {
  runId: string;
  /** null for run-level sessions (planner, finalizer). */
  taskId: string | null;
  attemptId: string;
  role: Role;
  /** The attempt this one reports to (null = top level): unlocks `ask_lead` and the messaging tools. */
  parentAttemptId: string | null;
}

/** An agent as `list_agents` describes it. */
export interface AgentPeer {
  attemptId: string;
  role: Role;
  /** Plan node the agent works on (coders, reviewers), null for run-level agents. */
  nodeId: string | null;
  status: string;
}

export interface SendMessageRequest {
  /** Attempt id of the recipient, or `lead` for the caller's current parent. */
  to: string;
  kind: MessageKind;
  body: string;
  replyTo: string | null;
}

/** The lead's board (`plan_status`). */
export interface PlanStatus {
  runStatus: string;
  paused: boolean;
  tasks: Array<{
    nodeId: string;
    title: string;
    status: string;
    dependsOn: string[];
    progress: string | null;
    error: string | null;
    summary: string | null;
    coderAttemptId: string | null;
  }>;
  /** A plan version waiting for the human's sign-off, if any. */
  pendingAmendment: { version: number; reason: string } | null;
}

/** Outcome of `add_task` / `amend_task` / `cancel_task`. */
export interface AmendmentResult {
  /** `applied`: in effect now. `pending`: waiting for the human (`reason` says why). */
  outcome: 'applied' | 'pending';
  planVersion: number;
  reason: string | null;
}

export type TaskNodePatch = Partial<Omit<TaskNode, 'id'>>;

/** `run_status` for the assistant. */
export interface AssistantRunStatus {
  runId: string;
  title: string;
  status: string;
  paused: boolean;
  plan: { version: number; approved: boolean } | null;
  tasks: Array<{ nodeId: string; title: string; status: string; summary: string | null; error: string | null }>;
  /** Open inbox items that wait for the human, one line each. */
  waitingForHuman: string[];
  prUrl: string | null;
  error: string | null;
}

export interface StartImplementationRequest {
  title: string;
  brief: string;
  /** Let the planner ask clarifying questions first (default true). */
  clarify: boolean;
}

export interface SpawnResearchRequest {
  title: string;
  brief: string;
  /** `single`: one researcher. `team`: a research lead that spawns researchers (not for a research lead itself). */
  mode: 'single' | 'team';
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
  /** The caller's parent and children in the agent hierarchy. */
  listAgents(binding: McpBinding):
    | { parent: AgentPeer | null; children: AgentPeer[] }
    | Promise<{
        parent: AgentPeer | null;
        children: AgentPeer[];
      }>;
  /** Queue a message to the caller's parent or child; throws when `to` is neither. */
  sendMessage(binding: McpBinding, request: SendMessageRequest): AgentMessage | Promise<AgentMessage>;
  /**
   * The next message addressed to the caller (a reply to `replyTo` when given), waiting up to `timeoutMs`
   * (null = no limit). Resolves null on timeout.
   */
  awaitMessage(
    binding: McpBinding,
    filter: { replyTo: string | null; timeoutMs: number | null },
  ): Promise<AgentMessage | null>;
  /** Lead tools (role `lead`): the board and plan amendments. */
  planStatus(binding: McpBinding): PlanStatus | Promise<PlanStatus>;
  addTask(binding: McpBinding, node: TaskNode): AmendmentResult | Promise<AmendmentResult>;
  amendTask(binding: McpBinding, nodeId: string, patch: TaskNodePatch): AmendmentResult | Promise<AmendmentResult>;
  cancelTask(binding: McpBinding, nodeId: string, reason: string): AmendmentResult | Promise<AmendmentResult>;
  /** Assistant tools (role `assistant`). */
  startImplementation(
    binding: McpBinding,
    request: StartImplementationRequest,
  ): { runId: string; status: string } | Promise<{ runId: string; status: string }>;
  runStatus(binding: McpBinding): AssistantRunStatus | Promise<AssistantRunStatus>;
  /** Open a research agent as the caller's child; its report arrives later as a `report` message. */
  spawnResearch(
    binding: McpBinding,
    request: SpawnResearchRequest,
  ): { attemptId: string; role: Role } | Promise<{ attemptId: string; role: Role }>;
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

/** Wraps a tool handler: its result becomes a text content block, a thrown error an `isError` reply. */
function makeGuard(binding: McpBinding, log: Log) {
  return <A>(name: string, fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return text(await fn(args));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('warn', `tool ${name} failed`, { runId: binding.runId, attemptId: binding.attemptId, message });
        return text(`Error: ${message}`, true);
      }
    };
}
type Guard = ReturnType<typeof makeGuard>;

function buildServer(binding: McpBinding, host: McpHost, log: Log): McpServer {
  const server = new McpServer({ name: 'legion', version: '1.0.0' });
  const guard = makeGuard(binding, log);

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

  // The planner sits under the assistant only to be steered: messages reach it in its prompt, it has no mailbox.
  if ((binding.parentAttemptId !== null && binding.role !== 'planner') || COORDINATOR_ROLES.has(binding.role))
    registerMessaging(server, binding, host, guard);
  if (binding.role === 'lead') registerLeadTools(server, binding, host, guard);
  if (COORDINATOR_ROLES.has(binding.role)) registerResearch(server, binding, host, guard);
  if (binding.role === 'assistant') registerAssistantTools(server, binding, host, guard);

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

const MAX_WAIT_SECONDS = 60 * 60 * 24;

const brief = (m: AgentMessage) => ({
  id: m.id,
  from: m.fromAttemptId,
  kind: m.kind,
  replyTo: m.replyTo,
  body: m.body,
});

/** Tools of an attempt that has a lead and/or agents of its own (`core/messaging.ts` for the rules). */
function registerMessaging(server: McpServer, binding: McpBinding, host: McpHost, guard: Guard): void {
  const hasLead = binding.parentAttemptId !== null;
  server.registerTool(
    'list_agents',
    {
      description:
        'The agents you can message: your lead (the agent you report to) and the agents working for you, with ' +
        'their attempt ids, roles, task node ids and status. You cannot reach anyone else directly.',
      inputSchema: {},
    },
    guard('list_agents', async () => host.listAgents(binding)),
  );
  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to your lead or to one of your agents (ids from list_agents). Kinds: brief = work you ' +
        'hand down (objective, output format, boundaries); question = something you need answered; answer = a ' +
        'reply (set reply_to to the question id); report = your final, condensed result for your lead; status = ' +
        'a short non-blocking note. Keep bodies short: the recipient gets the message, never your transcript. ' +
        'Does not block; use wait_for_reply to wait for an answer. Returns {"id": message id}.',
      inputSchema: {
        to: z.string().min(1).describe('Attempt id of the recipient (from list_agents).'),
        kind: z.enum(MESSAGE_KINDS).describe('brief | question | answer | report | status'),
        body: z.string().min(1).describe('Markdown body.'),
        reply_to: z.string().optional().describe('Id of the message this answers (required for kind answer).'),
      },
    },
    guard(
      'send_message',
      async ({ to, kind, body, reply_to }: { to: string; kind: MessageKind; body: string; reply_to?: string }) => {
        if (kind === 'answer' && !reply_to) throw new Error('an answer needs reply_to (the question id)');
        const message = await host.sendMessage(binding, { to, kind, body, replyTo: reply_to ?? null });
        return { id: message.id };
      },
    ),
  );
  server.registerTool(
    'wait_for_reply',
    {
      description:
        'Block until a message addressed to you arrives: with message_id, a reply to that message of yours; ' +
        'without it, the next message from any agent you can talk to. Returns the message ' +
        '({id, from, kind, replyTo, body}) or null when timeout_seconds passed without one.',
      inputSchema: {
        message_id: z.string().optional().describe('Wait for a reply to this message (one you sent).'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe('Give up after this long (default: wait indefinitely).'),
      },
    },
    guard(
      'wait_for_reply',
      async ({ message_id, timeout_seconds }: { message_id?: string; timeout_seconds?: number }) => {
        const message = await host.awaitMessage(binding, {
          replyTo: message_id ?? null,
          timeoutMs: timeout_seconds === undefined ? null : timeout_seconds * 1000,
        });
        return message ? brief(message) : null;
      },
    ),
  );
  if (!hasLead) return;
  server.registerTool(
    'ask_lead',
    {
      description:
        'Ask the agent you report to a question and wait for the answer. Use it when the task brief leaves ' +
        'something open that your lead decided or can decide (scope, interface choices, priorities); decide ' +
        'small things yourself and note them in your summary. Blocks until the answer arrives. ' +
        'Returns {"answer": string, "message_id": string}.',
      inputSchema: { question: z.string().min(1).describe('A specific, self-contained question.') },
    },
    guard('ask_lead', async ({ question }: { question: string }) => {
      const sent = await host.sendMessage(binding, { to: 'lead', kind: 'question', body: question, replyTo: null });
      const reply = await host.awaitMessage(binding, { replyTo: sent.id, timeoutMs: null });
      if (!reply) throw new Error('no answer arrived');
      return { answer: reply.body, message_id: reply.id };
    }),
  );
}

/** `spawn_research` for coordinators; a research lead may only spawn single researchers (bounded depth). */
function registerResearch(server: McpServer, binding: McpBinding, host: McpHost, guard: Guard): void {
  const teamAllowed = binding.role !== 'research_lead';
  server.registerTool(
    'spawn_research',
    {
      description:
        'Start a read-only research agent (repository and web) as one of your agents and return at once with its ' +
        'attempt id; its report arrives later as a message (kind report). Give it a precise title and a brief: ' +
        'what to find out, where to look first, the format you want back, what is out of scope. ' +
        (teamAllowed
          ? 'mode single (default) = one researcher for a focused question; team = a research lead that splits a broad ' +
            'brief over several researchers and synthesises. Start single; escalate to team only when a report shows ' +
            'the question is broad.'
          : 'As a research lead you spawn single researchers only.'),
      inputSchema: {
        title: z.string().min(1).max(120).describe('Short name of the question.'),
        brief: z.string().min(1).describe('The brief (markdown).'),
        ...(teamAllowed ? { mode: z.enum(['single', 'team']).optional().describe('single (default) | team') } : {}),
      },
    },
    guard(
      'spawn_research',
      async ({ title, brief, mode }: { title: string; brief: string; mode?: 'single' | 'team' }) =>
        host.spawnResearch(binding, { title, brief, mode: teamAllowed && mode === 'team' ? 'team' : 'single' }),
    ),
  );
}

/** The assistant's own tools: start the work, see where it stands. */
function registerAssistantTools(server: McpServer, binding: McpBinding, host: McpHost, guard: Guard): void {
  server.registerTool(
    'start_implementation',
    {
      description:
        'Turn this conversation into work: the brief becomes the issue a planner plans from (the human signs the ' +
        'plan off in the inbox; an implementation lead then coordinates the coders and reports to you). Write the ' +
        'brief like a good issue: what and why, scope, constraints, decisions the human made here. Once per ' +
        'conversation. Returns {runId, status}.',
      inputSchema: {
        title: z.string().min(1).max(120).describe('Short title of the work.'),
        brief: z.string().min(1).describe('The issue text (markdown).'),
        clarify: z
          .boolean()
          .optional()
          .describe('Let the planner ask the human clarifying questions first (default true).'),
      },
    },
    guard(
      'start_implementation',
      async ({ title, brief, clarify }: { title: string; brief: string; clarify?: boolean }) =>
        host.startImplementation(binding, { title, brief, clarify: clarify !== false }),
    ),
  );
  server.registerTool(
    'run_status',
    {
      description:
        'Where the work stands: run status, plan version and whether it is approved, every task with its status and ' +
        'latest summary, what waits for the human in the inbox, the pull request if any.',
      inputSchema: {},
    },
    guard('run_status', async () => host.runStatus(binding)),
  );
}

const NodePatchShape = PlanOutputNodeSchema.omit({ id: true }).partial();

/** The lead's own tools: the board and plan amendments (the host validates and applies them). */
function registerLeadTools(server: McpServer, binding: McpBinding, host: McpHost, guard: Guard): void {
  server.registerTool(
    'plan_status',
    {
      description:
        'The board: every task of the plan with its status, dependencies, progress line, error and latest ' +
        'report summary, plus the coder attempt id to message, and whether a plan change is waiting for the human.',
      inputSchema: {},
    },
    guard('plan_status', async () => host.planStatus(binding)),
  );
  server.registerTool(
    'add_task',
    {
      description:
        'Add a task to the plan (a new plan version). Use the next free id (T<n>). Give it a goal, narrow ' +
        'touches, 2-5 acceptance criteria, real verify commands and dependsOn for the tasks whose code it needs. ' +
        'Returns {outcome: "applied" | "pending", planVersion, reason}: pending means the human must sign the ' +
        "new version off first (high risk, or writes outside the approved plan's directories).",
      inputSchema: { node: PlanOutputNodeSchema.describe('The task node, same shape as the plan DAG nodes.') },
    },
    guard('add_task', async ({ node }: { node: TaskNode }) => host.addTask(binding, node)),
  );
  server.registerTool(
    'amend_task',
    {
      description:
        'Change a task that has not started yet (blocked or queued): any node fields except id. Same outcome ' +
        'rules as add_task. A running task cannot be amended; message its coder instead.',
      inputSchema: {
        node_id: z.string().min(1).describe('The task id, e.g. T3.'),
        patch: NodePatchShape.describe('Fields to replace.'),
      },
    },
    guard('amend_task', async ({ node_id, patch }: { node_id: string; patch: TaskNodePatch }) =>
      host.amendTask(binding, node_id, patch),
    ),
  );
  server.registerTool(
    'cancel_task',
    {
      description:
        'Drop a task that has not started yet (it is skipped; tasks depending on it may then start). ' +
        'Say why in reason.',
      inputSchema: { node_id: z.string().min(1), reason: z.string().min(1) },
    },
    guard('cancel_task', async ({ node_id, reason }: { node_id: string; reason: string }) =>
      host.cancelTask(binding, node_id, reason),
    ),
  );
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
