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

  it('a delayed former owner cannot release its successor', () => {
    const first = acquireLock(path);
    age(`${path}.1`);
    const second = acquireLock(path);
    first(); // wakes up late
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
    second();
    acquireLock(path, { waitMs: 50 })();
  });

  it('a contender that saw a stale generation loses to the one that already took over', () => {
    writeFileSync(`${path}.1`, 'dead-owner');
    age(`${path}.1`);
    writeFileSync(`${path}.2`, 'taker'); // another reclaimer won generation 2 meanwhile
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
    expect(existsSync(`${path}.2`)).toBe(true);
  });

  it('a released lock is taken at the next generation and numbers never go back', () => {
    acquireLock(path)();
    const release = acquireLock(path);
    expect(existsSync(`${path}.2`)).toBe(true);
    release();
    expect(existsSync(`${path}.2.released`)).toBe(true);
    expect(existsSync(`${path}.1.released`)).toBe(false);
  });

  it('a former owner resumed after takeover does not disturb the successor, even after the successor releases', () => {
    const first = acquireLock(path);
    age(`${path}.1`);
    const second = acquireLock(path);
    second();
    const third = acquireLock(path);
    first(); // late release of generation 1, long gone
    expect(() => acquireLock(path, { waitMs: 50 })).toThrow(/locked/);
    third();
  });

  it('competing reclaimers of a stale lock never overlap', async () => {
    writeFileSync(`${path}.1`, 'dead-owner');
    age(`${path}.1`);
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
