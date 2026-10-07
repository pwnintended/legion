import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approve, type Harness, node, planOutput, report, startHarness, taskIdIn } from '../orchestrator/test-harness';
import { discoverMcpServers } from './discover';
import { availableSkills, resolveAccess } from './resolve';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legion-access-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(parent: string, folder: string, name: string, description = 'd'): string {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  return dir;
}

const linear = { type: 'http' as const, url: 'https://mcp.linear.app/mcp', headers: {} };
const settings = (access: Settings['access']): Pick<Settings, 'mcpServers' | 'access'> => ({
  mcpServers: { linear },
  access,
});

describe('resolveAccess', () => {
  it('gives nothing without a grant, a project, or to a coordinating role', async () => {
    const s = settings({ p1: { coder: { mcp: ['linear'], skills: [] } } });
    expect(await resolveAccess(s, 'p2', 'coder', root)).toEqual({ extraMcp: {}, skills: null });
    expect(await resolveAccess(s, null, 'coder', root)).toEqual({ extraMcp: {}, skills: null });
    expect(await resolveAccess(s, 'p1', 'reviewer', root)).toEqual({ extraMcp: {}, skills: null });
    // The grant exists but the role only talks.
    const lead = settings({ p1: { lead: { mcp: ['linear'], skills: [] } } });
    expect(await resolveAccess(lead, 'p1', 'lead', root)).toEqual({ extraMcp: {}, skills: null });
  });

  it('resolves servers by name and leaves skills at the default when the grant says null', async () => {
    const s = settings({ p1: { coder: { mcp: ['linear', 'removed'], skills: null } } });
    expect(await resolveAccess(s, 'p1', 'coder', root)).toEqual({ extraMcp: { linear }, skills: null });
  });

  it('resolves an allowlist to the user skill folders it names', async () => {
    const zebra = skill(join(root, '.claude', 'skills'), 'zebra', 'zebra');
    skill(join(root, '.claude', 'skills'), 'other', 'other');
    const s = settings({ p1: { coder: { mcp: [], skills: ['zebra', 'repo-only'] } } });
    expect(await resolveAccess(s, 'p1', 'coder', root)).toEqual({
      extraMcp: {},
      skills: { allow: ['zebra', 'repo-only'], user: [{ name: 'zebra', dir: zebra }] },
    });
    const none = settings({ p1: { coder: { mcp: [], skills: [] } } });
    expect((await resolveAccess(none, 'p1', 'coder', root)).skills).toEqual({ allow: [], user: [] });
  });
});

describe('availableSkills', () => {
  it('lists user and repo skills, the repo winning a name', async () => {
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    skill(join(home, '.claude', 'skills'), 'a', 'shared', 'from user');
    skill(join(home, '.claude', 'skills'), 'b', 'mine');
    skill(join(repo, '.claude', 'skills'), 'c', 'shared', 'from repo');
    skill(join(repo, '.agents', 'skills'), 'd', 'codex-only');
    expect(await availableSkills(home, repo)).toEqual([
      { name: 'codex-only', description: 'd', scope: 'project' },
      { name: 'mine', description: 'd', scope: 'user' },
      { name: 'shared', description: 'from repo', scope: 'project' },
    ]);
    expect((await availableSkills(home, null)).map((s) => s.name)).toEqual(['mine', 'shared']);
  });
});

describe('discoverMcpServers', () => {
  it('reads user and project Claude configs, skipping what the registry cannot hold', async () => {
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(repo);
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } },
          local: { command: 'npx', args: ['-y', 'thing'] },
          streaming: { type: 'sse', url: 'https://x/sse' },
          'bad name': { command: 'x' },
          legion: { command: 'x' },
        },
      }),
    );
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://d/mcp' } } }),
    );
    const found = await discoverMcpServers(home, repo);
    expect(found.map((f) => [f.name, f.source])).toEqual([
      ['docs', '.mcp.json'],
      ['linear', '~/.claude.json'],
      ['local', '~/.claude.json'],
    ]);
    expect(found.find((f) => f.name === 'local')?.server).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'thing'],
      env: {},
    });
  });

  it('tolerates missing or broken files', async () => {
    writeFileSync(join(root, '.claude.json'), '{ nope');
    expect(await discoverMcpServers(root, null)).toEqual([]);
    expect(await discoverMcpServers(join(root, 'nowhere'), null)).toEqual([]);
  });
});

describe('sessions get their project access', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('passes the coder its servers and skills, and a reviewer nothing', async () => {
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
        if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
        const id = taskIdIn(ctx.message);
        return [{ kind: 'write_file', path: `src/${id}.txt`, content: `${id}\n` }, report(`Implement ${id}`)];
      },
    });
    const harness = h;
    const project = await harness.client.call('projects.add', { path: harness.repo.path });
    await harness.client.call('settings.set', {
      mcpServers: { linear },
      access: {
        [project.id]: { coder: { mcp: ['linear'], skills: ['review-helper'] }, lead: { mcp: ['linear'], skills: [] } },
      },
    });
    const run = await harness.client.call('runs.create', {
      repoPath: harness.repo.path,
      baseRef: 'main',
      title: 'Access',
      issueText: 'Do the thing.',
      issueUrl: null,
      plannerEngine: 'claude',
      plannerModel: null,
      skipClarify: true,
    });
    await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
    const sessions = () => [...harness.claude.sessions, ...harness.codex.sessions];
    const coder = await harness.waitFor(() => sessions().find((s) => s.opts.role === 'coder'), 'coder session');
    expect(coder.opts.extraMcp).toEqual({ linear });
    expect(coder.opts.skills).toEqual({ allow: ['review-helper'], user: [] });
    const planner = sessions().find((s) => s.opts.role === 'planner');
    expect(planner?.opts.extraMcp).toBeUndefined();
    expect(planner?.opts.skills).toBeUndefined();
    expect(DEFAULT_SETTINGS.access).toEqual({});
  });

  it("forgets a removed project's grants", async () => {
    h = await startHarness({ script: () => [] });
    const harness = h;
    const project = await harness.client.call('projects.add', { path: harness.repo.path });
    await harness.client.call('settings.set', {
      mcpServers: { linear },
      access: { [project.id]: { coder: { mcp: ['linear'], skills: null } } },
    });
    expect((await harness.client.call('settings.get', {})).access[project.id]).toBeDefined();
    await harness.client.call('projects.remove', { projectId: project.id });
    const after = await harness.client.call('settings.get', {});
    expect(after.access).toEqual({});
    expect(Object.keys(after.mcpServers)).toEqual(['linear']);
  });
});
