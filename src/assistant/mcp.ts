/**
 * Legion's tools, served over MCP (streamable HTTP on loopback) to the orchestrator and every lead, each with its
 * own bearer token, so a tool knows who calls it: list, read, eject and validate workflows; start, inspect, resume
 * and cancel runs; spawn, message, stop and answer leads; report and keep a plan. Writing a workflow is done with
 * the agent's own file tools; `validate_workflow` is the feedback loop after every write.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { listRoles } from '../team/roles.ts';
import { PLAN_STATUSES, type PresentedItem, REPORT_KINDS, ROOT, type TeamManager } from '../team/team.ts';
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
  return {
    ...record,
    active: runs.isActive(runId),
    steps,
    runningAgents: runs.liveAgents(runId),
    waitingForAnswer: pending,
  };
}

/** Remote mode's box image, for the orchestrator's `box_status` and `provision_box`. */
export interface BoxTools {
  status(): Record<string, unknown>;
  /** Starts the box agent with these requests (and the ones waiting); an active box run is returned instead. */
  provision(requests: string[], verify: string[]): Promise<{ runId: string; started: boolean; requests: string[] }>;
}

interface Caller {
  repo: string;
  runs: RunManager;
  team: TeamManager;
  boxes: BoxTools | null;
  /** `orchestrator` or a lead's name. */
  name: string;
  log: Logger;
}

function buildServer(ctx: Caller): McpServer {
  const { repo, runs, team, log, boxes } = ctx;
  const isRoot = ctx.name === ROOT;
  /** Leads see and touch only their own runs. */
  const ownRun = (runId: string) => {
    if (!runs.run(runId)) throw new Error(`No run ${runId}`);
    if (!isRoot && team.ownerOf(runId) !== ctx.name) throw new Error(`Run ${runId} is not one of yours`);
  };
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

  if (isRoot && boxes) {
    server.registerTool(
      'box_status',
      {
        description:
          "Remote mode's box image (what every Upstash Box starts from): whether remote mode is on, the current image and what it was made for, the requests agents made with legion-need that no box agent has taken yet, and a box agent run in progress.",
        inputSchema: {},
      },
      guard(log, async () => boxes.status()),
    );

    server.registerTool(
      'provision_box',
      {
        description:
          'Have the box agent add tools or dependencies to the box image: it updates .legion/box/provision.sh (and env.sh), runs it in a box, warms the build, and the box becomes the new image. Boxes already running get the change before their next step. Requests agents made that are still waiting are included. Runs as the `box` workflow (you are told when it finishes). Use it to make the first image too (no requests: the toolchain the repository needs). Returns the run id; when a box agent is already running, returns that one: call again once it has finished.',
        inputSchema: {
          requests: z
            .array(z.string())
            .default([])
            .describe('What to add, as precisely as you can (versions when they matter).'),
          verify: z
            .array(z.string())
            .default([])
            .describe('Commands that must pass in the box afterwards (e.g. the build or a quick test).'),
        },
      },
      guard(log, async ({ requests, verify }: { requests: string[]; verify: string[] }) =>
        boxes.provision(requests, verify),
      ),
    );
  }

  server.registerTool(
    'run_workflow',
    {
      description: isRoot
        ? 'Start a workflow run. It runs in the background; the user sees its progress live and answers its gates and questions in the Legion UI, not through you. You are told when it finishes. Returns the run id.'
        : 'Start a workflow run. It runs in the background; its gates and questions come to you as messages (answer them with answer_interaction), and you are told when it finishes. Returns the run id.',
      inputSchema: {
        name: z.string(),
        input: z.record(z.string(), z.unknown()).describe("The workflow's input object (see its input schema)."),
      },
    },
    guard(log, async ({ name, input }: { name: string; input: Record<string, unknown> }) => {
      team.checkRun(ctx.name, name);
      const runId = await runs.start(name, input, isRoot ? {} : { owner: ctx.name, ...team.runPlace(ctx.name) });
      const place = team.runPlace(ctx.name);
      const uncommitted = await team.uncommitted(ctx.name);
      return {
        runId,
        ...(place.base ? { startsFrom: place.base, worksIn: place.cwd } : {}),
        note: isRoot
          ? 'Running. Progress and gates are shown to the user directly.'
          : 'Running. Its gates and questions will come to you.',
        ...(uncommitted.length
          ? {
              warning: `${uncommitted.length} uncommitted file(s) in ${team.checkoutOf(ctx.name)} are not in this run's worktrees, which start from the last commit: ${uncommitted.slice(0, 20).join(', ')}${uncommitted.length > 20 ? ', …' : ''}. If its agents need them, cancel the run, commit them, and start it again.`,
            }
          : {}),
      };
    }),
  );

  server.registerTool(
    'list_runs',
    {
      description: isRoot
        ? "List recent workflow runs in this repository (yours and your leads'), newest first."
        : 'List your recent workflow runs, newest first.',
      inputSchema: {},
    },
    guard(log, async () =>
      runs
        .runs()
        .filter((r) => isRoot || r.owner === ctx.name)
        .slice(0, 20)
        .map((r) => ({
          id: r.id,
          workflow: r.workflow,
          status: r.status,
          owner: r.owner ?? ROOT,
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
    guard(log, async ({ runId }: { runId: string }) => {
      ownRun(runId);
      return runSummary(runs, runId);
    }),
  );

  server.registerTool(
    'resume_run',
    {
      description:
        'Resume a run that stopped (failed, cancelled, or interrupted when Legion exited). Finished steps are replayed from its journal.',
      inputSchema: { runId: z.string() },
    },
    guard(log, async ({ runId }: { runId: string }) => {
      ownRun(runId);
      return { runId: await runs.resume(runId) };
    }),
  );

  server.registerTool(
    'retry_run',
    {
      description:
        'Steer a run by trying again: stops it if it is running, then resumes it with `notes` for the next agent attempt (by default the step that failed, or `step`). With `rewind: true` and a `step`, that finished step and every step after it run again (files and branches stay as they are) — e.g. redo a coder or a critique with new instructions. Finished steps before it replay from the journal.',
      inputSchema: {
        runId: z.string(),
        notes: z.string().optional().describe('What the agent should do differently.'),
        step: z.string().optional().describe('Full step key, e.g. "T2/code" (see run_status).'),
        rewind: z.boolean().optional(),
      },
    },
    guard(log, async (args: { runId: string; notes?: string; step?: string; rewind?: boolean }) => {
      ownRun(args.runId);
      if (runs.isActive(args.runId)) {
        const done = runs.wait(args.runId);
        runs.cancel(args.runId);
        await done;
      }
      let step = args.step ?? null;
      if (!step && args.notes) {
        // The agent step that failed last, if there is one; else the notes go to whichever agent runs first.
        const failed = runs
          .journal(args.runId)
          .all()
          .filter((e) => e.kind === 'agent' && e.status !== 'done')
          .at(-1);
        step = failed?.key ?? null;
      }
      await runs.resume(args.runId, { notes: args.notes ?? null, step, rewind: args.rewind ?? false });
      return { runId: args.runId, notesFor: args.notes ? (step ?? 'the next agent step') : null };
    }),
  );

  server.registerTool(
    'message_agent',
    {
      description:
        'Send a message to an agent while it works in one of your runs (run_status lists its runningAgents): a correction, a hint, a constraint. It takes it into its current turn. Use retry_run instead when the step should start over.',
      inputSchema: { runId: z.string(), step: z.string().describe('Full step key, e.g. "T1/code".'), text: z.string() },
    },
    guard(log, async ({ runId, step, text: body }: { runId: string; step: string; text: string }) => {
      ownRun(runId);
      await runs.messageAgent(runId, step, body);
      return { sent: true };
    }),
  );

  server.registerTool(
    'cancel_run',
    { description: 'Cancel an active run. It can be resumed later.', inputSchema: { runId: z.string() } },
    guard(log, async ({ runId }: { runId: string }) => {
      ownRun(runId);
      return { cancelled: runs.cancel(runId) };
    }),
  );

  registerTeamTools(server, ctx);
  return server;
}

const IMAGE_FILE = /^\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;

function registerTeamTools(server: McpServer, ctx: Caller): void {
  const { repo, team, log } = ctx;
  const isRoot = ctx.name === ROOT;
  const summary = (name: string) => {
    const l = team.get(name);
    if (!l) throw new Error(`No lead called ${name}`);
    const plan = l.plan;
    return {
      name: l.name,
      role: l.role,
      status: team.busy(name) ? 'working' : l.status,
      brief: l.brief.length > 300 ? `${l.brief.slice(0, 300)}…` : l.brief,
      lastReport: l.lastReport,
      plan: plan
        ? {
            summary: plan.summary,
            items: plan.items.map((i) => `[${i.status}] ${i.title}${i.owner ? ` (${i.owner})` : ''}`),
          }
        : null,
      activeRuns: team.activeRuns(name).map((r) => ({ id: r.id, workflow: r.workflow, status: r.status })),
      waitingForItsAnswer: team.pending(name).length,
      ...(l.workspace ? { worktree: l.workspace.path, branch: l.workspace.branch, base: l.workspace.base } : {}),
      leads: team.children(name).map((c) => c.name),
      costUsd: Math.round(l.costUsd * 100) / 100,
    };
  };
  const inSubtree = (name: string) => isRoot || team.subtree(ctx.name).some((l) => l.name === name);

  server.registerTool(
    'list_roles',
    {
      description:
        'The roles a lead can have (what each is for, its engine, tier and model, which workflows it may run and which roles it may spawn).',
      inputSchema: {},
    },
    guard(log, async () => {
      const { roles, errors } = listRoles(repo);
      const mine = isRoot ? null : team.role(ctx.name);
      return {
        roles: roles.map((r) => ({
          name: r.name,
          description: r.description,
          source: r.source,
          engine: r.engine,
          tier: r.tier,
          model: r.model,
          workflows: r.workflows,
          spawns: r.spawns,
          ...(mine && mine.spawns !== '*' && !mine.spawns.includes(r.name) ? { youMaySpawn: false } : {}),
        })),
        ...(errors.length ? { errors } : {}),
      };
    }),
  );

  server.registerTool(
    'spawn_lead',
    {
      description:
        'Start a team lead: a long-lived agent with its own context that owns one area of work (e.g. "fauna assets" or "networking"). It plans, runs workflows, answers its own runs\' gates, may spawn sub-leads, and reports back to you. You hear from it only through its reports, so give it a complete brief: the goal, scope and constraints, what done looks like, where things are, and when to check back with you.',
      inputSchema: {
        role: z.string().describe('A role name from list_roles.'),
        name: z.string().describe('A short unique name, lowercase with dashes, e.g. "fauna" or "assets-lead".'),
        brief: z.string().describe('Everything the lead needs to start; it knows nothing else about the project.'),
      },
    },
    guard(log, async (args: { role: string; name: string; brief: string }) => {
      const lead = team.spawn(ctx.name, args);
      return { name: lead.name, role: lead.role, note: 'Started. Its reports come to you as messages.' };
    }),
  );

  server.registerTool(
    'list_leads',
    {
      description: 'Your leads: status, last report, plan, active runs. `all` includes their sub-leads too.',
      inputSchema: { all: z.boolean().optional() },
    },
    guard(log, async ({ all }: { all?: boolean }) =>
      (all ? team.subtree(ctx.name) : team.children(ctx.name)).map((l) => ({
        ...summary(l.name),
        parent: l.parent,
      })),
    ),
  );

  server.registerTool(
    'lead_status',
    {
      description: "One lead's full brief, plan and last report, and what it is running (yours or below).",
      inputSchema: { name: z.string() },
    },
    guard(log, async ({ name }: { name: string }) => {
      if (!inSubtree(name)) throw new Error(`${name} is not under you`);
      const l = team.get(name);
      return { ...summary(name), brief: l?.brief, plan: l?.plan, parent: l?.parent };
    }),
  );

  server.registerTool(
    'message_lead',
    {
      description:
        'Send one of your leads a message: an answer to its question, a decision, a change of direction, feedback. It gets it at the end of its current turn.',
      inputSchema: { name: z.string(), text: z.string() },
    },
    guard(log, async ({ name, text: body }: { name: string; text: string }) => {
      team.message(ctx.name, name, body);
      return { queued: true };
    }),
  );

  if (isRoot) {
    server.registerTool(
      'present',
      {
        description:
          "Show the user something to look at: screenshots, renders, concept art, a web page, a document. Images appear inline in their terminal when it can draw them; every item also gets a link they can click to open it. Use it when you bring the user a lead's review, or whenever seeing beats describing. Then say in your reply what to look at and what you want to know.",
        inputSchema: {
          title: z.string().describe('One line: what this is, e.g. "Body B blockout: front, side, back".'),
          items: z
            .array(
              z.object({
                target: z.string().describe('A file path (absolute, or relative to the repository) or an http(s) URL.'),
                caption: z.string().optional().describe('What this one shows.'),
              }),
            )
            .min(1)
            .max(12),
        },
      },
      guard(log, async ({ title, items }: { title: string; items: { target: string; caption?: string }[] }) => {
        const presented = items.map((i): PresentedItem => {
          const caption = i.caption ?? null;
          if (/^https?:\/\//i.test(i.target)) return { kind: 'url', target: i.target, caption };
          const path = isAbsolute(i.target) ? i.target : resolve(repo, i.target);
          if (!existsSync(path)) throw new Error(`No such file: ${path}`);
          return { kind: IMAGE_FILE.test(extname(path)) ? 'image' : 'file', target: path, caption };
        });
        team.present({ title, items: presented });
        return {
          shown: presented.map((p) => `${p.kind}: ${p.target}`),
          note: 'Shown to the user (inline where their terminal draws images, as links otherwise).',
        };
      }),
    );
  }

  server.registerTool(
    'merge_lead',
    {
      description: isRoot
        ? "Merge one of your leads' branch (its committed work, plus anything it left uncommitted) into the branch checked out in the user's checkout, so the user sees it there. Do it when the lead reports done, or when the user wants its work. Fails on a conflict; then ask the lead to merge that branch into its own and resolve it."
        : "Merge one of your leads' branch (its committed work, plus anything it left uncommitted) into your branch. Do it when the lead reports done. Fails on a conflict; then ask the lead to merge your branch into its own and resolve it.",
      inputSchema: {
        name: z.string(),
        message: z.string().optional().describe('The merge commit message.'),
      },
    },
    guard(log, async ({ name, message }: { name: string; message?: string }) =>
      team.mergeLead(ctx.name, name, message),
    ),
  );

  server.registerTool(
    'stop_lead',
    {
      description: 'Stop one of your leads, its sub-leads and their runs (when its work is done or no longer wanted).',
      inputSchema: { name: z.string() },
    },
    guard(log, async ({ name }: { name: string }) => {
      await team.stop(ctx.name, name);
      return { stopped: name };
    }),
  );

  if (!isRoot) {
    server.registerTool(
      'report',
      {
        description: `Report to your parent (${team.get(ctx.name)?.parent ?? ROOT}). Kinds: progress (a milestone), done (your brief is complete; summarize the outcome), blocked (you cannot go on without them), question (you need a decision), review (something to show that needs a human's opinion: list the files, images or URLs to look at), coordinate (you need something from another team). Keep it short and self-contained; your parent does not see your conversation.`,
        inputSchema: {
          kind: z.enum(REPORT_KINDS),
          summary: z.string(),
          files: z.array(z.string()).optional().describe('Paths or URLs your parent should look at.'),
        },
      },
      guard(log, async (args: { kind: (typeof REPORT_KINDS)[number]; summary: string; files?: string[] }) => {
        team.report(ctx.name, args.kind, args.summary, args.files);
        return { sent: true };
      }),
    );
  }

  server.registerTool(
    'update_plan',
    {
      description:
        'Replace your plan: the steps of your work, who does each (you, a lead, a workflow run) and their status. The user sees it live; keep it current as things finish or change.',
      inputSchema: {
        summary: z.string().optional().describe('One or two lines: the approach.'),
        items: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(PLAN_STATUSES),
            owner: z.string().optional().describe('A lead name, a run id, or "me".'),
            note: z.string().optional(),
          }),
        ),
      },
    },
    guard(log, async (plan: { summary?: string; items: Parameters<TeamManager['updatePlan']>[1]['items'] }) => {
      const saved = team.updatePlan(ctx.name, plan);
      return { items: saved.items.length };
    }),
  );
  server.registerTool(
    'pending_interactions',
    {
      description: 'Gates and questions from your runs that wait for your answer.',
      inputSchema: {},
    },
    guard(log, async () => team.pending(ctx.name).map((p) => ({ id: p.id, ...p.interaction }))),
  );

  server.registerTool(
    'answer_interaction',
    {
      description: `Answer a gate (choice approve | changes | abort, with a note for changes), a question (answer), an agent's own questions (answers: option labels or text by question id; null declines), or a tool approval (allow true | false) from one of your runs.${isRoot ? ' Only when the user asked you to, or [team] gates = "decide" in the config; otherwise the user answers in the UI.' : ''}`,
      inputSchema: {
        id: z.string(),
        choice: z.enum(['approve', 'changes', 'abort']).optional(),
        note: z.string().optional(),
        answer: z.string().optional(),
        allow: z.boolean().optional(),
        answers: z.record(z.string(), z.array(z.string())).nullable().optional(),
      },
    },
    guard(
      log,
      async (args: {
        id: string;
        choice?: 'approve' | 'changes' | 'abort';
        note?: string;
        answer?: string;
        allow?: boolean;
        answers?: Record<string, string[]> | null;
      }) => ({ answered: team.answer(ctx.name, args.id, args) }),
    ),
  );
}

export async function startMcpServer(opts: {
  repo: string;
  runs: RunManager;
  team: TeamManager;
  boxes?: BoxTools | null;
  log: Logger;
}): Promise<McpHandle> {
  const token = opts.team.rootToken;
  /** The caller a token belongs to, compared in constant time per known token. */
  const callerOf = (header: string): string | null => {
    const got = Buffer.from(header);
    for (const [t, name] of opts.team.tokens()) {
      const expected = Buffer.from(`Bearer ${t}`);
      if (got.length === expected.length && timingSafeEqual(got, expected)) return name;
    }
    return null;
  };

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
    const caller = callerOf(req.headers.authorization ?? '');
    if (!caller) return reply(res, 401, { error: 'unauthorized' });
    if ((req.url ?? '').split('?')[0] !== '/mcp') return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      return reply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (err as Error).message }, id: null });
    }
    // Stateless: a server and transport per request.
    const server = buildServer({
      repo: opts.repo,
      runs: opts.runs,
      team: opts.team,
      boxes: opts.boxes ?? null,
      name: caller,
      log: opts.log,
    });
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
