import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { ServerEvent } from '@shared/events';
import { type RpcContract, rpcContract } from '@shared/rpc';
import { createRpcClient, type RpcClient } from '@shared/rpc-transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './context';
import { type EngineHandle, startEngine } from './index';
import { tempDir } from './test/helpers';

let dir: ReturnType<typeof tempDir>;
let engine: EngineHandle;
let client: RpcClient<RpcContract, ServerEvent>;
let channel: MessageChannel;

beforeEach(async () => {
  dir = tempDir();
  engine = await startEngine({
    dataDir: dir.path,
    env: process.env,
    version: '9.9.9',
    log: silentLogger,
    fakeEngines: true,
    probeOnStart: false,
  });
  channel = new MessageChannel();
  engine.connect(channel.port1);
  client = createRpcClient(channel.port2, { timeoutMs: 10_000 });
});

afterEach(async () => {
  client.close();
  channel.port2.close();
  await engine.close();
  dir.cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

describe('engine over RPC (plain Node)', () => {
  it('app.info reports the runtime and data dir', async () => {
    const info = await client.call('app.info', {});
    expect(info).toMatchObject({
      name: 'Legion',
      version: '9.9.9',
      dataDir: dir.path,
      dbPath: join(dir.path, 'legion.db'),
      schemaVersion: 7,
      pid: process.pid,
      runtime: { node: process.versions.node, electron: null },
    });
    expect(existsSync(join(dir.path, 'legion.db'))).toBe(true);
  });

  it('settings.get/set persist and push settings.updated to subscribers', async () => {
    const received: ServerEvent[] = [];
    client.onEvents((events) => received.push(...events));
    await expect(client.call('subscribe', { sinceSeq: 0 })).resolves.toEqual({ headSeq: 0, replayed: true });
    const settings = await client.call('settings.get', {});
    expect(settings.concurrency.global).toBe(3);
    const updated = await client.call('settings.set', { budget: { perRunUsd: 12.5 } });
    expect(updated.budget.perRunUsd).toBe(12.5);
    expect((await client.call('settings.get', {})).budget.perRunUsd).toBe(12.5);
    await expect(client.call('settings.set', { concurrency: { global: 0 } })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({ type: 'settings.updated', seq: 1 });
  });

  it('runs.list returns summaries', async () => {
    expect(await client.call('runs.list', {})).toEqual([]);
    const run = engine.store.createRun({
      repoPath: dir.path,
      baseRef: 'main',
      title: 't',
      issueText: 'i',
      issueUrl: null,
      plannerEngine: 'fake',
      plannerModel: null,
    });
    const list = await client.call('runs.list', {});
    expect(list).toEqual([{ run, taskCounts: {}, openInbox: 0, costUsd: 0 }]);
  });

  it('implements every procedure of the contract', async () => {
    const missing = (Object.keys(rpcContract) as (keyof typeof rpcContract)[]).filter(
      (name) => !engine.server.isImplemented(name),
    );
    expect(missing).toEqual([]);
    await expect(client.call('runs.get', { runId: 'run_x' })).rejects.toMatchObject({ code: 'not_found' });
    const engines = await client.call('engines.list', {});
    expect(engines.map((e) => e.kind)).toEqual(['claude', 'codex', 'fake']);
    expect(engines.every((e) => e.installed && e.error === null)).toBe(true);
  });

  it('subscribe replays missed events, or asks for a refetch when it cannot', async () => {
    engine.store.updateSettings({ budget: { warnAtPct: 50 } });
    engine.store.updateSettings({ budget: { warnAtPct: 60 } });
    engine.store.updateSettings({ budget: { warnAtPct: 70 } });
    const received: ServerEvent[] = [];
    client.onEvents((events) => received.push(...events));
    await expect(client.call('subscribe', { sinceSeq: 1 })).resolves.toEqual({ headSeq: 3, replayed: true });
    await expect.poll(() => received.map((e) => e.seq)).toEqual([2, 3]);
    await expect(client.call('subscribe', { sinceSeq: 0 })).resolves.toEqual({ headSeq: 3, replayed: false });
    await expect(client.call('subscribe', { sinceSeq: 99 })).resolves.toEqual({ headSeq: 3, replayed: false });
    engine.store.updateSettings({ budget: { warnAtPct: 80 } });
    await expect.poll(() => received.at(-1)?.seq).toBe(4);
  });

  it('repos.inspect describes a git repo and records it as recent', async () => {
    const repo = join(dir.path, 'repo');
    execFileSync('mkdir', ['-p', repo]);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@legion.test');
    git(repo, 'config', 'user.name', 'Legion Test');
    writeFileSync(join(repo, 'README.md'), '# hi\n');
    writeFileSync(join(repo, 'legion.json'), JSON.stringify({ verify: ['pnpm test'], installCommand: 'pnpm install' }));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:erudiet/legion.git');

    const inspection = await client.call('repos.inspect', { path: repo });
    expect(inspection).toMatchObject({
      exists: true,
      isGitRepo: true,
      currentBranch: 'main',
      defaultBranch: 'main',
      remotes: [{ name: 'origin', url: 'git@github.com:erudiet/legion.git' }],
      github: { owner: 'erudiet', name: 'legion' },
      dirty: false,
      error: null,
      legionConfig: { verify: ['pnpm test'], installCommand: 'pnpm install', setup: null },
    });
    expect(inspection.headSha).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(repo, 'README.md'), '# changed\n');
    expect((await client.call('repos.inspect', { path: repo })).dirty).toBe(true);
    expect((await client.call('repos.recent', {})).map((r) => r.name)).toEqual(['repo']);
  });

  it('repos.discover finds checkouts under the configured roots; repos.branches lists their branches', async () => {
    await engine.close();
    client.close();
    channel.port2.close();
    const projects = join(dir.path, 'Projects');
    const repo = join(projects, 'acme', 'widgets');
    execFileSync('mkdir', ['-p', repo, join(projects, 'notes')]);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@legion.test', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'branch', 'feature/login');
    engine = await startEngine({
      dataDir: join(dir.path, 'data'),
      env: { ...process.env, LEGION_DISCOVER_ROOTS: projects },
      version: '9.9.9',
      log: silentLogger,
      fakeEngines: true,
      probeOnStart: false,
    });
    channel = new MessageChannel();
    engine.connect(channel.port1);
    client = createRpcClient(channel.port2, { timeoutMs: 10_000 });

    const found = await client.call('repos.discover', {});
    expect(found).toEqual([
      { path: repo, name: 'widgets', branch: 'main', dirty: false, lastCommitAt: expect.any(Number) },
    ]);
    expect(await client.call('repos.branches', { path: repo })).toEqual({
      current: 'main',
      default: 'main',
      local: expect.arrayContaining(['main', 'feature/login']),
      remote: [],
    });
    expect((await client.call('app.info', {})).homeDir).toBeTruthy();
  });

  it('repos.initialCommit gives a repository without commits its first one, with its files', async () => {
    const repo = join(dir.path, 'fresh');
    execFileSync('mkdir', ['-p', join(repo, '.claude')]);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@legion.test');
    git(repo, 'config', 'user.name', 'Legion Test');
    writeFileSync(join(repo, '.claude', 'skill.md'), '# skill\n');
    writeFileSync(join(repo, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(repo, 'secret.txt'), 'nope\n');
    expect((await client.call('repos.inspect', { path: repo })).headSha).toBeNull();

    const after = await client.call('repos.initialCommit', { path: repo });
    expect(after.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync('git', ['-C', repo, 'log', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Initial commit');
    const files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
    expect(files.sort()).toEqual(['.claude/skill.md', '.gitignore']);
    await expect(client.call('repos.initialCommit', { path: repo })).rejects.toThrow(/already has commits/);
    await expect(client.call('repos.initialCommit', { path: dir.path })).rejects.toThrow(/not a git repository/);
  });

  it('repos.inspect reports non-repos and bad paths', async () => {
    await expect(client.call('repos.inspect', { path: dir.path })).resolves.toMatchObject({
      exists: true,
      isGitRepo: false,
      error: 'not a git repository',
    });
    await expect(client.call('repos.inspect', { path: join(dir.path, 'nope') })).resolves.toMatchObject({
      exists: false,
      error: 'not a directory',
    });
    await expect(client.call('repos.inspect', { path: 'relative/path' })).resolves.toMatchObject({
      error: 'path must be absolute',
    });
  });
});
