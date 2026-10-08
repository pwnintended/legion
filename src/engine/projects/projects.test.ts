/**
 * Projects and read-only browsing over RPC, on temp repositories: the project list and its events, the
 * file tree (ignored files invisible), file contents (encodings, binary, images, truncation), confinement
 * (traversal, absolute paths, `.git`, symlinks leaving the root), fuzzy find, `git grep`, log/show, and the
 * migration backfill of existing runs.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessageChannel } from 'node:worker_threads';
import type { ServerEvent } from '@shared/events';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient, type RpcClient } from '@shared/rpc-transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../context';
import { openStore } from '../db';
import { MIGRATIONS } from '../db/migrations';
import { type FixtureRepo, makeRepo, tmp } from '../git/test-helpers';
import { type EngineHandle, startEngine } from '../index';
import { clipLine, decodeText, looksBinary, parseGrepZ } from './files';
import { parseDecorations } from './history';
import { ghProblem, parseGhPrs, parseStatusV2 } from './info';
import { normalizeRel } from './paths';

let dir: ReturnType<typeof tmp>;
let engine: EngineHandle;
let client: RpcClient<RpcContract, ServerEvent>;
let channel: MessageChannel;
let repo: FixtureRepo;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  dir = tmp('legion-projects-');
  repo = await makeRepo({
    'README.md': '# Widgets\n\nSmall things.\n',
    '.gitignore': 'node_modules/\n*.log\n.env\n',
    'src/index.ts': 'export const answer = 42;\n// TODO: find the question\n',
    'src/util/strings.ts': 'export function shout(s: string) {\n  return s.toUpperCase();\n}\n',
    'src/util/numbers.ts': 'export const two = 2;\n',
    'docs/guide.md': '# Guide\n\nTODO later\n',
    'assets/dot.png': PNG,
    'bin/blob.bin': Buffer.from([0, 1, 2, 3, 0, 255]),
  });
  // Ignored and untracked files.
  mkdirSync(join(repo.path, 'node_modules/left-pad'), { recursive: true });
  writeFileSync(join(repo.path, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
  writeFileSync(join(repo.path, 'debug.log'), 'noise\n');
  writeFileSync(join(repo.path, '.env'), 'SECRET=1\n');
  writeFileSync(join(repo.path, 'notes.txt'), 'untracked TODO note\n');
  engine = await startEngine({
    dataDir: join(dir.path, 'home'),
    env: process.env,
    log: silentLogger,
    fakeEngines: true,
    probeOnStart: false,
  });
  channel = new MessageChannel();
  engine.connect(channel.port1);
  client = createRpcClient(channel.port2, { timeoutMs: 20_000 });
});

afterEach(async () => {
  client.close();
  channel.port2.close();
  await engine.close();
  repo.cleanup();
  dir.cleanup();
});

async function addRepo() {
  return client.call('projects.add', { path: repo.path });
}

describe('projects', () => {
  it('add is idempotent, stores the real top level and pushes project.updated', async () => {
    const received: ServerEvent[] = [];
    client.onEvents((events) => received.push(...events));
    await client.call('subscribe', { sinceSeq: 0 });
    const project = await client.call('projects.add', { path: join(repo.path, 'src', 'util') });
    expect(project).toMatchObject({ path: repo.path, name: 'repo', pinned: false });
    expect(project.id).toMatch(/^prj_[0-9a-z]{12}$/);
    expect(project.lastOpenedAt).not.toBeNull();
    const again = await client.call('projects.add', { path: repo.path });
    expect(again.id).toBe(project.id);
    expect(await client.call('projects.list', {})).toHaveLength(1);
    await expect.poll(() => received.filter((e) => e.type === 'project.updated').length).toBeGreaterThanOrEqual(1);

    const pinned = await client.call('projects.pin', { projectId: project.id, pinned: true });
    expect(pinned.pinned).toBe(true);
    await client.call('projects.remove', { projectId: project.id });
    expect(await client.call('projects.list', {})).toEqual([]);
    await expect.poll(() => received.some((e) => e.type === 'project.updated' && e.removed)).toBe(true);
  });

  it('add refuses folders that are not git repositories', async () => {
    const plain = join(dir.path, 'plain');
    mkdirSync(plain);
    await expect(client.call('projects.add', { path: plain })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(client.call('projects.add', { path: 'relative/path' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('runs.create attaches the run to its project (adding it)', async () => {
    const run = await client.call('runs.create', {
      repoPath: repo.path,
      baseRef: null,
      title: 'Thing',
      issueText: 'Do the thing',
      issueUrl: null,
      plannerEngine: 'claude',
      plannerModel: null,
      skipClarify: true,
    });
    const projects = await client.call('projects.list', {});
    expect(projects).toHaveLength(1);
    expect(run.projectId).toBe(projects[0]?.id);
    expect(projects[0]?.lastOpenedAt).toBeNull();
    await client.call('runs.cancel', { runId: run.id });
  });

  it('status and info describe the checkout', async () => {
    const project = await addRepo();
    writeFileSync(join(repo.path, 'README.md'), '# Widgets, edited\n');
    const [status] = await client.call('projects.status', { projectId: null });
    expect(status).toMatchObject({ projectId: project.id, exists: true, branch: 'main', dirty: true });
    const info = await client.call('projects.info', { projectId: project.id });
    expect(info).toMatchObject({
      exists: true,
      currentBranch: 'main',
      defaultBranch: 'main',
      readme: 'README.md',
      dirty: true,
      commitCount: 1,
    });
    // Tracked + untracked-not-ignored: 8 committed + notes.txt.
    expect(info.fileCount).toBe(9);
    expect(info.languages.map((l) => l.name)).toEqual(expect.arrayContaining(['TypeScript', 'Markdown']));
    expect(info.lastCommit?.subject).toBe('initial');
  });
});

describe('files', () => {
  it('lists directories without ignored files, dirs first', async () => {
    const { id } = await addRepo();
    const rootList = await client.call('files.list', { projectId: id, dir: '' });
    expect(rootList.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:assets',
      'dir:bin',
      'dir:docs',
      'dir:src',
      'file:.gitignore',
      'file:notes.txt',
      'file:README.md',
    ]);
    const util = await client.call('files.list', { projectId: id, dir: './src/util/' });
    expect(util).toEqual({
      dir: 'src/util',
      entries: [
        { name: 'numbers.ts', path: 'src/util/numbers.ts', type: 'file', size: 22 },
        { name: 'strings.ts', path: 'src/util/strings.ts', type: 'file', size: 63 },
      ],
    });
    await expect(client.call('files.list', { projectId: id, dir: 'node_modules' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reads text, binary, images; truncates at a line end', async () => {
    const { id } = await addRepo();
    const text = await client.call('files.read', { projectId: id, path: 'src/util/strings.ts' });
    expect(text).toMatchObject({ kind: 'text', encoding: 'utf-8', truncated: false, size: 63 });
    expect(text.text).toContain('toUpperCase');
    const cut = await client.call('files.read', { projectId: id, path: 'src/util/strings.ts', maxBytes: 40 });
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('export function shout(s: string) {\n');
    const binary = await client.call('files.read', { projectId: id, path: 'bin/blob.bin' });
    expect(binary).toMatchObject({ kind: 'binary', text: null });
    const image = await client.call('files.read', { projectId: id, path: 'assets/dot.png' });
    expect(image.kind).toBe('image');
    expect(image.image?.mime).toBe('image/png');
    expect(Buffer.from(image.image?.base64 ?? '', 'base64').equals(PNG)).toBe(true);
    // Untracked (not ignored) files are part of the project; a file created just now is found too.
    writeFileSync(join(repo.path, 'fresh.md'), 'just written\n');
    await expect(client.call('files.read', { projectId: id, path: 'fresh.md' })).resolves.toMatchObject({
      text: 'just written\n',
    });
  });

  it('refuses traversal, absolute paths, .git, ignored files and symlinks leaving the root', async () => {
    const { id } = await addRepo();
    const outside = join(dir.path, 'secret.txt');
    writeFileSync(outside, 'top secret\n');
    symlinkSync(outside, join(repo.path, 'escape.txt'));
    symlinkSync(dir.path, join(repo.path, 'escape-dir'));
    symlinkSync(join(repo.path, '.git'), join(repo.path, 'gitdir'));
    symlinkSync('src/index.ts', join(repo.path, 'inside-link.ts'));
    const read = (path: string) => client.call('files.read', { projectId: id, path });

    for (const path of ['../secret.txt', 'src/../../secret.txt', outside, '/etc/passwd', '~/x', 'a\\..\\b']) {
      await expect(read(path), path).rejects.toMatchObject({ code: 'bad_request' });
    }
    for (const path of ['.git/config', 'src/.git/x', '.GIT/HEAD']) {
      await expect(read(path), path).rejects.toMatchObject({ code: 'bad_request' });
    }
    // Ignored files are not part of the project.
    for (const path of ['.env', 'debug.log', 'node_modules/left-pad/index.js', 'missing.ts']) {
      await expect(read(path), path).rejects.toMatchObject({ code: 'not_found' });
    }
    // Symlinks: listed as such, never followed out of the root (or into .git).
    const listing = await client.call('files.list', { projectId: id, dir: '' });
    expect(listing.entries.filter((e) => e.type === 'symlink').map((e) => e.name)).toEqual([
      'escape-dir',
      'escape.txt',
      'gitdir',
      'inside-link.ts',
    ]);
    await expect(read('escape.txt')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(read('escape-dir/secret.txt')).rejects.toMatchObject({ code: 'not_found' });
    await expect(read('gitdir/config')).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.call('files.list', { projectId: id, dir: 'escape-dir' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(client.call('files.list', { projectId: id, dir: '..' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.call('files.list', { projectId: id, dir: '.git' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    // A symlink that stays inside the project reads its target.
    await expect(read('inside-link.ts')).resolves.toMatchObject({ kind: 'text', text: expect.stringContaining('42') });
  });

  it('reads another checkout of the project (a git worktree), and nothing outside its checkouts', async () => {
    const { id } = await addRepo();
    const other = join(dir.path, 'wt-feature');
    await repo.git('worktree', 'add', '-q', '-b', 'feature/w', other);
    writeFileSync(join(other, 'src/index.ts'), 'export const answer = 43;\n');
    const checkouts = await client.call('projects.checkouts', { projectId: id });
    expect(checkouts).toEqual([
      expect.objectContaining({ branch: 'feature/w', kind: 'other', runId: null, taskId: null }),
    ]);
    const checkout = checkouts[0]?.path ?? '';
    const file = await client.call('files.read', { projectId: id, checkout, path: 'src/index.ts' });
    expect(file).toMatchObject({ kind: 'text', text: 'export const answer = 43;\n' });
    const main = await client.call('files.read', { projectId: id, path: 'src/index.ts' });
    expect(main).toMatchObject({ text: expect.stringContaining('42') });
    const found = await client.call('files.find', { projectId: id, checkout, query: 'index', limit: 5 });
    expect(found[0]?.path).toBe('src/index.ts');
    await expect(client.call('files.list', { projectId: id, checkout: dir.path, dir: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('saves an edited file only when it did not change since it was read', async () => {
    const { id } = await addRepo();
    const read = await client.call('files.read', { projectId: id, path: 'src/util/numbers.ts' });
    expect(read.version).toEqual(expect.any(String));
    const version = read.version as string;
    expect(await client.call('files.stat', { projectId: id, path: 'src/util/numbers.ts' })).toMatchObject({ version });
    const saved = await client.call('files.write', {
      projectId: id,
      path: 'src/util/numbers.ts',
      text: 'export const two = 2;\nexport const three = 3;\n',
      expectedVersion: version,
    });
    expect(saved.version).not.toBe(version);
    const again = await client.call('files.read', { projectId: id, path: 'src/util/numbers.ts' });
    expect(again.text).toContain('three');
    // Saving from the old version would overwrite what changed since: refused, nothing written.
    await expect(
      client.call('files.write', {
        projectId: id,
        path: 'src/util/numbers.ts',
        text: 'stale\n',
        expectedVersion: version,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await client.call('files.read', { projectId: id, path: 'src/util/numbers.ts' })).text).toContain('three');
    // Ignored files, new files and paths outside stay out of reach.
    await expect(
      client.call('files.write', { projectId: id, path: '.env', text: 'x', expectedVersion: version }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      client.call('files.write', { projectId: id, path: '../escape.ts', text: 'x', expectedVersion: version }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(await client.call('files.stat', { projectId: id, path: 'nope.ts' })).toMatchObject({ version: null });
  });

  it('finds files fuzzily, best first', async () => {
    const { id } = await addRepo();
    const found = await client.call('files.find', { projectId: id, query: 'strts', limit: 5 });
    expect(found[0]?.path).toBe('src/util/strings.ts');
    expect(found[0]?.positions).toHaveLength(5);
    const byName = await client.call('files.find', { projectId: id, query: 'numbers', limit: 5 });
    expect(byName.map((f) => f.path)).toEqual(['src/util/numbers.ts']);
    expect(await client.call('files.find', { projectId: id, query: 'zzzz', limit: 5 })).toEqual([]);
    const empty = await client.call('files.find', { projectId: id, query: '', limit: 3 });
    expect(empty.map((f) => f.path)).toEqual(['.gitignore', 'notes.txt', 'README.md']);
  });

  it('searches content with git grep (literal, case, regex, untracked, no ignored)', async () => {
    const { id } = await addRepo();
    const search = (query: string, extra: { regex?: boolean; caseSensitive?: boolean; limit?: number } = {}) =>
      client.call('files.search', { projectId: id, query, limit: extra.limit ?? 100, ...extra });
    const todo = await search('todo');
    expect(todo.matches.map((m) => `${m.path}:${m.line}:${m.column}`)).toEqual([
      'docs/guide.md:3:1',
      'notes.txt:1:11',
      'src/index.ts:2:4',
    ]);
    expect(todo.fileCount).toBe(3);
    expect((await search('todo', { caseSensitive: true })).matches).toHaveLength(0);
    const regex = await search('shout\\(|two =', { regex: true });
    expect(regex.matches.map((m) => m.path)).toEqual(['src/util/numbers.ts', 'src/util/strings.ts']);
    expect((await search('SECRET')).matches).toEqual([]);
    expect((await search('module.exports')).matches).toEqual([]);
    const limited = await search('e', { limit: 2 });
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    // A pattern starting with "-" is a pattern, not an option.
    expect((await search('--version')).matches).toEqual([]);
    await expect(search('(unclosed', { regex: true })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('history', () => {
  it('logs with decorations and shows a commit as a diff', async () => {
    const { id } = await addRepo();
    await repo.git('tag', 'v1');
    writeFileSync(join(repo.path, 'src/index.ts'), 'export const answer = 43;\n');
    await repo.git('commit', '-qam', 'Bump the answer');
    const second = await repo.head();
    await repo.git('branch', 'feature/x');
    const log = await client.call('git.log', { projectId: id, limit: 10 });
    expect(log.map((c) => c.subject)).toEqual(['Bump the answer', 'initial']);
    expect(log[0]?.sha).toBe(second);
    expect(log[0]?.refs).toEqual(
      expect.arrayContaining([
        { name: 'main', kind: 'head' },
        { name: 'feature/x', kind: 'branch' },
      ]),
    );
    expect(log[1]?.refs).toEqual([{ name: 'v1', kind: 'tag' }]);
    expect(log[0]?.author).toBe('Test');

    const show = await client.call('git.show', { projectId: id, sha: second.slice(0, 8) });
    expect(show.commit).toMatchObject({ sha: second, subject: 'Bump the answer', body: '' });
    expect(show.files).toHaveLength(1);
    expect(show.files[0]).toMatchObject({ path: 'src/index.ts', additions: 1, deletions: 2 });
    // The same diff through diff.get (the diff tile's path).
    const viaDiff = await client.call('diff.get', {
      target: { kind: 'commit', projectId: id, sha: second },
      contextLines: 3,
    });
    expect(viaDiff.files[0]?.path).toBe('src/index.ts');
    // The root commit is diffed against the empty tree.
    const root = await client.call('git.show', { projectId: id, sha: log[1]?.sha ?? '' });
    expect(root.files.length).toBeGreaterThan(5);
    expect(root.files.every((f) => f.status === 'added')).toBe(true);

    await expect(client.call('git.show', { projectId: id, sha: '--output=/tmp/x' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.call('git.show', { projectId: id, sha: 'deadbeef' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(client.call('git.log', { projectId: id, limit: 5, ref: 'HEAD..main' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await client.call('git.log', { projectId: id, limit: 5, ref: 'v1' })).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('normalizeRel', () => {
    expect(normalizeRel('')).toBe('');
    expect(normalizeRel('./a//b/')).toBe('a/b');
    for (const bad of ['..', 'a/../b', '/abs', 'C:/x', '.git', 'x/.Git/y', 'a\0b', 'a\\b', '~'])
      expect(() => normalizeRel(bad), bad).toThrow();
  });

  it('text decoding and binary sniffing', () => {
    expect(decodeText(Buffer.from('héllo', 'utf8'))).toEqual({ text: 'héllo', encoding: 'utf-8' });
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({ text: 'hi', encoding: 'utf-8' });
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toEqual({ text: 'hi', encoding: 'utf-16le' });
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({ text: 'café', encoding: 'latin1' });
    expect(looksBinary(Buffer.from('abc\0def'))).toBe(true);
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0x68, 0x00]))).toBe(false);
  });

  it('grep output and line clipping', () => {
    expect(parseGrepZ('a:b.ts\x0012\x003\x00const x = 1;\nbroken line\n')).toEqual([
      { path: 'a:b.ts', line: 12, column: 3, text: 'const x = 1;' },
    ]);
    const long = `${'x'.repeat(1000)}NEEDLE${'y'.repeat(1000)}`;
    const clipped = clipLine(long, 1001);
    expect(clipped.text).toHaveLength(400);
    expect(clipped.text.slice(clipped.column - 1 - clipped.clipStart)).toMatch(/^NEEDLE/);
    expect(clipLine('héllo world', 8).column).toBe(7);
  });

  it('decorations, status and gh output', () => {
    expect(parseDecorations('HEAD -> main, origin/main, origin/HEAD, tag: v2, feat', ['origin'])).toEqual([
      { name: 'main', kind: 'head' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v2', kind: 'tag' },
      { name: 'feat', kind: 'branch' },
    ]);
    expect(
      parseStatusV2('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n'),
    ).toEqual({ branch: 'main', dirty: false, ahead: 2, behind: 1 });
    expect(parseStatusV2('# branch.head (detached)\n1 .M N... 100644 100644 100644 a b f.ts\n')).toEqual({
      branch: null,
      dirty: true,
      ahead: null,
      behind: null,
    });
    expect(
      parseGhPrs(
        JSON.stringify([
          {
            number: 7,
            title: 'Add it',
            state: 'OPEN',
            isDraft: true,
            headRefName: 'feat/it',
            author: { login: 'me' },
            url: 'https://github.com/o/r/pull/7',
            updatedAt: '2026-10-01T10:00:00Z',
          },
        ]),
      ),
    ).toEqual([
      {
        number: 7,
        title: 'Add it',
        state: 'open',
        isDraft: true,
        branch: 'feat/it',
        author: 'me',
        url: 'https://github.com/o/r/pull/7',
        updatedAt: Date.parse('2026-10-01T10:00:00Z'),
      },
    ]);
    expect(ghProblem('To get started with GitHub CLI, please run:  gh auth login')).toMatch(/not signed in/);
    expect(ghProblem('none of the git remotes configured for this repository point to a known GitHub host')).toBe(
      'no GitHub remote',
    );
  });
});

describe('migration 004', () => {
  it('backfills one project per repository of existing runs', () => {
    const path = join(dir.path, 'old.db');
    const db = new DatabaseSync(path);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) db.exec(migration.up);
    db.exec('PRAGMA user_version = 3');
    const insert = db.prepare(
      `INSERT INTO runs (id, repo_path, base_ref, title, issue_text, status, planner_engine, created_at, updated_at)
       VALUES (?, ?, 'main', 't', 'i', 'done', 'claude', ?, ?)`,
    );
    insert.run('run_a', '/Users/me/src/app', 10, 20);
    insert.run('run_b', '/Users/me/src/app', 30, 40);
    insert.run('run_c', '/Users/me/src/web/', 50, 60);
    db.close();
    const opened = openStore(path);
    try {
      const projects = opened.store.listProjects();
      expect(projects.map((p) => [p.name, p.path, p.addedAt, p.lastOpenedAt])).toEqual([
        ['app', '/Users/me/src/app', 10, 40],
        ['web', '/Users/me/src/web/', 50, 60],
      ]);
      expect(projects.every((p) => /^prj_[0-9a-z]{12}$/.test(p.id))).toBe(true);
      expect(opened.store.getRun('run_b')?.projectId).toBe(projects[0]?.id);
      expect(opened.store.getRun('run_c')?.projectId).toBe(projects[1]?.id);
      // Removing a project keeps its runs, unlinked.
      opened.store.removeProject(projects[0]?.id ?? '');
      expect(opened.store.getRun('run_a')?.projectId).toBeNull();
    } finally {
      opened.close();
    }
  });
});
