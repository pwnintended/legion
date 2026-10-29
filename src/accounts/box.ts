/**
 * Accounts in remote boxes. A box step runs on one account of the pool whose login can travel: a Claude account with
 * a `claude setup-token` token, or a Codex account marked `remote` (its `auth.json`, which the launcher seeds into
 * a per-account CODEX_HOME in the box). With none of those, the step uses the implicit `box` account: the login in
 * the Upstash account's environment, which Legion neither reads nor passes. The secrets only go into the env of the
 * box session; they appear in no log, journal or error message.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type Account, type AccountKind, accountEnv } from './index.ts';

/** The implicit account of boxes: the Upstash account-level environment login. */
export const BOX_ACCOUNT = 'box';

export function implicitBoxAccount(kind: AccountKind): Account {
  return { kind, name: BOX_ACCOUNT, dir: null, token: null, env: {}, remote: true, enabled: true, source: 'implicit' };
}

/** The accounts a box step can use: enabled and `remote`. */
export function boxAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((a) => a.enabled && a.remote);
}

/**
 * The env a box session of `account` starts with. Claude: the token as CLAUDE_CODE_OAUTH_TOKEN. Codex: the account's
 * `auth.json` (gzip, base64) and its name, for the launcher. Local paths (CLAUDE_CONFIG_DIR, CODEX_HOME) stay here.
 */
export function boxEnv(account: Account, processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (account.source === 'implicit' && account.name === BOX_ACCOUNT) return {};
  const out: Record<string, string> = { ...account.env };
  if (account.kind === 'claude') {
    const token = account.token ? accountEnv(account, processEnv).CLAUDE_CODE_OAUTH_TOKEN : undefined;
    if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
    return out;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(account.name) || account.name === '.' || account.name === '..') {
    throw new Error(`codex account "${account.name}": the name cannot be used in a box (letters, digits, . _ - only)`);
  }
  const home = account.dir ?? processEnv.CODEX_HOME ?? join(homedir(), '.codex');
  const file = join(home, 'auth.json');
  let auth: Buffer;
  try {
    auth = readFileSync(file);
  } catch {
    throw new Error(`codex account "${account.name}": cannot read ${file}; log in with \`legion login codex\``);
  }
  out.CODEX_AUTH_GZIP_B64 = gzipSync(auth).toString('base64');
  out.LEGION_CODEX_ACCOUNT = account.name;
  return out;
}
