/**
 * The accounts of an engine: every directory `~/.legion/accounts/<kind>/<name>` (made by `legion login`) plus the
 * `[accounts.<kind>.<name>]` tables of the config, which override a discovered account field by field. Legion only
 * chooses which config dir and token env an unmodified CLI starts with; it never reads or writes the CLI's own
 * credentials. Without any account, one implicit `default` is the plain CLI with the user's login.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigError, expandHome, FORBIDDEN_ACCOUNT_ENV } from '../config.ts';

export type AccountKind = 'claude' | 'codex';
type Env = Record<string, string | undefined>;

export interface Account {
  kind: AccountKind;
  name: string;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME; null = the CLI's default login. */
  dir: string | null;
  token: { env: string } | { file: string } | null;
  env: Readonly<Record<string, string>>;
  remote: boolean;
  enabled: boolean;
  source: 'discovered' | 'config' | 'implicit';
}

export function legionHomeDir(): string {
  return join(homedir(), '.legion');
}

export function accountsDir(kind: AccountKind, legionHome: string = legionHomeDir()): string {
  return join(legionHome, 'accounts', kind);
}

function checkEnv(account: Pick<Account, 'kind' | 'name' | 'env'>): void {
  for (const key of FORBIDDEN_ACCOUNT_ENV) {
    if (key in account.env) {
      throw new ConfigError(`${account.kind} account "${account.name}": ${key} may not be set in its env`);
    }
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function listAccounts(config: Config, kind: AccountKind, opts: { legionHome?: string } = {}): Account[] {
  const found = new Map<string, Account>();
  const root = accountsDir(kind, opts.legionHome);
  let names: string[] = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    // no accounts directory yet
  }
  for (const name of names) {
    const dir = join(root, name);
    if (!isDir(dir)) continue;
    const tokenFile = join(dir, 'oauth-token');
    const token = kind === 'claude' && existsSync(tokenFile) ? { file: tokenFile } : null;
    found.set(name, {
      kind,
      name,
      dir,
      token,
      env: {},
      remote: token !== null,
      enabled: true,
      source: 'discovered',
    });
  }
  for (const [name, raw] of Object.entries(config.accounts[kind])) {
    const prev = found.get(name);
    const token =
      kind !== 'claude'
        ? null
        : raw.tokenEnv
          ? { env: raw.tokenEnv }
          : raw.tokenFile
            ? { file: expandHome(raw.tokenFile) }
            : (prev?.token ?? null);
    const account: Account = {
      kind,
      name,
      dir: raw.dir ? expandHome(raw.dir) : (prev?.dir ?? null),
      token,
      env: Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, expandHome(v)])),
      remote: raw.remote ?? (kind === 'claude' && token !== null),
      enabled: raw.enabled,
      source: 'config',
    };
    checkEnv(account);
    found.set(name, account);
  }
  if (found.size === 0) {
    return [
      { kind, name: 'default', dir: null, token: null, env: {}, remote: false, enabled: true, source: 'implicit' },
    ];
  }
  return [...found.values()];
}

/**
 * The env an account's CLI starts with. The token is read here, at spawn time, and only into the returned env: it
 * appears in no error message.
 */
export function accountEnv(account: Account, processEnv: Env = process.env): Record<string, string> {
  checkEnv(account);
  const out: Record<string, string> = { ...account.env };
  if (account.dir) out[account.kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = account.dir;
  if (account.kind === 'claude' && account.token) {
    let token: string | undefined;
    if ('env' in account.token) {
      token = processEnv[account.token.env]?.trim();
      if (!token) throw new ConfigError(`claude account "${account.name}": ${account.token.env} is not set`);
    } else {
      try {
        token = readFileSync(account.token.file, 'utf8').split(/\r?\n/)[0]?.trim();
      } catch {
        throw new ConfigError(`claude account "${account.name}": cannot read ${account.token.file}`);
      }
      if (!token) throw new ConfigError(`claude account "${account.name}": ${account.token.file} is empty`);
    }
    out.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return out;
}

export { AccountPool, type PoolStatus } from './pool.ts';
