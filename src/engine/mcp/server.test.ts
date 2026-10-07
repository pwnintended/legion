import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../shared/domain';
import { claudeMcpConfig, codexMcpConfigOverrides } from './config';
import { type McpBinding, type McpHost, type McpServerHandle, type SendMessageRequest, startMcpServer } from './server';

interface Calls {
  progress: Array<[McpBinding, string]>;
  ask: Array<[McpBinding, string, string[] | undefined]>;
  approve: Array<[McpBinding, string, Record<string, unknown>, string | undefined]>;
  done: Array<[McpBinding, string, string]>;
  sent: Array<[McpBinding, SendMessageRequest]>;
  waits: Array<[McpBinding, string | null, number | null]>;
  amend: Array<[string, string]>;
  research: Array<[string, string, string]>;
  start: Array<[string, boolean]>;
}

function fakeHost() {
  const calls: Calls = {
    progress: [],
    ask: [],
    approve: [],
    done: [],
    sent: [],
    waits: [],
    amend: [],
    research: [],
    start: [],
  };
  const pendingAsks: Array<(a: string) => void> = [];
  const pendingWaits: Array<(m: AgentMessage | null) => void> = [];
  let messageSeq = 0;
  const host: McpHost = {
    onProgress: (b, s) => {
      calls.progress.push([b, s]);
    },
    askHuman: (b, q, o) => {
      calls.ask.push([b, q, o]);
      if (q === 'boom') return Promise.reject(new Error('host exploded'));
      return new Promise<string>((resolve) => pendingAsks.push(resolve));
    },
    approve: async (b, r) => {
      calls.approve.push([b, r.toolName, r.input, r.toolUseId]);
      return r.toolName === 'Bash'
        ? { behavior: 'deny', message: 'nope' }
        : { behavior: 'allow', updatedInput: { ...r.input, extra: 1 } };
    },
    markDone: (b, d) => {
      calls.done.push([b, d.summary, d.commitMessage]);
    },
    listAgents: (b) => ({
      parent: b.parentAttemptId
        ? { attemptId: b.parentAttemptId, role: 'planner', nodeId: null, status: 'running' }
        : null,
      children: [],
    }),
    sendMessage: (b, r) => {
      calls.sent.push([b, r]);
      if (r.to === 'nobody') throw new Error('nobody is not your lead');
      messageSeq += 1;
      return {
        id: `m${messageSeq}`,
        runId: b.runId,
        fromAttemptId: b.attemptId,
        toAttemptId: r.to,
        kind: r.kind,
        body: r.body,
        replyTo: r.replyTo,
        createdAt: 1,
        deliveredAt: null,
      };
    },
    awaitMessage: (b, f) => {
      calls.waits.push([b, f.replyTo, f.timeoutMs]);
      return new Promise<AgentMessage | null>((resolve) => pendingWaits.push(resolve));
    },
    planStatus: () => ({ runStatus: 'executing', paused: false, tasks: [], pendingAmendment: null }),
    addTask: (_b, node) => {
      calls.amend.push(['add', node.id]);
      return { outcome: 'applied', planVersion: 2, reason: null };
    },
    amendTask: (_b, nodeId, patch) => {
      calls.amend.push(['amend', `${nodeId}:${Object.keys(patch).join(',')}`]);
      return { outcome: 'pending', planVersion: 3, reason: 'high risk' };
    },
    cancelTask: (_b, nodeId) => {
      calls.amend.push(['cancel', nodeId]);
      return { outcome: 'applied', planVersion: 3, reason: null };
    },
    spawnResearch: (b, r) => {
      calls.research.push([b.role, r.title, r.mode]);
      return { attemptId: 'att_r1', role: r.mode === 'team' ? 'research_lead' : 'researcher' };
    },
    startImplementation: (b, r) => {
      calls.start.push([r.title, r.clarify]);
      return { runId: b.runId, status: r.clarify ? 'clarifying' : 'planning' };
    },
    runStatus: (b) => ({
      runId: b.runId,
      title: 'T',
      status: 'chatting',
      paused: false,
      plan: null,
      tasks: [],
      waitingForHuman: [],
      prUrl: null,
      error: null,
    }),
  };
  return { host, calls, pendingAsks, pendingWaits };
}

const coder = (taskId = 't1', attemptId = 'a1'): McpBinding => ({
  runId: 'r1',
  taskId,
  attemptId,
  role: 'coder',
  parentAttemptId: null,
});
const reviewer: McpBinding = { runId: 'r1', taskId: 't1', attemptId: 'a2', role: 'reviewer', parentAttemptId: null };
/** A coder opened under a lead: gets the messaging tools. */
const ledCoder: McpBinding = { ...coder('t1', 'a3'), parentAttemptId: 'lead1' };
const reply = (id: string, to: string, replyTo: string | null, body: string): AgentMessage => ({
  id,
  runId: 'r1',
  fromAttemptId: 'lead1',
  toAttemptId: to,
  kind: replyTo ? 'answer' : 'brief',
  body,
  replyTo,
  createdAt: 2,
  deliveredAt: 2,
});

describe('legion mcp server', () => {
  let srv: McpServerHandle;
  let f: ReturnType<typeof fakeHost>;
  const clients: Client[] = [];

  const connect = async (token: string) => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(srv.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: r.isError === true, text: r.content[0]?.text ?? '' };
  };

  beforeEach(async () => {
    f = fakeHost();
    srv = await startMcpServer({ host: f.host });
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    await srv.close();
  });

  it('listens on loopback with a random port', () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(srv.port).toBeGreaterThan(0);
  });

  it('refuses non-loopback binding', async () => {
    for (const bindAddress of ['0.0.0.0', '192.168.1.5', '::']) {
      await expect(startMcpServer({ host: f.host, bindAddress })).rejects.toThrow(/loopback/);
    }
  });

  it('lists tools per role', async () => {
    const names = async (b: McpBinding) =>
      (await (await connect(srv.issueToken(b))).listTools()).tools.map((t) => t.name).sort();
    const writeTools = ['approve', 'mark_task_done', 'report_progress', 'request_human_input'];
    expect(await names(coder())).toEqual(writeTools);
    expect(await names({ ...coder(), role: 'resolver' })).toEqual(writeTools);
    for (const role of ['planner', 'reviewer', 'finalizer'] as const) {
      expect(await names({ ...reviewer, role })).toEqual(['approve', 'report_progress', 'request_human_input']);
    }
  });

  describe('messaging tools', () => {
    const messagingTools = ['list_agents', 'send_message', 'wait_for_reply'];

    it('appear only for attempts with a parent (plus ask_lead)', async () => {
      const names = async (b: McpBinding) =>
        (await (await connect(srv.issueToken(b))).listTools()).tools.map((t) => t.name).sort();
      expect(await names(ledCoder)).toEqual(
        ['approve', 'ask_lead', 'mark_task_done', 'report_progress', 'request_human_input', ...messagingTools].sort(),
      );
      expect(await names({ ...reviewer, parentAttemptId: 'lead1' })).toEqual(
        ['approve', 'ask_lead', 'report_progress', 'request_human_input', ...messagingTools].sort(),
      );
      expect(await names(coder())).not.toContain('send_message');
    });

    it('list_agents and send_message reach the host; answers need reply_to', async () => {
      const c = await connect(srv.issueToken(ledCoder));
      expect(JSON.parse((await call(c, 'list_agents', {})).text)).toEqual({
        parent: { attemptId: 'lead1', role: 'planner', nodeId: null, status: 'running' },
        children: [],
      });
      const sent = await call(c, 'send_message', { to: 'lead1', kind: 'status', body: 'halfway' });
      expect(JSON.parse(sent.text)).toEqual({ id: 'm1' });
      expect(f.calls.sent).toEqual([[ledCoder, { to: 'lead1', kind: 'status', body: 'halfway', replyTo: null }]]);
      const bad = await call(c, 'send_message', { to: 'lead1', kind: 'answer', body: 'yes' });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('reply_to');
      const refused = await call(c, 'send_message', { to: 'nobody', kind: 'status', body: 'hi' });
      expect(refused).toEqual({ isError: true, text: 'Error: nobody is not your lead' });
    });

    it('wait_for_reply blocks until the host hands over a message, or returns null', async () => {
      const c = await connect(srv.issueToken(ledCoder));
      const pending = call(c, 'wait_for_reply', { message_id: 'm7', timeout_seconds: 30 });
      await vi_waitFor(() => f.calls.waits.length === 1);
      expect(f.calls.waits[0]?.slice(1)).toEqual(['m7', 30_000]);
      f.pendingWaits[0]?.(reply('m8', 'a3', 'm7', 'use sqlite'));
      expect(JSON.parse((await pending).text)).toEqual({
        id: 'm8',
        from: 'lead1',
        kind: 'answer',
        replyTo: 'm7',
        body: 'use sqlite',
      });
      const timedOut = call(c, 'wait_for_reply', {});
      await vi_waitFor(() => f.calls.waits.length === 2);
      expect(f.calls.waits[1]?.slice(1)).toEqual([null, null]);
      f.pendingWaits[1]?.(null);
      expect((await timedOut).text).toBe('null');
    });

    it('ask_lead sends a question to the current lead and waits for its answer', async () => {
      const c = await connect(srv.issueToken(ledCoder));
      const pending = call(c, 'ask_lead', { question: 'Which db?' });
      await vi_waitFor(() => f.calls.waits.length === 1);
      expect(f.calls.sent).toEqual([[ledCoder, { to: 'lead', kind: 'question', body: 'Which db?', replyTo: null }]]);
      expect(f.calls.waits[0]?.slice(1)).toEqual(['m1', null]);
      f.pendingWaits[0]?.(reply('m2', 'a3', 'm1', 'sqlite'));
      expect(JSON.parse((await pending).text)).toEqual({ answer: 'sqlite', message_id: 'm2' });
    });
  });

  describe('lead tools', () => {
    const lead: McpBinding = { runId: 'r1', taskId: null, attemptId: 'lead1', role: 'lead', parentAttemptId: null };
    const nodeInput = {
      id: 'T9',
      title: 'Docs',
      goal: 'Write the docs.',
      kind: 'docs',
      dependsOn: ['T1'],
      acceptanceCriteria: [{ id: 'AC1', text: 'docs exist' }],
      touches: [{ glob: 'docs/x.md', mode: 'create' }],
      size: 'S',
      verify: { commands: ['test -f docs/x.md'] },
      contextHints: { files: [], notes: '' },
      agent: { engine: 'claude', model: null, effort: null },
      risk: 'low',
    };

    it('exist for the lead only, with the messaging and research tools and without ask_lead', async () => {
      const names = (await (await connect(srv.issueToken(lead))).listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'add_task',
          'amend_task',
          'approve',
          'cancel_task',
          'list_agents',
          'plan_status',
          'report_progress',
          'request_human_input',
          'send_message',
          'spawn_research',
          'wait_for_reply',
        ].sort(),
      );
      const coderNames = (await (await connect(srv.issueToken(ledCoder))).listTools()).tools.map((t) => t.name);
      expect(coderNames).not.toContain('add_task');
    });

    it('validate the node shape and reach the host', async () => {
      const c = await connect(srv.issueToken(lead));
      expect(JSON.parse((await call(c, 'plan_status', {})).text)).toMatchObject({ runStatus: 'executing' });
      expect(JSON.parse((await call(c, 'add_task', { node: nodeInput })).text)).toEqual({
        outcome: 'applied',
        planVersion: 2,
        reason: null,
      });
      const bad = await call(c, 'add_task', { node: { ...nodeInput, kind: 'nope' } }).catch((e: Error) => ({
        isError: true,
        text: e.message,
      }));
      expect(bad.isError).toBe(true);
      expect(
        JSON.parse((await call(c, 'amend_task', { node_id: 'T2', patch: { title: 'New', risk: 'high' } })).text),
      ).toEqual({ outcome: 'pending', planVersion: 3, reason: 'high risk' });
      expect(JSON.parse((await call(c, 'cancel_task', { node_id: 'T3', reason: 'duplicate' })).text)).toMatchObject({
        outcome: 'applied',
      });
      expect(f.calls.amend).toEqual([
        ['add', 'T9'],
        ['amend', 'T2:title,risk'],
        ['cancel', 'T3'],
      ]);
    });
  });

  describe('assistant tools', () => {
    const assistant: McpBinding = {
      runId: 'r1',
      taskId: null,
      attemptId: 'as1',
      role: 'assistant',
      parentAttemptId: null,
    };

    it('start the work and read its status; the assistant also gets the coordinator tools', async () => {
      const c = await connect(srv.issueToken(assistant));
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'approve',
          'list_agents',
          'report_progress',
          'request_human_input',
          'run_status',
          'send_message',
          'spawn_research',
          'start_implementation',
          'wait_for_reply',
        ].sort(),
      );
      expect(
        JSON.parse((await call(c, 'start_implementation', { title: 'CSV export', brief: 'Add it.' })).text),
      ).toEqual({
        runId: 'r1',
        status: 'clarifying',
      });
      await call(c, 'start_implementation', { title: 'Again', brief: 'x', clarify: false });
      expect(f.calls.start).toEqual([
        ['CSV export', true],
        ['Again', false],
      ]);
      expect(JSON.parse((await call(c, 'run_status', {})).text)).toMatchObject({ status: 'chatting', tasks: [] });
    });
  });

  describe('spawn_research', () => {
    const lead: McpBinding = { runId: 'r1', taskId: null, attemptId: 'lead1', role: 'lead', parentAttemptId: null };
    const researchLead: McpBinding = { ...lead, attemptId: 'rl1', role: 'research_lead', parentAttemptId: 'lead1' };

    it('lets a lead spawn single or team research, and a research lead single only', async () => {
      const c = await connect(srv.issueToken(lead));
      expect(JSON.parse((await call(c, 'spawn_research', { title: 'Auth', brief: 'How is auth done?' })).text)).toEqual(
        {
          attemptId: 'att_r1',
          role: 'researcher',
        },
      );
      expect(
        JSON.parse((await call(c, 'spawn_research', { title: 'All', brief: 'Everything.', mode: 'team' })).text),
      ).toEqual({
        attemptId: 'att_r1',
        role: 'research_lead',
      });
      const rl = await connect(srv.issueToken(researchLead));
      const tool = (await rl.listTools()).tools.find((t) => t.name === 'spawn_research');
      expect(tool?.description).toContain('single researchers only');
      const properties = (tool?.inputSchema as { properties?: object } | undefined)?.properties ?? {};
      expect(Object.keys(properties)).toEqual(['title', 'brief']);
      await call(rl, 'spawn_research', { title: 'Sub', brief: 'Part.', mode: 'team' });
      expect(f.calls.research).toEqual([
        ['lead', 'Auth', 'single'],
        ['lead', 'All', 'team'],
        ['research_lead', 'Sub', 'single'],
      ]);
      expect((await (await connect(srv.issueToken(coder()))).listTools()).tools.map((t) => t.name)).not.toContain(
        'spawn_research',
      );
    });
  });

  it('exposes input schemas', async () => {
    const c = await connect(srv.issueToken(coder()));
    const tool = (await c.listTools()).tools.find((t) => t.name === 'mark_task_done');
    expect(tool?.inputSchema.required).toEqual(['summary', 'commit_message']);
    expect(tool?.description).toBeTruthy();
  });

  it('report_progress and mark_task_done reach the host with the binding', async () => {
    const b = coder();
    const c = await connect(srv.issueToken(b));
    expect(await call(c, 'report_progress', { summary: 'working' })).toEqual({ isError: false, text: '{"ok":true}' });
    expect(await call(c, 'mark_task_done', { summary: 'done', commit_message: 'Add x' })).toEqual({
      isError: false,
      text: '{"ok":true}',
    });
    expect(f.calls.progress).toEqual([[b, 'working']]);
    expect(f.calls.done).toEqual([[b, 'done', 'Add x']]);
  });

  it('rejects invalid arguments as tool errors', async () => {
    const c = await connect(srv.issueToken(coder()));
    const r = await call(c, 'report_progress', {}).catch((e: Error) => ({ isError: true, text: e.message }));
    expect(r.isError).toBe(true);
  });

  it('mark_task_done is not callable by read-only roles', async () => {
    const c = await connect(srv.issueToken(reviewer));
    const r = await call(c, 'mark_task_done', { summary: 's', commit_message: 'm' }).catch((e: Error) => ({
      isError: true,
      text: e.message,
    }));
    expect(r.isError).toBe(true);
    expect(f.calls.done).toEqual([]);
  });

  it('approve returns the exact JSON Claude expects', async () => {
    const c = await connect(srv.issueToken(coder()));
    const allow = await call(c, 'approve', { tool_name: 'Edit', input: { file: 'a' }, tool_use_id: 'tu1' });
    expect(JSON.parse(allow.text)).toEqual({ behavior: 'allow', updatedInput: { file: 'a', extra: 1 } });
    const deny = await call(c, 'approve', { tool_name: 'Bash', input: { command: 'rm -rf /' } });
    expect(JSON.parse(deny.text)).toEqual({ behavior: 'deny', message: 'nope' });
    expect(f.calls.approve[0]?.[3]).toBe('tu1');
    expect(f.calls.approve[1]?.[3]).toBeUndefined();
  });

  it('approve echoes the input when the host gives no updatedInput', async () => {
    const { host } = fakeHost();
    host.approve = async () => ({ behavior: 'allow' });
    const s2 = await startMcpServer({ host });
    try {
      const client = new Client({ name: 't', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(s2.url), {
          requestInit: { headers: { Authorization: `Bearer ${s2.issueToken(coder())}` } },
        }),
      );
      const r = await call(client, 'approve', { tool_name: 'Edit', input: { a: 1 } });
      expect(JSON.parse(r.text)).toEqual({ behavior: 'allow', updatedInput: { a: 1 } });
      await client.close();
    } finally {
      await s2.close();
    }
  });

  it('host errors become tool errors and the server keeps working', async () => {
    const c = await connect(srv.issueToken(coder()));
    const r = await call(c, 'request_human_input', { question: 'boom' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('host exploded');
    expect(await call(c, 'report_progress', { summary: 'still alive' })).toMatchObject({ isError: false });
  });

  it('request_human_input blocks until resolved later, and others keep working meanwhile', async () => {
    const c = await connect(srv.issueToken(coder()));
    const c2 = await connect(srv.issueToken(coder('t2', 'a9')));
    let settled = false;
    const pending = call(c, 'request_human_input', { question: 'Which db?', options: ['pg', 'sqlite'] }).then((r) => {
      settled = true;
      return r;
    });
    await vi_waitFor(() => f.calls.ask.length === 1);
    expect(f.calls.ask[0]?.[2]).toEqual(['pg', 'sqlite']);
    // Longer than the keep-alive interval would be nicer, but keep the test fast: other traffic proceeds.
    expect(await call(c2, 'report_progress', { summary: 'parallel' })).toMatchObject({ isError: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    f.pendingAsks[0]?.('sqlite');
    expect(JSON.parse((await pending).text)).toEqual({ answer: 'sqlite' });
  });

  it('survives keep-alive intervals while waiting', async () => {
    await srv.close();
    srv = await startMcpServer({ host: f.host, keepAliveMs: 50 });
    const c = await connect(srv.issueToken(coder()));
    const pending = call(c, 'request_human_input', { question: 'slow' });
    await vi_waitFor(() => f.calls.ask.length === 1);
    await new Promise((r) => setTimeout(r, 400));
    f.pendingAsks[0]?.('finally');
    expect(JSON.parse((await pending).text)).toEqual({ answer: 'finally' });
  });

  it('handles concurrent calls on one connection', async () => {
    const c = await connect(srv.issueToken(coder()));
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call(c, 'report_progress', { summary: `p${i}` })),
    );
    expect(rs.every((r) => !r.isError)).toBe(true);
    expect(f.calls.progress.map((p) => p[1]).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`).sort());
  });

  it('isolates bindings between tokens', async () => {
    const b1 = coder('t1', 'a1');
    const b2 = coder('t2', 'a2');
    const [c1, c2] = await Promise.all([connect(srv.issueToken(b1)), connect(srv.issueToken(b2))]);
    await Promise.all([
      call(c1, 'report_progress', { summary: 'one' }),
      call(c2, 'report_progress', { summary: 'two' }),
    ]);
    expect(f.calls.progress.find((p) => p[1] === 'one')?.[0]).toEqual(b1);
    expect(f.calls.progress.find((p) => p[1] === 'two')?.[0]).toEqual(b2);
  });

  describe('auth', () => {
    const post = (headers: Record<string, string>) =>
      fetch(srv.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

    it('401 without, with wrong, or with malformed token, without leaking details', async () => {
      const token = srv.issueToken(coder());
      const headerSets: Array<Record<string, string>> = [
        {},
        { Authorization: 'Bearer nope-nope-nope-nope-nope' },
        { Authorization: token },
        { Authorization: 'Bearer' },
      ];
      for (const h of headerSets) {
        const r = await post(h);
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ error: 'unauthorized' });
      }
    });

    it('401 for GET/DELETE without token, 405 with token', async () => {
      const token = srv.issueToken(coder());
      expect((await fetch(srv.url)).status).toBe(401);
      const r = await fetch(srv.url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      expect(r.status).toBe(405);
    });

    it('revoked tokens get 401, and in-flight requests are dropped', async () => {
      const token = srv.issueToken(coder());
      const c = await connect(token);
      await c.close();
      const init = await fetch(srv.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'request_human_input', arguments: { question: 'hang' } },
        }),
      });
      await vi_waitFor(() => f.calls.ask.length === 1);
      srv.revokeToken(token);
      await expect(init.text()).rejects.toThrow();
      expect((await post({ Authorization: `Bearer ${token}` })).status).toBe(401);
      await expect(connect(token)).rejects.toThrow();
    });

    it('works without session ids and accepts a plain JSON-RPC POST', async () => {
      const token = srv.issueToken(coder());
      const r = await post({ Authorization: `Bearer ${token}` });
      expect(r.status).toBe(200);
      expect(r.headers.get('mcp-session-id')).toBeNull();
      expect(await r.text()).toContain('report_progress');
    });
  });
});

describe('client config helpers', () => {
  it('claudeMcpConfig produces the --mcp-config JSON', () => {
    expect(JSON.parse(claudeMcpConfig('http://127.0.0.1:1234/mcp', 'tok'))).toEqual({
      mcpServers: {
        legion: { type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer tok' } },
      },
    });
  });

  it('codexMcpConfigOverrides produces TOML -c overrides without the token', () => {
    expect(codexMcpConfigOverrides('http://127.0.0.1:1234/mcp', 'LEGION_MCP_TOKEN', 600)).toEqual([
      '-c',
      'mcp_servers.legion.url="http://127.0.0.1:1234/mcp"',
      '-c',
      'mcp_servers.legion.bearer_token_env_var="LEGION_MCP_TOKEN"',
      '-c',
      'mcp_servers.legion.default_tools_approval_mode="approve"',
      '-c',
      'mcp_servers.legion.tool_timeout_sec=600',
    ]);
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
