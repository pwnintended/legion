import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, ConfigSchema } from '../config.ts';
import { type Account, accountEnv, accountsDir, listAccounts } from './index.ts';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'legion-accounts-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cfg = (accounts: unknown = {}) => ConfigSchema.parse({ accounts });

describe('listAccounts', () => {
  it('is the implicit default without accounts', () => {
    expect(listAccounts(cfg(), 'claude', { legionHome: home })).toEqual([
      {
        kind: 'claude',
        name: 'default',
        dir: null,
        token: null,
        env: {},
        remote: false,
        enabled: true,
        source: 'implicit',
      },
    ]);
  });

  it('discovers account directories and the claude token file', () => {
    mkdirSync(join(accountsDir('claude', home), 'a'), { recursive: true });
    mkdirSync(join(accountsDir('claude', home), 'b'), { recursive: true });
    writeFileSync(join(accountsDir('claude', home), 'b', 'oauth-token'), 'tok\n');
    writeFileSync(join(accountsDir('claude', home), 'stray-file'), '');
    mkdirSync(join(accountsDir('codex', home), 'c'), { recursive: true });
    const claude = listAccounts(cfg(), 'claude', { legionHome: home });
    expect(claude.map((a) => [a.name, a.source, a.remote])).toEqual([
      ['a', 'discovered', false],
      ['b', 'discovered', true],
    ]);
    expect(claude[1]?.token).toEqual({ file: join(accountsDir('claude', home), 'b', 'oauth-token') });
    expect(listAccounts(cfg(), 'codex', { legionHome: home }).map((a) => a.name)).toEqual(['c']);
  });

  it('config entries override discovered ones field by field and add new ones', () => {
    mkdirSync(join(accountsDir('claude', home), 'a'), { recursive: true });
    const list = listAccounts(
      cfg({ claude: { a: { enabled: false, tokenEnv: 'TOK', remote: false }, w: { dir: '~/x', env: { K: '~/v' } } } }),
      'claude',
      { legionHome: home },
    );
    const [a, w] = list as [Account, Account];
    expect(a).toMatchObject({
      dir: join(accountsDir('claude', home), 'a'),
      enabled: false,
      token: { env: 'TOK' },
      remote: false,
    });
    expect(w.dir?.endsWith('/x')).toBe(true);
    expect(w.dir?.startsWith('~')).toBe(false);
    expect(w.env.K?.startsWith('~')).toBe(false);
    expect(w.source).toBe('config');
  });

  it('defaults remote on for a claude token and off for codex', () => {
    const list = listAccounts(cfg({ claude: { t: { tokenEnv: 'T' }, n: {} }, codex: { c: { dir: '/c' } } }), 'claude', {
      legionHome: home,
    });
    expect(list.map((a) => a.remote)).toEqual([true, false]);
    expect(listAccounts(cfg({ codex: { c: { dir: '/c' } } }), 'codex', { legionHome: home })[0]?.remote).toBe(false);
  });
});

describe('accountEnv', () => {
  const base: Account = {
    kind: 'claude',
    name: 'a',
    dir: '/d',
    token: null,
    env: { X: '1' },
    remote: false,
    enabled: true,
    source: 'config',
  };

  it('sets the config dir, token from env or file, and extra env', () => {
    expect(accountEnv(base, {})).toEqual({ X: '1', CLAUDE_CONFIG_DIR: '/d' });
    expect(accountEnv({ ...base, token: { env: 'T' } }, { T: ' sek ' })).toEqual({
      X: '1',
      CLAUDE_CONFIG_DIR: '/d',
      CLAUDE_CODE_OAUTH_TOKEN: 'sek',
    });
    const file = join(home, 'tok');
    writeFileSync(file, 'filetok\nsecond\n');
    expect(accountEnv({ ...base, dir: null, token: { file } }, {}).CLAUDE_CODE_OAUTH_TOKEN).toBe('filetok');
    expect(accountEnv({ ...base, kind: 'codex', dir: '/h', env: {} }, {})).toEqual({ CODEX_HOME: '/h' });
    expect(accountEnv({ ...base, dir: null, env: {} }, {})).toEqual({});
  });

  it('errors never contain the token and name a missing source', () => {
    expect(() => accountEnv({ ...base, token: { env: 'MISSING' } }, {})).toThrow(/MISSING is not set/);
    expect(() => accountEnv({ ...base, token: { file: join(home, 'nope') } }, {})).toThrow(ConfigError);
  });

  it('refuses forbidden env keys', () => {
    for (const key of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(() => accountEnv({ ...base, env: { [key]: 'x' } }, {})).toThrow(ConfigError);
    }
  });
});
