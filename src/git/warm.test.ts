import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from './exec.ts';
import { type FixtureRepo, makeRepo } from './test-helpers.ts';
import { checkDiskSpace, DiskSpaceError, findCacheDirs, freeGb, warmWorktree } from './warm.ts';
import { createWorktree } from './worktrees.ts';

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await makeRepo({
    'README.md': '# r\n',
    '.gitignore': '/target/\ngame/.godot/\nnode_modules/\n',
    'game/project.godot': '',
  });
  for (const dir of ['target/debug', 'game/.godot/imported', 'node_modules/x'])
    mkdirSync(join(repo.path, dir), { recursive: true });
  writeFileSync(join(repo.path, 'target/debug/lib.rlib'), 'built');
  writeFileSync(join(repo.path, 'game/.godot/imported/a.ctex'), 'imported');
  // A tracked directory called target is not a cache.
  mkdirSync(join(repo.path, 'docs/target'), { recursive: true });
  writeFileSync(join(repo.path, 'docs/target/notes.md'), 'tracked');
  await git(repo.path, ['add', 'docs']);
  await git(repo.path, ['commit', '-qm', 'docs']);
});

afterEach(() => repo.cleanup());

describe('warm worktrees', () => {
  it('finds the ignored build caches', async () => {
    expect((await findCacheDirs(repo.path)).sort()).toEqual(['game/.godot', 'node_modules', 'target']);
  });

  it('clones the caches into a new worktree and runs the setup commands', async () => {
    const path = join(repo.path, '..', 'wt');
    const head = (await git(repo.path, ['rev-parse', 'HEAD'])).stdout.trim();
    await createWorktree({ repo: repo.path, path, branch: 'w', startSha: head });
    const result = await warmWorktree(repo.path, path, { clone: null, setup: ['echo ok > setup.txt'], minFreeGb: 0 });
    if (process.platform === 'darwin') {
      expect(result.cloned.sort()).toEqual(['game/.godot', 'node_modules', 'target']);
      expect(readFileSync(join(path, 'target/debug/lib.rlib'), 'utf8')).toBe('built');
      expect(readFileSync(join(path, 'game/.godot/imported/a.ctex'), 'utf8')).toBe('imported');
    }
    expect(existsSync(join(path, 'setup.txt'))).toBe(true);
    // Configured: only those.
    const other = join(repo.path, '..', 'wt2');
    await createWorktree({ repo: repo.path, path: other, branch: 'w2', startSha: head });
    const only = await warmWorktree(repo.path, other, { clone: ['game/.godot'], setup: [], minFreeGb: 0 });
    expect(existsSync(join(other, 'target'))).toBe(false);
    if (process.platform === 'darwin') expect(only.cloned).toEqual(['game/.godot']);
  });

  it('refuses a new worktree when the disk is nearly full', async () => {
    expect(await freeGb(repo.path)).toBeGreaterThan(0);
    await expect(checkDiskSpace(repo.path, 1e9)).rejects.toBeInstanceOf(DiskSpaceError);
    await expect(checkDiskSpace(join(repo.path, 'not/yet/there'), 0)).resolves.toBeUndefined();
  });
});
