import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAll } from './changes';
import { git, gitText } from './exec';
import {
  abortMerge,
  finishMerge,
  forecastMerge,
  IntegrationError,
  isMergeInProgress,
  mergeIntoTaskBranch,
  resetIntegration,
  resolveLockfileConflicts,
  squashMergeIntoIntegration,
  unmergedFiles,
} from './integration';
import { push } from './remote';
import { isDirty } from './repo';
import { type FixtureRepo, makeBare, makeRepo, writeFiles } from './test-helpers';
import { createWorktree } from './worktrees';

let repo: FixtureRepo;
let integ: string;
let baseSha: string;

beforeEach(async () => {
  repo = await makeRepo({
    'shared.txt': 'one\ntwo\nthree\n',
    'pnpm-lock.yaml': 'lock: base\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  baseSha = await repo.head();
  integ = join(repo.scratch, 'wt', '_integration');
  await createWorktree({ repo: repo.path, path: integ, branch: 'legion/r/integration', startSha: baseSha });
});
afterEach(() => repo.cleanup());

async function taskWorktree(
  id: string,
  files: Record<string, string>,
  start = baseSha,
): Promise<{ path: string; branch: string }> {
  const path = join(repo.scratch, 'wt', id);
  const branch = `legion/r/${id}`;
  await createWorktree({ repo: repo.path, path, branch, startSha: start });
  writeFiles(path, files);
  await commitAll(path, `${id} work`);
  return { path, branch };
}

describe('forecastMerge', () => {
  it('reports clean merges with a result tree', async () => {
    const t = await taskWorktree('T1', { 'src/b.ts': 'b\n' });
    const f = await forecastMerge(repo.path, 'legion/r/integration', t.branch);
    expect(f.clean).toBe(true);
    expect(f.conflictFiles).toEqual([]);
    expect(f.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('agrees with an actual merge on conflicts and on the resulting tree', async () => {
    const t1 = await taskWorktree('T1', { 'shared.txt': 'one\nTWO-from-T1\nthree\n', 'x.txt': 'x1\n' });
    const t2 = await taskWorktree('T2', { 'shared.txt': 'one\nTWO-from-T2\nthree\n', 'y.txt': 'y\n' });

    const merged1 = await squashMergeIntoIntegration(integ, t1.branch, 'T1: first');
    expect(merged1).toMatchObject({ ok: true, empty: false });

    // forecast of integration (with T1) vs T2 must predict the conflict that the real merge hits
    const forecast = await forecastMerge(repo.path, 'legion/r/integration', t2.branch);
    expect(forecast.clean).toBe(false);
    expect(forecast.conflictFiles).toEqual(['shared.txt']);

    const real = await squashMergeIntoIntegration(integ, t2.branch, 'T2: second');
    expect(real).toMatchObject({ ok: false, conflict: true });
    if (!real.ok) expect(real.files).toEqual(forecast.conflictFiles);

    // clean case: tree equality between forecast and real merge commit
    const t3 = await taskWorktree('T3', { 'z.txt': 'z\n' });
    const f3 = await forecastMerge(repo.path, 'legion/r/integration', t3.branch);
    expect(f3.clean).toBe(true);
    const real3 = await squashMergeIntoIntegration(integ, t3.branch, 'T3: third');
    expect(real3.ok).toBe(true);
    if (real3.ok) {
      expect(await gitText(integ, ['rev-parse', `${real3.mergedSha}^{tree}`])).toBe(f3.tree);
    }
  });
});

describe('squashMergeIntoIntegration', () => {
  it('squashes into one commit, records pre-merge sha, parent is the old tip', async () => {
    const t = await taskWorktree('T1', { 'src/b.ts': 'b\n' });
    await commitAll(t.path, 'noop');
    writeFiles(t.path, { 'src/c.ts': 'c\n' });
    await commitAll(t.path, 'second agent commit');
    const pre = await gitText(integ, ['rev-parse', 'HEAD']);
    const r = await squashMergeIntoIntegration(integ, t.branch, 'T1: add b and c');
    expect(r).toMatchObject({ ok: true, preMergeSha: pre, empty: false });
    if (!r.ok) throw new Error('unreachable');
    expect(await gitText(integ, ['rev-parse', 'HEAD'])).toBe(r.mergedSha);
    expect(await gitText(integ, ['rev-parse', `${r.mergedSha}^`])).toBe(pre);
    expect(await gitText(integ, ['log', '-1', '--format=%s'])).toBe('T1: add b and c');
    expect(await gitText(integ, ['rev-list', '--count', `${pre}..${r.mergedSha}`])).toBe('1');
    expect(await isDirty(integ)).toBe(false);
  });

  it('conflict leaves the worktree clean and at the pre-merge sha', async () => {
    const a = await taskWorktree('T1', { 'shared.txt': 'one\nA\nthree\n' });
    const b = await taskWorktree('T2', { 'shared.txt': 'one\nB\nthree\n', 'extra.txt': 'e\n' });
    await squashMergeIntoIntegration(integ, a.branch, 'T1');
    const pre = await gitText(integ, ['rev-parse', 'HEAD']);
    const r = await squashMergeIntoIntegration(integ, b.branch, 'T2');
    expect(r).toMatchObject({ ok: false, conflict: true, files: ['shared.txt'], preMergeSha: pre });
    expect(await gitText(integ, ['rev-parse', 'HEAD'])).toBe(pre);
    expect(await isDirty(integ)).toBe(false);
    expect(await isMergeInProgress(integ)).toBe(false);
    expect(readFileSync(join(integ, 'shared.txt'), 'utf8')).toBe('one\nA\nthree\n');
  });

  it('empty task and dirty worktree', async () => {
    const t = await taskWorktree('T1', {});
    const empty = await squashMergeIntoIntegration(integ, t.branch, 'T1');
    expect(empty).toMatchObject({ ok: true, empty: true });
    writeFiles(integ, { 'dirty.txt': 'x' });
    const t2 = await taskWorktree('T2', { 'q.txt': 'q' });
    await expect(squashMergeIntoIntegration(integ, t2.branch, 'T2')).rejects.toBeInstanceOf(IntegrationError);
  });

  it('cleanFirst discards Legion leftovers but keeps provisioned and ignored files', async () => {
    writeFiles(integ, { '.gitignore': 'node_modules/\n' });
    await commitAll(integ, 'Add a gitignore');
    writeFiles(integ, {
      'verify-stamp.txt': 'x',
      'shared.txt': 'reformatted\n',
      '.env.local': 'S=1',
      'node_modules/dep/index.js': '',
    });
    const t = await taskWorktree('T1', { 'q.txt': 'q' });
    const r = await squashMergeIntoIntegration(integ, t.branch, 'T1', { cleanFirst: ['.env.local'] });
    expect(r).toMatchObject({ ok: true, empty: false });
    expect(await gitText(integ, ['show', '--name-only', '--format=', 'HEAD'])).toBe('q.txt');
    expect(await gitText(integ, ['status', '--porcelain', '--untracked-files=all'])).toBe('?? .env.local');
    expect(readFileSync(join(integ, 'node_modules/dep/index.js'), 'utf8')).toBe('');
  });

  it('resetIntegration rolls back to the recorded sha and removes untracked files', async () => {
    const t = await taskWorktree('T1', { 'src/b.ts': 'b\n' });
    const r = await squashMergeIntoIntegration(integ, t.branch, 'T1');
    if (!r.ok) throw new Error('unreachable');
    writeFiles(integ, { 'junk.txt': 'x', 'src/a.ts': 'mutated\n' });
    await resetIntegration(integ, r.preMergeSha);
    expect(await gitText(integ, ['rev-parse', 'HEAD'])).toBe(r.preMergeSha);
    expect(await isDirty(integ)).toBe(false);
    expect(await gitText(integ, ['ls-files'])).not.toContain('src/b.ts');
    // and the same task can be merged again afterwards
    expect((await squashMergeIntoIntegration(integ, t.branch, 'T1 again')).ok).toBe(true);
  });
});

describe('mergeIntoTaskBranch', () => {
  it('fast-forwards / merges cleanly and reports up_to_date', async () => {
    const t = await taskWorktree('T1', { 'own.txt': 'own\n' });
    const other = await taskWorktree('T2', { 'other.txt': 'o\n' });
    await squashMergeIntoIntegration(integ, other.branch, 'T2');
    const r = await mergeIntoTaskBranch(t.path, 'legion/r/integration');
    expect(r.status).toBe('merged');
    expect(await gitText(t.path, ['ls-files'])).toContain('other.txt');
    expect((await mergeIntoTaskBranch(t.path, 'legion/r/integration')).status).toBe('up_to_date');
  });

  it('leaves conflicts with markers in place, then finishMerge enforces resolution', async () => {
    const t = await taskWorktree('T1', { 'shared.txt': 'one\nMINE\nthree\n', 'pnpm-lock.yaml': 'lock: task\n' });
    const other = await taskWorktree('T2', { 'shared.txt': 'one\nTHEIRS\nthree\n', 'pnpm-lock.yaml': 'lock: integ\n' });
    await squashMergeIntoIntegration(integ, other.branch, 'T2');

    const r = await mergeIntoTaskBranch(t.path, 'legion/r/integration');
    expect(r).toEqual({ status: 'conflict', files: ['pnpm-lock.yaml', 'shared.txt'] });
    expect(await isMergeInProgress(t.path)).toBe(true);
    expect(readFileSync(join(t.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');

    // lockfile policy: take theirs (integration) for the lockfile only
    const lock = await resolveLockfileConflicts(t.path, ['pnpm-lock.yaml', 'shared.txt'], 'theirs');
    expect(lock).toEqual({ resolved: ['pnpm-lock.yaml'], remaining: ['shared.txt'] });
    expect(readFileSync(join(t.path, 'pnpm-lock.yaml'), 'utf8')).toBe('lock: integ\n');
    expect(await unmergedFiles(t.path)).toEqual(['shared.txt']);

    // markers still present -> refuse
    await git(t.path, ['add', 'shared.txt']);
    await expect(finishMerge(t.path)).rejects.toThrow(/conflict markers/);

    writeFiles(t.path, { 'shared.txt': 'one\nMINE+THEIRS\nthree\n' });
    const done = await finishMerge(t.path, 'Merge integration into T1');
    expect(await gitText(t.path, ['rev-parse', 'HEAD'])).toBe(done.sha);
    expect(await gitText(t.path, ['rev-list', '--parents', '-n1', 'HEAD'])).toMatch(/^\w{40} \w{40} \w{40}$/);
    expect(await isMergeInProgress(t.path)).toBe(false);

    // after resolution the task merges cleanly into integration
    expect((await forecastMerge(repo.path, 'legion/r/integration', t.branch)).clean).toBe(true);
    expect((await squashMergeIntoIntegration(integ, t.branch, 'T1')).ok).toBe(true);
  });

  it('replays a recorded resolution (rerere per command) without writing repo config', async () => {
    const t = await taskWorktree('T1', { 'shared.txt': 'one\nMINE\nthree\n' });
    const other = await taskWorktree('T2', { 'shared.txt': 'one\nTHEIRS\nthree\n' });
    await squashMergeIntoIntegration(integ, other.branch, 'T2');
    const before = await gitText(t.path, ['rev-parse', 'HEAD']);
    expect((await mergeIntoTaskBranch(t.path, 'legion/r/integration')).status).toBe('conflict');
    writeFiles(t.path, { 'shared.txt': 'one\nBOTH\nthree\n' });
    await finishMerge(t.path, 'resolved');
    await git(t.path, ['reset', '-q', '--hard', before]);

    const again = await mergeIntoTaskBranch(t.path, 'legion/r/integration');
    expect(again.status).toBe('conflict'); // rerere resolves the content but leaves the path unmerged
    expect(readFileSync(join(t.path, 'shared.txt'), 'utf8')).toBe('one\nBOTH\nthree\n');
    await abortMerge(t.path);
    expect((await git(repo.path, ['config', '--local', 'rerere.enabled'], { okExitCodes: [1] })).exitCode).toBe(1);
  });

  it('abortMerge restores the task branch', async () => {
    const t = await taskWorktree('T1', { 'shared.txt': 'one\nMINE\nthree\n' });
    const other = await taskWorktree('T2', { 'shared.txt': 'one\nTHEIRS\nthree\n' });
    await squashMergeIntoIntegration(integ, other.branch, 'T2');
    const before = await gitText(t.path, ['rev-parse', 'HEAD']);
    await mergeIntoTaskBranch(t.path, 'legion/r/integration');
    await abortMerge(t.path);
    expect(await gitText(t.path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await isDirty(t.path)).toBe(false);
  });

  it('refuses a dirty task worktree before touching anything', async () => {
    const t = await taskWorktree('T1', { 'a1.txt': '1' });
    writeFiles(t.path, { 'wip.txt': 'wip' });
    await expect(mergeIntoTaskBranch(t.path, 'legion/r/integration')).rejects.toBeInstanceOf(IntegrationError);
  });
});

describe('push', () => {
  it('pushes a branch to a local bare remote and sets upstream', async () => {
    const bare = await makeBare(repo.scratch);
    await git(repo.path, ['remote', 'add', 'origin', bare]);
    const t = await taskWorktree('T1', { 'p.txt': 'p\n' });
    await squashMergeIntoIntegration(integ, t.branch, 'T1');
    await push(repo.path, 'legion/r/integration');
    expect(await gitText(bare, ['rev-parse', 'refs/heads/legion/r/integration'])).toBe(
      await gitText(integ, ['rev-parse', 'HEAD']),
    );
    expect(await gitText(integ, ['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/legion/r/integration');
  });

  it('fails with GitError for a missing remote', async () => {
    await expect(push(repo.path, 'main')).rejects.toThrow(/origin/);
  });
});
