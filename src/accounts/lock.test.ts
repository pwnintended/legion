import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from './lock.ts';

let dir: string;
let path: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'legion-lock-')));
  path = join(dir, 'x.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const age = (p: string) => {
  const old = new Date(Date.now() - 60_000);
  utimesSync(p, old, old);
};

describe('acquireLock', () => {
  it('excludes a second holder until release', () => {
    const release = acquireLock(path);
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
    release();
    acquireLock(path, { waitMs: 50 })();
  });

  it('takes over a lock whose owner process is gone', () => {
    writeFileSync(path, '999999999 dead-owner');
    const release = acquireLock(path, { waitMs: 50 });
    expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^${process.pid} `));
    release();
    expect(existsSync(path)).toBe(false);
  });

  it('takes over a live owner only once its lock is older than staleMs', () => {
    writeFileSync(path, `${process.pid} stalled`);
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
    age(path);
    acquireLock(path, { waitMs: 50 })();
  });

  it('a lock whose token is not written yet is not stale', () => {
    writeFileSync(path, '');
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
  });

  it('a former owner that wakes up after a takeover does not release its successor', () => {
    const first = acquireLock(path);
    age(path);
    const second = acquireLock(path, { staleMs: 1_000 });
    first(); // late: the lock is the successor's now
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
    second();
    acquireLock(path, { waitMs: 50 })();
  });

  it('competing reclaimers of a stale lock never overlap', async () => {
    writeFileSync(path, '999999999 dead-owner');
    const counter = join(dir, 'counter');
    writeFileSync(counter, '0');
    const script = join(dir, 'w.mts');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
import { acquireLock } from ${JSON.stringify(new URL('./lock.ts', import.meta.url).href)};
for (let i = 0; i < 30; i++) {
  const release = acquireLock(process.argv[2]);
  const n = Number(readFileSync(process.argv[3], 'utf8'));
  writeFileSync(process.argv[3], String(n + 1));
  release();
}
`,
    );
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--experimental-strip-types', script, path, counter], { stdio: 'inherit' });
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`worker exit ${c}`))));
      });
    await Promise.all([run(), run(), run(), run()]);
    expect(readFileSync(counter, 'utf8')).toBe('120'); // a lost update means two holders overlapped
  }, 60_000);
});
