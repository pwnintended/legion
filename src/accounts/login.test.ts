import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config.ts';
import {
  describeAccount,
  loginSpec,
  migrateConfigFile,
  nextAccountName,
  prepareLoginDir,
  probeAccount,
  tokenHint,
} from './login.ts';

const config = ConfigSchema.parse({});
let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

describe('loginSpec', () => {
  it('logs a Claude account in with CLAUDE_CONFIG_DIR', () => {
    const s = loginSpec(config, 'claude', 'work', {
      legionHome: '/h',
      processEnv: { A: '1', CLAUDE_CODE_OAUTH_TOKEN: 'x' },
    });
    expect(s).toMatchObject({
      command: 'claude',
      args: ['auth', 'login'],
      dir: '/h/accounts/claude/work',
      tokenTarget: null,
    });
    expect(s.env.CLAUDE_CONFIG_DIR).toBe('/h/accounts/claude/work');
    expect(s.env.A).toBe('1');
    expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  it('runs setup-token for --token and names the token file', () => {
    const s = loginSpec(config, 'claude', 'work', { token: true, legionHome: '/h' });
    expect(s.args).toEqual(['setup-token']);
    expect(s.tokenTarget).toEqual({ file: '/h/accounts/claude/work/oauth-token' });
  });
  it('logs a Codex account in with CODEX_HOME', () => {
    const s = loginSpec(config, 'codex', 'me', { legionHome: '/h', processEnv: {} });
    expect(s).toMatchObject({ command: 'codex', args: ['login'] });
    expect(s.env.CODEX_HOME).toBe('/h/accounts/codex/me');
    expect(() => loginSpec(config, 'codex', 'me', { token: true })).toThrow(/Claude/);
  });
  it('rejects bad names', () => {
    expect(() => loginSpec(config, 'claude', '../x')).toThrow(/valid account name/);
  });
  it('creates the directory 0700', () => {
    tmp = mkdtempSync(join(tmpdir(), 'legion-login-'));
    const s = loginSpec(config, 'claude', 'a', { legionHome: tmp });
    prepareLoginDir(s);
    expect(statSync(s.dir as string).mode & 0o777).toBe(0o700);
  });
});

describe('configured accounts', () => {
  const acc = (extra: object) =>
    ({
      kind: 'claude',
      name: 'work',
      dir: '/ext/work',
      token: null,
      env: {},
      remote: false,
      enabled: true,
      source: 'config',
      ...extra,
    }) as never;
  it('logs in to the configured dir', () => {
    const s = loginSpec(config, 'claude', 'work', { existing: acc({}), legionHome: '/h', processEnv: {} });
    expect(s.dir).toBe('/ext/work');
    expect(s.env.CLAUDE_CONFIG_DIR).toBe('/ext/work');
  });
  it('points --token at the configured tokenFile or tokenEnv', () => {
    const f = loginSpec(config, 'claude', 'work', { existing: acc({ token: { file: '/t/tok' } }), token: true });
    expect(tokenHint(f)).toContain('/t/tok');
    const e = loginSpec(config, 'claude', 'work', { existing: acc({ token: { env: 'WORK_TOK' } }), token: true });
    expect(tokenHint(e)).toContain('WORK_TOK');
  });
  it('names the tokenFile config for an external dir without a token source', () => {
    const s = loginSpec(config, 'claude', 'work', { existing: acc({}), token: true, legionHome: '/h' });
    expect(s.tokenTarget).toMatchObject({ file: '/ext/work/oauth-token' });
    expect(tokenHint(s)).toContain('tokenFile = "/ext/work/oauth-token"');
  });
  it('implies discovery only for the managed dir', () => {
    const s = loginSpec(config, 'claude', 'work', {
      existing: acc({ dir: '/h/accounts/claude/work' }),
      token: true,
      legionHome: '/h',
    });
    expect(tokenHint(s)).not.toContain('tokenFile =');
  });
  it('keeps the inherited CODEX_HOME for a configured account without dir, as the runtime does', () => {
    const s = loginSpec(config, 'codex', 'x', {
      existing: acc({ kind: 'codex', dir: null }),
      processEnv: { CODEX_HOME: '/z' },
    });
    expect(s.dir).toBeNull();
    expect(s.env.CODEX_HOME).toBe('/z');
  });
});

describe('probeAccount', () => {
  it('turns a failing probe (unset tokenEnv, missing tokenFile) into an unknown status', async () => {
    const r = await probeAccount(async () => {
      throw new Error('claude account "w": WORK_TOK is not set');
    });
    expect(r).toMatchObject({ loggedIn: null, problem: expect.stringContaining('WORK_TOK') });
  });
});

describe('names and rows', () => {
  it('picks the next free name', () => {
    expect(nextAccountName('claude', ['claude-1', 'work', 'claude-2'])).toBe('claude-3');
    expect(nextAccountName('codex', [])).toBe('codex-1');
  });
  it('describes cooldown and last use', () => {
    const account = {
      kind: 'claude',
      name: 'w',
      dir: null,
      token: null,
      env: {},
      remote: false,
      enabled: true,
      source: 'config',
    } as const;
    const line = describeAccount(
      {
        account,
        installed: true,
        loggedIn: true,
        cooldownUntil: 2000,
        reason: 'usage limit',
        lastUsed: { at: 500, what: 'run/step' },
      },
      1000,
    );
    expect(line).toContain('claude/w');
    expect(line).toContain('✓ logged in');
    expect(line).toContain('cooling until');
    expect(line).toContain('by run/step');
    expect(
      describeAccount(
        { account, installed: true, loggedIn: false, cooldownUntil: null, reason: null, lastUsed: null },
        1000,
      ),
    ).toContain('not logged in · free · never used');
  });
});

describe('migrateConfigFile', () => {
  it('rewrites profiles into accounts and keeps a .bak', () => {
    tmp = mkdtempSync(join(tmpdir(), 'legion-mig-'));
    const path = join(tmp, 'config.toml');
    const old = '[claude.profiles.work]\n[claude.profiles.work.env]\nCLAUDE_CONFIG_DIR = "/x"\n';
    writeFileSync(path, old);
    const r = migrateConfigFile(path);
    expect(r.changed).toBe(true);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(old);
    expect(readFileSync(path, 'utf8')).toContain('dir = "/x"');
    expect(migrateConfigFile(path).changed).toBe(false);
  });
  it('keeps a 0600 config and its backup private', () => {
    tmp = mkdtempSync(join(tmpdir(), 'legion-mig-'));
    const path = join(tmp, 'config.toml');
    writeFileSync(path, '[claude.profiles.work]\n');
    chmodSync(path, 0o600);
    migrateConfigFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
  });
});
