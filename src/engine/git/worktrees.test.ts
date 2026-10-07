import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, git, gitText, repoKey, withRepoLock } from './exec';
import { branchExists, currentBranch, defaultBranch, ghStatus, isDirty, isRepo, remotes, toplevel } from './repo';
import { type FixtureRepo, makeBare, makeRepo, writeFiles } from './test-helpers';
import {
  createWorktree,
  disableAutoGc,
  integrationBranchName,
  integrationWorktreePath,
  listWorktrees,
  reconcile,
  removeWorktree,
  repoHash,
  restoreGcAuto,
  taskBranchName,
  taskWorktreePath,
} from './worktrees';

let repo: FixtureRepo;
beforeEach(async () => {
  repo = await makeRepo({ 'a.txt': 'a\n' });
});
afterEach(() => repo.cleanup());

describe('repo info', () => {
  it('detects repos, toplevel, branch, remotes, dirtiness', async () => {
    expect(await isRepo(repo.path)).toBe(true);
    expect(await isRepo(repo.scratch)).toBe(false);
    expect(await toplevel(repo.path)).toBe(repo.path);
    expect(await currentBranch(repo.path)).toBe('main');
    expect(await defaultBranch(repo.path)).toBe('main');
    expect(await remotes(repo.path)).toEqual([]);
    expect(await isDirty(repo.path)).toBe(false);
    writeFiles(repo.path, { 'new.txt': 'x' });
    expect(await isDirty(repo.path)).toBe(true);
  });

  it('default branch prefers origin/HEAD', async () => {
    const bare = await makeBare(repo.scratch);
    await git(repo.path, ['remote', 'add', 'origin', bare]);
    await git(repo.path, ['push', '-q', 'origin', 'main']);
    await git(repo.path, ['branch', 'trunk']);
    await git(repo.path, ['push', '-q', 'origin', 'trunk']);
    await git(repo.path, ['remote', 'set-head', 'origin', 'trunk']);
    expect(await defaultBranch(repo.path)).toBe('trunk');
    expect((await remotes(repo.path))[0]?.name).toBe('origin');
  });

  it('GitError carries exit code and stderr', async () => {
    const err = await git(repo.path, ['rev-parse', '--verify', 'nope^{commit}']).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).toBe(128);
    expect((err as GitError).stderr).toMatch(/nope|fatal|Needed a single revision/i);
  });

  it('ghStatus never throws', async () => {
    const s = await ghStatus(repo.path);
    expect(typeof s.available).toBe('boolean');
  });
});

describe('naming', () => {
  it('follows architecture §9', () => {
    const runId = 'run_k3x9a0q2m7bz';
    expect(integrationBranchName(runId)).toBe('legion/k3x9a0q2/integration');
    expect(taskBranchName(runId, 'T3', 'Add the Login Form!')).toBe('legion/k3x9a0q2/T3-add-the-login-form');
    expect(taskWorktreePath('/h', 'abc', runId, 'T3')).toBe(`/h/worktrees/abc/${runId}/T3`);
    expect(integrationWorktreePath('/h', 'abc', runId)).toBe(`/h/worktrees/abc/${runId}/_integration`);
    expect(repoHash('/x/y')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('worktree lifecycle', () => {
  it('creates a locked worktree on a new branch from a start sha, lists it, removes it and its branch', async () => {
    const start = await repo.head();
    await repo.commit({ 'b.txt': 'b\n' });
    const path = join(repo.scratch, 'home', 'wt1');
    await createWorktree({ repo: repo.path, path, branch: 'legion/x/T1-a', startSha: start });

    expect(existsSync(join(path, 'a.txt'))).toBe(true);
    expect(existsSync(join(path, 'b.txt'))).toBe(false); // started from the older sha
    expect(await gitText(path, ['rev-parse', 'HEAD'])).toBe(start);
    // No repository config is written (rerere is enabled per merge command).
    expect((await git(repo.path, ['config', '--local', 'rerere.enabled'], { okExitCodes: [1] })).exitCode).toBe(1);

    const list = await listWorktrees(repo.path);
    expect(list).toHaveLength(2);
    const wt = list.find((w) => w.branch === 'legion/x/T1-a');
    expect(wt?.locked).toBe(true);
    expect(wt?.lockReason).toBe('legion');
    expect(wt?.head).toBe(start);

    await removeWorktree({ repo: repo.path, path, branch: 'legion/x/T1-a' });
    expect(existsSync(path)).toBe(false);
    expect(await branchExists(repo.path, 'legion/x/T1-a')).toBe(false);
    expect(await listWorktrees(repo.path)).toHaveLength(1);
  });

  it('removes dirty worktrees with force, and is idempotent', async () => {
    const path = join(repo.scratch, 'wt');
    await createWorktree({ repo: repo.path, path, branch: 'b1', startSha: await repo.head() });
    writeFiles(path, { 'dirty.txt': 'x' });
    await git(path, ['add', 'dirty.txt']);
    await removeWorktree({ repo: repo.path, path, branch: 'b1' });
    await removeWorktree({ repo: repo.path, path, branch: 'b1' });
    expect(existsSync(path)).toBe(false);
  });

  it('removes only its own entry: a user worktree whose directory is missing is not pruned', async () => {
    const sha = await repo.head();
    const user = join(repo.scratch, 'external-volume', 'user-wt');
    await git(repo.path, ['worktree', 'add', '-q', '-b', 'user-branch', user, sha]);
    rmSync(user, { recursive: true, force: true }); // e.g. an unmounted volume
    const ours = join(repo.scratch, 'home', 'ours');
    await createWorktree({ repo: repo.path, path: ours, branch: 'legion/x/T9', startSha: sha });
    rmSync(ours, { recursive: true, force: true });

    await removeWorktree({ repo: repo.path, path: ours, branch: 'legion/x/T9' });
    const paths = (await listWorktrees(repo.path)).map((w) => w.branch);
    expect(paths).toEqual(['main', 'user-branch']);
    expect(await branchExists(repo.path, 'legion/x/T9')).toBe(false);
  });

  it('createWorktree fails cleanly if the branch exists, unless resetBranch', async () => {
    const sha = await repo.head();
    const p1 = join(repo.scratch, 'w1');
    const p2 = join(repo.scratch, 'w2');
    await createWorktree({ repo: repo.path, path: p1, branch: 'dup', startSha: sha });
    await expect(createWorktree({ repo: repo.path, path: p2, branch: 'dup', startSha: sha })).rejects.toBeInstanceOf(
      GitError,
    );
    expect(existsSync(p2)).toBe(false);
    await removeWorktree({ repo: repo.path, path: p1 });
    await createWorktree({ repo: repo.path, path: p2, branch: 'dup', startSha: sha, resetBranch: true });
    expect(existsSync(p2)).toBe(true);
  });

  it('gc.auto can be disabled and restored', async () => {
    const prev = await disableAutoGc(repo.path);
    expect(prev).toBeNull();
    expect(await gitText(repo.path, ['config', 'gc.auto'])).toBe('0');
    await restoreGcAuto(repo.path, prev);
    expect((await git(repo.path, ['config', '--local', 'gc.auto'], { okExitCodes: [1] })).exitCode).toBe(1);
    await git(repo.path, ['config', '--local', 'gc.auto', '50']);
    const prev2 = await disableAutoGc(repo.path);
    expect(prev2).toBe('50');
    await restoreGcAuto(repo.path, prev2);
    expect(await gitText(repo.path, ['config', 'gc.auto'])).toBe('50');
  });
});

describe('reconcile', () => {
  it('reports missing and orphaned worktrees', async () => {
    const sha = await repo.head();
    const root = join(repo.scratch, 'home', 'worktrees');
    const kept = join(root, 'k');
    const orphan = join(root, 'o');
    const gone = join(root, 'g');
    const userOwn = join(repo.scratch, 'user-wt');
    for (const [p, b] of [
      [kept, 'kept'],
      [orphan, 'orphan'],
      [gone, 'gone'],
    ] as const) {
      await createWorktree({ repo: repo.path, path: p, branch: b, startSha: sha });
    }
    await createWorktree({ repo: repo.path, path: userOwn, branch: 'user', startSha: sha, lockReason: null });
    rmSync(gone, { recursive: true, force: true });

    const r = await reconcile(
      repo.path,
      [
        { path: kept, branch: 'kept' },
        { path: gone, branch: 'gone' },
        { path: join(root, 'never-created'), branch: 'x' },
      ],
      { managedRoot: root },
    );
    expect(r.present.map((w) => w.branch)).toEqual(['kept']);
    expect(r.missing.map((m) => m.branch).sort()).toEqual(['gone', 'x']);
    // the user's own worktree is outside managedRoot and so not reported; the missing 'gone' dir isn't orphaned
    expect(r.orphaned.map((w) => w.branch).sort()).toEqual(['orphan']);
  });

  it('flags a worktree on the wrong branch as missing', async () => {
    const p = join(repo.scratch, 'w');
    await createWorktree({ repo: repo.path, path: p, branch: 'actual', startSha: await repo.head() });
    const r = await reconcile(repo.path, [{ path: p, branch: 'expected' }]);
    expect(r.missing).toHaveLength(1);
  });
});

describe('mutex', () => {
  it('serializes critical sections across a repo and its worktrees', async () => {
    const wt = join(repo.scratch, 'wt');
    await createWorktree({ repo: repo.path, path: wt, branch: 'm', startSha: await repo.head() });
    await Promise.all([repoKey(repo.path), repoKey(wt)]); // FIFO order is only defined once keys are cached
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const section = (name: string, where: string, ms: number) =>
      withRepoLock(where, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        active--;
      });
    await Promise.all([section('a', repo.path, 40), section('b', wt, 10), section('c', repo.path, 1)]);
    expect(maxActive).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('releases the lock when the section throws', async () => {
    await expect(withRepoLock(repo.path, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withRepoLock(repo.path, async () => 'ok')).toBe('ok');
  });

  it('parallel worktree creation does not collide', async () => {
    const sha = await repo.head();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createWorktree({ repo: repo.path, path: join(repo.scratch, `p${i}`), branch: `par/${i}`, startSha: sha }),
      ),
    );
    expect(await listWorktrees(repo.path)).toHaveLength(7);
  });
});
