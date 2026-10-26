/**
 * The assistant's Legion tools, served over MCP (streamable HTTP on loopback, one bearer token per session):
 * list, read, eject and validate workflows; start, inspect, resume and cancel runs. Writing a workflow is done
 * with the assistant's own file tools; `validate_workflow` is the feedback loop after every write.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Logger } from '../util/log.ts';
import { builtinSourceDir, ejectWorkflow, findWorkflow, listWorkflowFiles, loadWorkflow } from '../workflow/loader.ts';
import type { RunManager } from '../workflow/manager.ts';
import { formatReport, validateWorkflow } from '../workflow/validate.ts';

export interface McpHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function guard<A>(log: Logger, fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return text(await fn(args));
    } catch (err) {
      log.warn('legion tool failed', err);
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  };
}

export async function describeWorkflows(repo: string) {
  return Promise.all(
    listWorkflowFiles(repo).map(async (w) => {
      try {
        const def = await loadWorkflow(w.file);
        return {
          name: w.name,
          source: w.source,
          file: w.file,
          description: def.description,
          overrides: w.shadows.map((s) => s.source),
        };
      } catch (err) {
        return {
          name: w.name,
          source: w.source,
          file: w.file,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

export function runSummary(runs: RunManager, runId: string) {
  const record = runs.run(runId);
  if (!record) throw new Error(`No run ${runId}`);
  const steps = runs
    .journal(runId)
    .all()
    .map((e) => ({
      key: e.key,
      kind: e.kind,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
      ...(typeof e.meta?.costUsd === 'number' ? { costUsd: e.meta.costUsd } : {}),
    }));
  const pending = runs
    .pendingInteractions()
    .filter((p) => p.interaction.runId === runId)
    .map((p) => p.interaction);
  return { ...record, active: runs.isActive(runId), steps, waitingForUser: pending };
}

function buildServer(repo: string, runs: RunManager, log: Logger): McpServer {
  const server = new McpServer({ name: 'legion', version: '0.1.0' });

  server.registerTool(
    'list_workflows',
    {
      description:
        'List the workflows available in this repository (project, user and builtin), with descriptions and file paths.',
      inputSchema: {},
    },
    guard(log, async () => describeWorkflows(repo)),
  );

  server.registerTool(
    'read_workflow',
    {
      description: 'Return the path and TypeScript source of a workflow by name.',
      inputSchema: { name: z.string() },
    },
    guard(log, async ({ name }: { name: string }) => {
      const found = findWorkflow(repo, name);
      if (!found) throw new Error(`No workflow named "${name}"`);
      // Builtins run compiled; show their TypeScript source.
      const file = found.source === 'builtin' ? join(builtinSourceDir(), `${found.name}.ts`) : found.file;
      return `// ${file} (${found.source})\n${readFileSync(file, 'utf8')}`;
    }),
  );

  server.registerTool(
    'eject_workflow',
    {
      description:
        'Copy a builtin or user workflow into this project (.legion/workflows/<name>.ts) so it can be edited; the project copy then overrides it. Returns the new path.',
      inputSchema: { name: z.string(), as: z.string().optional().describe('New name (default: the same name).') },
    },
    guard(log, async ({ name, as }: { name: string; as?: string }) => {
      const { path: target, from: found } = ejectWorkflow(repo, name, as);
      return {
        path: target,
        note: as && as !== found.name ? `Rename the workflow's \`name\` to "${as}" as well.` : undefined,
      };
    }),
  );

  server.registerTool(
    'validate_workflow',
    {
      description:
        'Type-check a workflow file against the SDK, load it, and dry-run it with fake agents (approved gates, simulated git and shell). Call this after every change to a workflow and fix everything it reports.',
      inputSchema: { name: z.string().describe('Workflow name or file path') },
    },
    guard(log, async ({ name }: { name: string }) => {
      const found = findWorkflow(repo, name);
      if (!found) throw new Error(`No workflow named "${name}"`);
      return formatReport(await validateWorkflow(found.file, { repo }));
    }),
  );

  server.registerTool(
    'run_workflow',
    {
      description:
        'Start a workflow run. It runs in the background; the user sees its progress live and answers its gates and questions in the Legion UI, not through you. You are told when it finishes. Returns the run id.',
      inputSchema: {
        name: z.string(),
        input: z.record(z.string(), z.unknown()).describe("The workflow's input object (see its input schema)."),
      },
    },
    guard(log, async ({ name, input }: { name: string; input: Record<string, unknown> }) => {
      const runId = await runs.start(name, input);
      return { runId, note: 'Running. Progress and gates are shown to the user directly.' };
    }),
  );

  server.registerTool(
    'list_runs',
    { description: 'List recent workflow runs in this repository, newest first.', inputSchema: {} },
    guard(log, async () =>
      runs
        .runs()
        .slice(0, 20)
        .map((r) => ({
          id: r.id,
          workflow: r.workflow,
          status: runs.isActive(r.id) ? r.status : r.status,
          startedAt: new Date(r.startedAt).toISOString(),
          error: r.error,
        })),
    ),
  );

  server.registerTool(
    'run_status',
    {
      description: "A run's record, its steps from the journal, and what it is waiting for the user to answer.",
      inputSchema: { runId: z.string() },
    },
    guard(log, async ({ runId }: { runId: string }) => runSummary(runs, runId)),
  );

  server.registerTool(
    'resume_run',
    {
      description:
        'Resume a run that stopped (failed, cancelled, or interrupted when Legion exited). Finished steps are replayed from its journal.',
      inputSchema: { runId: z.string() },
    },
    guard(log, async ({ runId }: { runId: string }) => ({ runId: await runs.resume(runId) })),
  );

  server.registerTool(
    'cancel_run',
    { description: 'Cancel an active run. It can be resumed later.', inputSchema: { runId: z.string() } },
    guard(log, async ({ runId }: { runId: string }) => ({ cancelled: runs.cancel(runId) })),
  );

  return server;
}

export async function startMcpServer(opts: { repo: string; runs: RunManager; log: Logger }): Promise<McpHandle> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return reply(res, 401, { error: 'unauthorized' });
    if ((req.url ?? '').split('?')[0] !== '/mcp') return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      return reply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (err as Error).message }, id: null });
    }
    // Stateless: a server and transport per request.
    const server = buildServer(opts.repo, opts.runs, opts.log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      opts.log.error('mcp request failed', err);
      reply(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    });
  });
  http.requestTimeout = 0;
  http.timeout = 0;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
