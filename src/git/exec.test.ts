import { describe, expect, it } from 'vitest';
import { GitError, parsePorcelainZ, runCommand, splitZ } from './exec.ts';

describe('runCommand', () => {
  it('passes input on stdin and keeps output verbatim', async () => {
    const r = await runCommand('cat', process.cwd(), [], { input: 'ignore\nü\n' });
    expect(r).toEqual({ stdout: 'ignore\nü\n', stderr: '', exitCode: 0 });
  });

  it('honours okExitCodes and throws GitError otherwise', async () => {
    expect((await runCommand('sh', process.cwd(), ['-c', 'exit 3'], { okExitCodes: [3] })).exitCode).toBe(3);
    const err = await runCommand('sh', process.cwd(), ['-c', 'echo oops >&2; exit 2']).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toMatchObject({ exitCode: 2, stderr: 'oops\n' });
  });

  it('reports spawn failures, timeouts and aborts with a null exit code', async () => {
    await expect(runCommand('definitely-not-a-binary-xyz', process.cwd(), [])).rejects.toMatchObject({
      exitCode: null,
    });
    await expect(runCommand('sleep', process.cwd(), ['5'], { timeoutMs: 50 })).rejects.toMatchObject({
      exitCode: null,
      stderr: expect.stringMatching(/timed out/),
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(runCommand('sleep', process.cwd(), ['5'], { signal: ac.signal })).rejects.toMatchObject({
      exitCode: null,
    });
  });
});

describe('porcelain parsing', () => {
  it('splits -z records and pairs rename origins', () => {
    expect(splitZ('a\0b\0')).toEqual(['a', 'b']);
    expect(parsePorcelainZ('R  new.txt\0old.txt\0?? u.txt\0 M m.txt\0')).toEqual([
      { xy: 'R ', path: 'new.txt', origPath: 'old.txt' },
      { xy: '??', path: 'u.txt', origPath: null },
      { xy: ' M', path: 'm.txt', origPath: null },
    ]);
  });
});
