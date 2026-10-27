import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeEngine } from '../engine/fake/index.ts';
import { type FixtureRepo, makeRepo } from '../git/test-helpers.ts';
import { Session } from '../session.ts';
import { ROOT } from './team.ts';

let repo: FixtureRepo;
let session: Session;
const clients: Client[] = [];

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(20);
  }
}

/** An MCP client calling Legion's tools as `who` (the orchestrator or a lead). */
async function as(who: string) {
  const token = [...session.team.tokens()].find(([, name]) => name === who)?.[0];
  if (!token) throw new Error(`no token for ${who}`);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(session.mcpUrl ?? ''), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return {
    tools: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      const text = res.content[0]?.text ?? '';
      if (res.isError) throw new Error(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

const claude = () => session.engine('claude') as FakeEngine;
/** The fake session calls whose system prompt is a given lead's. */
const callsOf = (lead: string) => claude().calls.filter((c) => c.opts.systemPrompt?.startsWith(`You are ${lead},`));

beforeEach(async () => {
  repo = await makeRepo();
  mkdirSync(join(repo.path, '.legion', 'roles'), { recursive: true });
  mkdirSync(join(repo.path, '.legion', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo.path, '.legion', 'roles', 'assets-lead.md'),
    '---\ndescription: Leads asset production\nspawns: [fauna-lead]\nworkflows: [critique]\n---\nYou lead the assets.\n',
  );
  writeFileSync(
    join(repo.path, '.legion', 'roles', 'fauna-lead.md'),
    '---\ndescription: Fauna models\nspawns: []\n---\nYou make creatures.\n',
  );
  writeFileSync(
    join(repo.path, '.legion', 'workflows', 'critique.ts'),
    `import { workflow, agent, gate, z } from 'legion';
export default workflow({ name: 'critique', description: 'Make and judge', input: z.object({}) },
  async () => {
    const art = await agent('make', { prompt: 'make it' });
    const ok = await gate('judge', { title: 'Good enough?', show: art });
    return { approved: ok.approved, note: ok.note };
  });
`,
  );
  session = await Session.open({ cwd: repo.path, fake: true });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await session.close();
  repo.cleanup();
});

describe('team', () => {
  it('spawns a lead that gets its brief, role and own tools', async () => {
    const root = await as(ROOT);
    expect(await root.tools()).not.toContain('report');
    const out = await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'Make planet assets.' });
    expect(out).toMatchObject({ name: 'assets', role: 'assets-lead' });
    await until(() => callsOf('assets').length === 1);
    const call = callsOf('assets')[0];
    expect(call?.prompts[0]).toContain('Make planet assets.');
    expect(call?.opts.systemPrompt).toContain('You lead the assets.');
    expect(Object.keys(call?.opts.mcp ?? {})).toContain('legion');

    const lead = await as('assets');
    expect(await lead.tools()).toEqual(expect.arrayContaining(['report', 'answer_interaction', 'spawn_lead']));
    const leads = await root.call('list_leads');
    expect(leads).toMatchObject([{ name: 'assets', role: 'assets-lead', parent: ROOT }]);
    const saved = JSON.parse(readFileSync(join(repo.path, '.legion', 'team', 'team.json'), 'utf8'));
    expect(saved.leads[0]).toMatchObject({ name: 'assets', brief: 'Make planet assets.' });
  });

  it('enforces spawn lists, depth and parenthood', async () => {
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    const assets = await as('assets');
    await expect(assets.call('spawn_lead', { role: 'assets-lead', name: 'x', brief: 'b' })).rejects.toThrow(
      /may not spawn assets-lead/,
    );
    await assets.call('spawn_lead', { role: 'fauna-lead', name: 'fauna', brief: 'creatures' });
    const fauna = await as('fauna');
    await expect(fauna.call('spawn_lead', { role: 'fauna-lead', name: 'y', brief: 'b' })).rejects.toThrow(
      /may not spawn/,
    );
    // The orchestrator only talks to its own leads.
    await expect(root.call('message_lead', { name: 'fauna', text: 'hi' })).rejects.toThrow(/not your lead/);
    expect((await root.call('list_leads', { all: true })).map((l: { name: string }) => l.name)).toEqual([
      'assets',
      'fauna',
    ]);
    await expect(root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' })).rejects.toThrow(
      /already/,
    );
  });

  it('gives each lead its own worktree and branch, and merges it up with merge_lead', async () => {
    const gitOut = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const userBranch = gitOut(repo.path, 'branch', '--show-current');
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    await until(() => callsOf('assets').length === 1);
    const ws = session.team.get('assets')?.workspace;
    expect(ws?.branch).toBe('legion/lead/assets');
    expect(ws?.base).toBe(userBranch);
    expect(callsOf('assets')[0]?.opts.cwd).toBe(ws?.path);
    expect(gitOut(ws?.path ?? '', 'branch', '--show-current')).toBe('legion/lead/assets');
    expect(callsOf('assets')[0]?.opts.systemPrompt).toContain('Never create git worktrees or branches yourself');

    // A sub-lead branches off its parent's branch.
    const assets = await as('assets');
    await assets.call('spawn_lead', { role: 'fauna-lead', name: 'world', brief: 'b' });
    await until(() => callsOf('world').length === 1);
    expect(session.team.get('world')?.workspace?.base).toBe('legion/lead/assets');

    // Its runs start from its branch and work in its worktree; uncommitted files are flagged.
    writeFileSync(join(ws?.path ?? '', 'spec.md'), 'the spec\n');
    const started = await assets.call('run_workflow', { name: 'critique', input: {} });
    expect(started).toMatchObject({ startsFrom: 'legion/lead/assets', worksIn: ws?.path });
    expect(started.warning).toContain('spec.md');
    expect(session.runs.run(started.runId)).toMatchObject({ base: 'legion/lead/assets', cwd: ws?.path });
    session.runs.cancel(started.runId);

    // Only its parent merges it: into the user's branch, uncommitted work included.
    await expect(assets.call('merge_lead', { name: 'assets' })).rejects.toThrow(/not your lead/);
    const merged = await root.call('merge_lead', { name: 'assets' });
    expect(merged).toMatchObject({ into: userBranch, files: ['spec.md'] });
    expect(existsSync(join(repo.path, 'spec.md'))).toBe(true);
  });

  it('lets the orchestrator present files and pages to the user', async () => {
    writeFileSync(join(repo.path, 'shot.png'), 'x');
    const shown: unknown[] = [];
    session.team.on('present', (p) => shown.push(p));
    const root = await as(ROOT);
    await root.call('present', {
      title: 'Look',
      items: [
        { target: 'shot.png', caption: 'front' },
        { target: 'https://example.com/page' },
        { target: 'README.md' },
      ],
    });
    expect(shown).toEqual([
      {
        title: 'Look',
        items: [
          { kind: 'image', target: join(repo.path, 'shot.png'), caption: 'front' },
          { kind: 'url', target: 'https://example.com/page', caption: null },
          { kind: 'file', target: join(repo.path, 'README.md'), caption: null },
        ],
      },
    ]);
    await expect(root.call('present', { title: 'x', items: [{ target: 'nope.png' }] })).rejects.toThrow(/No such file/);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    expect(await (await as('assets')).tools()).not.toContain('present');
  });

  it("sends a lead's run tool approvals to the user, never through the lead", async () => {
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    await until(() => callsOf('assets').length === 1);
    claude().script = (call) =>
      call.prompts[0] === 'make it'
        ? { approval: { tool: 'Bash', input: { command: 'make' } }, text: 'art' }
        : { text: 'ok' };
    const assets = await as('assets');
    await assets.call('run_workflow', { name: 'critique', input: {} });
    await until(() => session.runs.pendingInteractions().some((p) => p.interaction.kind === 'approval'));
    const approval = session.runs.pendingInteractions().find((p) => p.interaction.kind === 'approval');
    expect(approval && session.team.userAnswers(approval)).toBe(true);
    expect(session.team.pending('assets')).toEqual([]);
    expect(await assets.call('pending_interactions')).toEqual([]);
    await tick(100);
    expect(callsOf('assets')[0]?.prompts.some((p) => p.includes('Bash'))).toBe(false);
  });

  it('delivers reports to the parent as one bundled message', async () => {
    await session.assistant.send('hello');
    await until(() => !session.assistant.busy);
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    await root.call('spawn_lead', { role: 'fauna-lead', name: 'world', brief: 'b' });
    const assets = await as('assets');
    await assets.call('report', { kind: 'review', summary: 'Pick a style', files: ['art/a.png', 'art/b.png'] });
    const rootCall = claude().calls.find((c) => c.prompts[0] === 'hello');
    await until(() => rootCall?.prompts.some((p) => p.includes('Pick a style')) ?? false);
    const note = rootCall?.prompts.find((p) => p.includes('Pick a style')) ?? '';
    expect(note).toContain('[Legion]');
    expect(note).toContain('Report from assets (review)');
    expect(note).toContain('art/a.png, art/b.png');
    expect(session.team.get('assets')?.lastReport?.kind).toBe('review');

    await root.call('message_lead', { name: 'assets', text: 'Go with B' });
    await until(() => callsOf('assets')[0]?.prompts.some((p) => p.includes('Go with B')) ?? false);
  });

  it("routes a lead's run gates to the lead, not the user", async () => {
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    const assets = await as('assets');
    await expect(assets.call('run_workflow', { name: 'hello', input: {} })).rejects.toThrow(/may not run hello/);
    const { runId } = await assets.call('run_workflow', { name: 'critique', input: {} });
    expect(session.runs.run(runId)?.owner).toBe('assets');
    await until(() => session.team.pending('assets').length === 1);
    // The orchestrator does not see it as its own.
    expect(session.team.pending(ROOT)).toEqual([]);
    await until(() => callsOf('assets')[0]?.prompts.some((p) => p.includes('Gate "Good enough?"')) ?? false);
    const pending = await assets.call('pending_interactions');
    expect(pending[0]).toMatchObject({ kind: 'gate', title: 'Good enough?' });
    await expect(root.call('run_status', { runId })).resolves.toBeTruthy();
    await assets.call('answer_interaction', { id: pending[0].id, choice: 'changes', note: 'more fur' });
    await until(() => !session.runs.isActive(runId));
    expect(session.runs.run(runId)?.result).toEqual({ approved: false, note: 'more fur' });
    await until(
      () => callsOf('assets')[0]?.prompts.some((p) => p.includes(`Run ${runId} (critique) finished`)) ?? false,
    );
  });

  it('keeps plans and resumes leads after a restart', async () => {
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'assets-lead', name: 'assets', brief: 'b' });
    const assets = await as('assets');
    await assets.call('update_plan', {
      summary: 'Fauna first',
      items: [{ id: '1', title: 'Fauna', status: 'doing', owner: 'fauna' }],
    });
    await until(() => session.team.get('assets')?.sessionId !== null);
    const sessionId = session.team.get('assets')?.sessionId;
    for (const c of clients.splice(0)) await c.close();
    await session.close();

    session = await Session.open({ cwd: repo.path, fake: true });
    const lead = session.team.get('assets');
    expect(lead).toMatchObject({ status: 'idle', plan: { summary: 'Fauna first' }, sessionId });
    await (await as(ROOT)).call('message_lead', { name: 'assets', text: 'status?' });
    await until(() => callsOf('assets').length === 1);
    expect(callsOf('assets')[0]).toMatchObject({ resumed: true, sessionId });
  });

  it("gate modes: ask sends a lead's gates to the user, tell reports answers to the parent", async () => {
    writeFileSync(
      join(repo.path, '.legion', 'roles', 'careful.md'),
      '---\ngates: ask\nworkflows: [critique]\n---\nAsk the human.\n',
    );
    writeFileSync(
      join(repo.path, '.legion', 'roles', 'teller.md'),
      '---\ngates: tell\nworkflows: [critique]\n---\nDecide and tell.\n',
    );
    await session.assistant.send('hello');
    await until(() => !session.assistant.busy);
    const root = await as(ROOT);
    await root.call('spawn_lead', { role: 'careful', name: 'careful', brief: 'b' });
    await root.call('spawn_lead', { role: 'teller', name: 'teller', brief: 'b' });
    expect(session.team.gateMode('careful')).toBe('ask');
    expect(session.team.gateMode(ROOT)).toBe('ask');

    const careful = await as('careful');
    await careful.call('run_workflow', { name: 'critique', input: {} });
    await until(() => callsOf('careful')[0]?.prompts.some((p) => p.includes('waits for the user')) ?? false);
    expect(callsOf('careful')[0]?.prompts.some((p) => p.includes('answer_interaction({'))).toBe(false);

    const teller = await as('teller');
    const { runId } = await teller.call('run_workflow', { name: 'critique', input: {} });
    await until(() => session.team.pending('teller').length === 1);
    const [pending] = session.team.pending('teller');
    await teller.call('answer_interaction', { id: pending?.id, choice: 'approve' });
    await until(() => !session.runs.isActive(runId));
    const rootCall = claude().calls.find((c) => c.prompts[0] === 'hello');
    await until(
      () => rootCall?.prompts.some((p) => p.includes('teller answered gate "Good enough?": approve')) ?? false,
    );
  });

  it('lets the orchestrator answer its own runs when [team] gates = "decide"', async () => {
    writeFileSync(join(repo.path, '.legion', 'config.local.toml'), '[team]\ngates = "decide"\n');
    await session.reloadConfig();
    await session.assistant.send('hello');
    await until(() => !session.assistant.busy);
    const root = await as(ROOT);
    const { runId } = await root.call('run_workflow', { name: 'critique', input: {} });
    const rootCall = claude().calls.find((c) => c.prompts[0] === 'hello');
    await until(() => rootCall?.prompts.some((p) => p.includes('Gate "Good enough?"')) ?? false);
    const [pending] = await root.call('pending_interactions');
    await root.call('answer_interaction', { id: pending.id, choice: 'abort' });
    await until(() => !session.runs.isActive(runId));
    expect(session.runs.run(runId)?.status).toBe('cancelled');
  });
});
