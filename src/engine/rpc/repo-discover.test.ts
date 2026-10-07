import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/helpers';
import {
  DiscoveryCache,
  discoverRepos,
  discoveryRoots,
  findRepoDirs,
  listBranches,
  sortDiscovered,
} from './repo-discover';

const gitEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: { ...gitEnv, ...extra }, encoding: 'utf8' }).trim();
}

/** A repo at `path` on `branch` with one commit dated `epochSeconds`. */
function makeRepo(path: string, epochSeconds: number, branch = 'main'): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', branch]);
  writeFileSync(join(path, 'README.md'), `# ${path}\n`);
  git(path, ['add', '-A']);
  const date = `${epochSeconds} +0000`;
  git(path, ['commit', '-q', '-m', 'init'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return path;
}

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir('legion-discover-');
});
afterEach(() => dir.cleanup());

describe('discoveryRoots', () => {
  it('scans the common dev folders under home, plus the parents of recent repos', () => {
    const roots = discoveryRoots('/Users/me', ['/Users/me/clients/acme/app', '/Users/me/dotfiles', '/x'], {});
    expect(roots).toContainEqual({ path: '/Users/me/Projects', depth: 3 });
    expect(roots).toContainEqual({ path: '/Users/me/GitHub', depth: 3 });
    expect(roots).toContainEqual({ path: '/Users/me/clients/acme', depth: 1 });
    // Never the home directory or `/` itself.
    expect(roots.map((r) => r.path)).not.toContain('/Users/me');
    expect(roots.map((r) => r.path)).not.toContain('/');
  });

  it('honours LEGION_DISCOVER_ROOTS and dedupes', () => {
    const roots = discoveryRoots('/Users/me', ['/a/b/one', '/a/b/two'], { LEGION_DISCOVER_ROOTS: '/a:/c' });
    expect(roots).toEqual([
      { path: '/a', depth: 3 },
      { path: '/c', depth: 3 },
      { path: '/a/b', depth: 1 },
    ]);
  });
});

describe('findRepoDirs', () => {
  it('walks depth ≤ 3, stops at checkouts and skips hidden dirs and node_modules', async () => {
    const root = dir.path;
    for (const p of ['top', 'group/mid', 'a/b/deep', 'a/b/c/too-deep', 'node_modules/pkg', '.hidden/secret']) {
      mkdirSync(join(root, p, '.git'), { recursive: true });
    }
    // A nested repo inside a checkout is not reported separately.
    mkdirSync(join(root, 'top', 'vendored', '.git'), { recursive: true });
    // A worktree-style `.git` file counts.
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere\n');

    const found = await findRepoDirs([{ path: root, depth: 3 }], Date.now() + 5000);
    expect(found.map((p) => p.slice(root.length + 1)).sort()).toEqual(['a/b/deep', 'group/mid', 'top', 'wt']);
  });

  it('returns what it has when the deadline has passed, and tolerates missing roots', async () => {
    mkdirSync(join(dir.path, 'r', '.git'), { recursive: true });
    expect(await findRepoDirs([{ path: dir.path, depth: 3 }], Date.now() - 1)).toEqual([]);
    expect(await findRepoDirs([{ path: join(dir.path, 'missing'), depth: 3 }], Date.now() + 5000)).toEqual([]);
  });
});

describe('discoverRepos', () => {
  it('describes each checkout (branch, dirty, last commit) and sorts newest first', async () => {
    const older = makeRepo(join(dir.path, 'Projects', 'older'), 1_700_000_000);
    const newer = makeRepo(join(dir.path, 'Projects', 'client', 'newer'), 1_750_000_000, 'trunk');
    writeFileSync(join(newer, 'README.md'), 'changed\n');
    mkdirSync(join(dir.path, 'Projects', 'empty'));
    git(join(dir.path, 'Projects', 'empty'), ['init', '-q', '-b', 'main']);

    const repos = await discoverRepos({ roots: [{ path: join(dir.path, 'Projects'), depth: 3 }], env: gitEnv });
    expect(repos).toEqual([
      { path: newer, name: 'newer', branch: 'trunk', dirty: true, lastCommitAt: 1_750_000_000_000 },
      { path: older, name: 'older', branch: 'main', dirty: false, lastCommitAt: 1_700_000_000_000 },
      { path: join(dir.path, 'Projects', 'empty'), name: 'empty', branch: null, dirty: false, lastCommitAt: null },
    ]);
    // Read-only: discovery never leaves an index lock or rewrites the index of a dirty checkout.
    expect(git(newer, ['status', '--porcelain', '--untracked-files=no'])).toBe('M README.md');
  });

  it('sortDiscovered puts unknown commit times last, then by name', () => {
    const r = (name: string, lastCommitAt: number | null) => ({
      path: `/x/${name}`,
      name,
      branch: null,
      dirty: false,
      lastCommitAt,
    });
    expect(sortDiscovered([r('b', null), r('a', null), r('c', 5), r('d', 9)]).map((x) => x.name)).toEqual([
      'd',
      'c',
      'a',
      'b',
    ]);
  });
});

describe('DiscoveryCache', () => {
  it('serves a cached scan until refreshed', async () => {
    const projects = join(dir.path, 'Projects');
    makeRepo(join(projects, 'one'), 1_700_000_000);
    const cache = new DiscoveryCache();
    const options = { roots: [{ path: projects, depth: 2 }], env: gitEnv };
    expect((await cache.get(options)).map((r) => r.name)).toEqual(['one']);
    makeRepo(join(projects, 'two'), 1_800_000_000);
    expect((await cache.get(options)).map((r) => r.name)).toEqual(['one']);
    expect((await cache.get(options, true)).map((r) => r.name)).toEqual(['two', 'one']);
  });
});

describe('listBranches', () => {
  it('lists local and remote branches with the default from origin/HEAD', async () => {
    const upstream = makeRepo(join(dir.path, 'upstream'), 1_700_000_000, 'develop');
    git(upstream, ['branch', 'release']);
    const clone = join(dir.path, 'clone');
    git(dir.path, ['clone', '-q', upstream, clone]);
    git(clone, ['checkout', '-q', '-b', 'feature/x']);

    const branches = await listBranches(clone, gitEnv);
    expect(branches.current).toBe('feature/x');
    expect(branches.default).toBe('develop');
    expect([...branches.local].sort()).toEqual(['develop', 'feature/x']);
    expect([...branches.remote].sort()).toEqual(['origin/develop', 'origin/release']);
  });

  it('falls back to main/master, and is empty for a non-repo', async () => {
    const repo = makeRepo(join(dir.path, 'plain'), 1_700_000_000, 'master');
    git(repo, ['checkout', '-q', '-b', 'wip']);
    expect(await listBranches(repo, gitEnv)).toMatchObject({ current: 'wip', default: 'master', remote: [] });
    expect(await listBranches(join(dir.path, 'nope'), gitEnv)).toEqual({
      current: null,
      default: null,
      local: [],
      remote: [],
    });
    mkdirSync(join(dir.path, 'notgit'));
    expect(await listBranches(join(dir.path, 'notgit'), gitEnv)).toMatchObject({ local: [], remote: [] });
  });
});
