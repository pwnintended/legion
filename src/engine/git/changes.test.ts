import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DiffResultSchema } from '@shared/rpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, commitAll, getDiff, parseUnifiedDiff, scopeCheck, touchedPaths } from './changes';
import { git, gitText } from './exec';
import { type FixtureRepo, makeRepo, writeFiles } from './test-helpers';

let repo: FixtureRepo;
afterEach(() => repo.cleanup());

const longText = Array.from({ length: 30 }, (_, i) => `line ${i} of some reasonably long content`).join('\n');

describe('commitAll', () => {
  beforeEach(async () => {
    repo = await makeRepo({ 'a.txt': 'a\n' });
  });

  it('is a no-op on a clean tree and commits everything otherwise', async () => {
    const head = await repo.head();
    expect(await commitAll(repo.path, 'nothing')).toEqual({ committed: false, sha: head });
    writeFiles(repo.path, { 'a.txt': 'changed\n', 'sub/new.txt': 'n\n' });
    const r = await commitAll(repo.path, 'T1: do things\n\nbody');
    expect(r.committed).toBe(true);
    expect(r.sha).not.toBe(head);
    expect(await gitText(repo.path, ['log', '-1', '--format=%B'])).toContain('T1: do things');
    expect(await gitText(repo.path, ['status', '--porcelain'])).toBe('');
  });
});

describe('diffs between refs', () => {
  let base: string;
  let head: string;
  beforeEach(async () => {
    repo = await makeRepo({
      'keep.txt': 'same\n',
      'mod.ts': 'one\ntwo\nthree\nfour\nfive\n',
      'gone.txt': 'to be deleted\nsecond\n',
      'old name.txt': `${longText}\n`,
      'noeol.txt': 'first\nlast without newline',
      'img.bin': Buffer.from([0, 1, 2, 3, 0, 255]),
    });
    base = await repo.head();
    await git(repo.path, ['rm', '-q', 'gone.txt']);
    await git(repo.path, ['mv', 'old name.txt', 'new name.txt']);
    writeFiles(repo.path, {
      'mod.ts': 'one\nTWO\nthree\nfour\nfive\nsix\n',
      'noeol.txt': 'first\nlast without newline CHANGED',
      'img.bin': Buffer.from([0, 9, 9, 9, 0, 255, 1]),
      'added.txt': 'brand\nnew\n',
      'new name.txt': `${longText}\nplus a line\n`,
    });
    head = (await commitAll(repo.path, 'changes')).sha;
  });

  it('lists changed files with statuses and counts', async () => {
    const files = await changedFiles(repo.path, base, head);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by['added.txt']).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 2 });
    expect(by['mod.ts']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(by['new name.txt']).toMatchObject({
      status: 'renamed',
      oldPath: 'old name.txt',
      additions: 1,
      deletions: 0,
    });
    expect(by['img.bin']).toMatchObject({ status: 'modified', binary: true });
    expect(touchedPaths(files)).toContain('old name.txt');
    expect(Object.keys(by)).not.toContain('keep.txt');
  });

  it('parses git diff into the diff.get shape', async () => {
    const result = await getDiff(repo.path, base, head);
    expect(DiffResultSchema.safeParse(result).success).toBe(true);
    const by = Object.fromEntries(result.files.map((f) => [f.path, f]));

    const mod = by['mod.ts'];
    expect(mod?.hunks).toHaveLength(1);
    const lines = mod?.hunks[0]?.lines ?? [];
    expect(lines.find((l) => l.kind === 'del')).toMatchObject({ text: 'two', oldLine: 2, newLine: null });
    expect(lines.filter((l) => l.kind === 'add').map((l) => [l.text, l.newLine])).toEqual([
      ['TWO', 2],
      ['six', 6],
    ]);
    expect(lines[0]).toMatchObject({ kind: 'context', oldLine: 1, newLine: 1, text: 'one' });

    expect(by['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 2, binary: false });
    expect(by['gone.txt']?.hunks[0]?.lines.every((l) => l.kind === 'del')).toBe(true);
    expect(by['added.txt']).toMatchObject({ status: 'added', additions: 2, oldPath: null });

    expect(by['new name.txt']).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', additions: 1 });
    expect(by['img.bin']).toMatchObject({ binary: true, hunks: [], additions: 0 });

    const noeol = by['noeol.txt']?.hunks[0]?.lines ?? [];
    expect(noeol.filter((l) => l.kind === 'no_newline')).toHaveLength(2);
    expect(noeol.find((l) => l.kind === 'no_newline')).toMatchObject({ oldLine: null, newLine: null });
  });

  it('three-dot ranges diff against the merge base', async () => {
    await git(repo.path, ['checkout', '-q', '-b', 'side', base]);
    await repo.commit({ 'side.txt': 's\n' }, 'side');
    await git(repo.path, ['checkout', '-q', 'main']);
    await repo.commit({ 'main-only.txt': 'm\n' }, 'main');
    const files = await changedFiles(repo.path, 'main', 'side', { mergeBase: true });
    expect(files.map((f) => f.path)).toEqual(['side.txt']);
  });

  it('diffs against the working tree when `to` is null', async () => {
    writeFiles(repo.path, { 'keep.txt': 'edited\n' });
    expect((await changedFiles(repo.path, 'HEAD', null)).map((f) => f.path)).toEqual(['keep.txt']);
    rmSync(join(repo.path, 'keep.txt'));
    expect((await getDiff(repo.path, 'HEAD', null)).files[0]?.status).toBe('deleted');
  });
});

describe('parseUnifiedDiff', () => {
  it('flags and drops hunks for very large files but keeps counts', () => {
    const body = Array.from({ length: 50 }, (_, i) => `+l${i}`).join('\n');
    const text = `diff --git a/big.txt b/big.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,50 @@\n${body}\n`;
    const [f] = parseUnifiedDiff(text, { maxChangedLinesPerFile: 10 });
    expect(f).toMatchObject({ path: 'big.txt', status: 'added', additions: 50, truncated: true, hunks: [] });
    const [g] = parseUnifiedDiff(text);
    expect(g?.truncated).toBe(false);
    expect(g?.hunks[0]?.lines).toHaveLength(50);
  });

  it('handles empty input, mode-only changes, spaces in names, hunk headers and content that looks like headers', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    const text = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/sp ace.txt b/sp ace.txt',
      'index 1..2 100644',
      '--- a/sp ace.txt',
      '+++ b/sp ace.txt',
      '@@ -1,2 +1,2 @@ function foo()',
      ' keep',
      '-diff --git a/x b/x',
      '+--- fake header',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['run.sh', 'sp ace.txt']);
    expect(files[0]).toMatchObject({ status: 'modified', hunks: [] });
    expect(files[1]?.hunks[0]?.header).toBe('function foo()');
    expect(files[1]).toMatchObject({ additions: 1, deletions: 1 });
  });
});

describe('scopeCheck', () => {
  it('splits changed paths by declared touches (read globs grant nothing)', () => {
    const r = scopeCheck(
      ['src/engine/git/a.ts', 'src/engine/git/b.test.ts', 'README.md', 'src/shared/x.ts', 'package.json'],
      [
        { glob: 'src/engine/git/**', mode: 'modify' },
        { glob: 'README.md', mode: 'create' },
        { glob: 'src/shared/**', mode: 'read' },
      ],
    );
    expect(r.inScope).toEqual(['README.md', 'src/engine/git/a.ts', 'src/engine/git/b.test.ts']);
    expect(r.outOfScope).toEqual(['package.json', 'src/shared/x.ts']);
  });
});
