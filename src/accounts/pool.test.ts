import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, AccountKind } from './index.ts';
import { AccountPool } from './pool.ts';

let dir: string;
let file: string;
let t: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'legion-pool-')));
  file = join(dir, 'pool.json');
  t = 1_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const acct = (name: string, extra: Partial<Account> = {}): Account => ({
  kind: 'claude',
  name,
  dir: null,
  token: null,
  env: {},
  remote: false,
  enabled: true,
  source: 'config',
  ...extra,
});
const make = (accounts: Account[], f = file) =>
  new AccountPool({ file: f, accounts: (k: AccountKind) => accounts.filter((a) => a.kind === k), now: () => t });
const name = (r: ReturnType<AccountPool['acquire']>) => ('account' in r ? r.account.name : 'exhausted');

describe('AccountPool', () => {
  it('rotates round-robin', () => {
    const pool = make([acct('a'), acct('b'), acct('c')]);
    expect([1, 2, 4].map(() => name(pool.acquire('claude', { what: 'x' })))).toEqual(['a', 'b', 'c']);
    expect(name(pool.acquire('claude', { what: 'x' }))).toBe('a');
  });

  it('skips disabled, avoided and cooling accounts; non-remote ones in a box', () => {
    const pool = make([acct('a', { enabled: false }), acct('b'), acct('c', { remote: true }), acct('d')]);
    pool.cooldown('claude', 'b', t + 1000, 'usage');
    expect(name(pool.acquire('claude', { what: 'x' }))).toBe('c');
    expect(name(pool.acquire('claude', { what: 'x' }))).toBe('d');
    expect(name(pool.acquire('claude', { what: 'x', avoid: ['c', 'd'] }))).toBe('exhausted');
    expect(name(pool.acquire('claude', { what: 'x', where: 'box' }))).toBe('c');
    expect(name(pool.acquire('claude', { what: 'x', where: 'box', avoid: ['c'] }))).toBe('exhausted');
  });

  it('prefer wins when free, not when cooling', () => {
    const pool = make([acct('a'), acct('b')]);
    expect(name(pool.acquire('claude', { what: 'x', prefer: 'b' }))).toBe('b');
    expect(name(pool.acquire('claude', { what: 'x', prefer: 'b' }))).toBe('b');
    pool.cooldown('claude', 'b', t + 10, 'rate');
    expect(name(pool.acquire('claude', { what: 'x', prefer: 'b' }))).toBe('a');
  });

  it('reports the earliest reset when exhausted; expired cooldowns are free', () => {
    const pool = make([acct('a'), acct('b')]);
    pool.cooldown('claude', 'a', t + 500, 'usage');
    pool.cooldown('claude', 'b', t + 200, 'usage');
    expect(pool.acquire('claude', { what: 'x' })).toEqual({ exhausted: true, earliestReset: t + 200 });
    t += 300;
    expect(name(pool.acquire('claude', { what: 'x' }))).toBe('b');
    expect(pool.status('claude').map((s) => s.cooldownUntil)).toEqual([t + 200, null]);
  });

  it('clears cooldowns of one account or a kind', () => {
    const pool = make([acct('a'), acct('b'), acct('x', { kind: 'codex' })]);
    for (const [k, n] of [
      ['claude', 'a'],
      ['claude', 'b'],
      ['codex', 'x'],
    ] as const)
      pool.cooldown(k, n, t + 999, 'r');
    pool.clear('claude', 'a');
    expect(pool.status('claude').map((s) => s.cooldownUntil)).toEqual([null, t + 999]);
    pool.clear('claude');
    expect(pool.status('claude').map((s) => s.reason)).toEqual([null, null]);
    expect(pool.status('codex')[0]?.cooldownUntil).toBe(t + 999);
  });

  it('persists across instances, with last use', () => {
    const accounts = [acct('a'), acct('b')];
    make(accounts).acquire('claude', { what: 'step one' });
    make(accounts).cooldown('claude', 'a', t + 5000, 'usage limit');
    const after = make(accounts);
    expect(after.status('claude')[0]).toMatchObject({
      cooldownUntil: t + 5000,
      reason: 'usage limit',
      lastUsed: { at: t, what: 'step one' },
    });
    expect(name(after.acquire('claude', { what: 'x' }))).toBe('b');
  });

  it('recovers from a corrupt file and takes over a stale lock', () => {
    writeFileSync(file, '{not json');
    writeFileSync(`${file}.lock.1`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock.1`, old, old);
    expect(name(make([acct('a')]).acquire('claude', { what: 'x' }))).toBe('a');
  });

  it('keeps the file intact under concurrent acquires from several processes', () => {
    const script = join(dir, 'worker.mts');
    const poolUrl = new URL('./pool.ts', import.meta.url).href;
    writeFileSync(
      script,
      `import { AccountPool } from ${JSON.stringify(poolUrl)};
const a = (n) => ({ kind: 'claude', name: n, dir: null, token: null, env: {}, remote: false, enabled: true, source: 'config' });
const pool = new AccountPool({ file: process.argv[2], accounts: () => [a('a'), a('b')] });
for (let i = 0; i < 25; i++) {
  pool.acquire('claude', { what: 'w' + process.argv[3] });
  pool.cooldown('claude', 'w' + process.argv[3], i, 'r');
}
`,
    );
    const run = (id: string) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--experimental-strip-types', script, file, id], { stdio: 'inherit' });
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`worker exit ${c}`))));
      });
    return Promise.all([run('1'), run('2'), run('3')]).then(() => {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      // a lost update would drop a worker's final write
      expect(state.version).toBe(1);
      expect(Object.keys(state.accounts).sort()).toEqual([
        'claude/a',
        'claude/b',
        'claude/w1',
        'claude/w2',
        'claude/w3',
      ]);
      for (const id of ['w1', 'w2', 'w3']) expect(state.accounts[`claude/${id}`].cooldownUntil).toBe(24);
    });
  }, 60_000);
});
