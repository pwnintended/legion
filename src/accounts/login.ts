/**
 * `legion login`: what to run so the official CLI logs an account in. Legion only picks the config dir; the CLI does
 * the login itself with the terminal attached, and Legion never sees a token (`claude setup-token` prints one for
 * the user to save in `<dir>/oauth-token`).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { type Config, migrateProfiles } from '../config.ts';
import { type Account, type AccountKind, accountsDir } from './index.ts';

export interface LoginSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** The account directory (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  /** null = a configured account on the CLI's default login: no config dir to set. */
  dir: string | null;
  /** With `--token`: where the account config expects the token. */
  tokenTarget: { file: string; configure?: string } | { env: string } | null;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isAccountKind(value: string | undefined): value is AccountKind {
  return value === 'claude' || value === 'codex';
}

/** The default name of a new account: the next free `claude-N` / `codex-N`. */
export function nextAccountName(kind: AccountKind, existing: readonly string[]): string {
  for (let n = 1; ; n++) if (!existing.includes(`${kind}-${n}`)) return `${kind}-${n}`;
}

export function loginSpec(
  config: Config,
  kind: AccountKind,
  name: string,
  opts: {
    existing?: Account | null;
    token?: boolean;
    legionHome?: string;
    processEnv?: Record<string, string | undefined>;
  } = {},
): LoginSpec {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a valid account name (letters, digits, . _ -)`);
  if (opts.token && kind !== 'claude') throw new Error('--token is only for Claude accounts (claude setup-token)');
  // A configured account keeps its own destination: logging in elsewhere would leave it unusable.
  const existing = opts.existing && opts.existing.source !== 'implicit' ? opts.existing : null;
  const dir = existing ? existing.dir : join(accountsDir(kind, opts.legionHome), name);
  const env: Record<string, string | undefined> = { ...(opts.processEnv ?? process.env) };
  // A login must not be steered by a leftover token or base URL of the calling shell.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_BASE_URL;
  if (kind === 'claude') {
    // Without a dir the runtime inherits CLAUDE_CONFIG_DIR, so the login does too.
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    // Only a managed directory's oauth-token is discovered; anywhere else the config must name the token source.
    const managed = dir !== null && dir === join(accountsDir(kind, opts.legionHome), name);
    const file = dir ? join(dir, 'oauth-token') : null;
    const target = !opts.token
      ? null
      : (existing?.token ??
        (managed && file
          ? { file }
          : file
            ? { file, configure: `[accounts.claude.${name}]\ntokenFile = "${file}"` }
            : null));
    return {
      command: config.claude.command ?? 'claude',
      args: opts.token ? ['setup-token'] : ['auth', 'login'],
      env,
      dir,
      tokenTarget: target,
    };
  }
  // Without a dir the runtime inherits CODEX_HOME, so the login does too.
  if (dir) env.CODEX_HOME = dir;
  return { command: config.codex.command ?? 'codex', args: ['login'], env, dir, tokenTarget: null };
}

/** Creates the account directory (0700). */
export function prepareLoginDir(spec: LoginSpec): void {
  if (spec.dir) mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
}

export function tokenHint(spec: LoginSpec): string {
  const t = spec.tokenTarget;
  if (!t)
    return "Save the token it printed where the account's tokenEnv / tokenFile points; Legion never reads the CLI's output.";
  return 'env' in t
    ? `Put the token it printed in the environment variable ${t.env} (the account's tokenEnv); Legion never reads the CLI's output.`
    : `Save the token it printed in ${t.file} (chmod 600 ${t.file})${t.configure ? `, and add this to your config so Legion uses it:\n${t.configure}\n` : ''}; Legion never reads the CLI's output.`;
}

export interface AccountRow {
  account: Account;
  loggedIn: boolean | null;
  installed: boolean;
  cooldownUntil: number | null;
  reason: string | null;
  lastUsed: { at: number; what: string } | null;
  problem?: string | null;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** One plain line per account, shared by `legion accounts` and `/accounts`. */
export function describeAccount(row: AccountRow, now: number = Date.now()): string {
  const { account } = row;
  const login = !row.installed
    ? '✗ not installed'
    : row.loggedIn === false
      ? '✗ not logged in'
      : row.loggedIn
        ? '✓ logged in'
        : '? login unknown';
  const state = !account.enabled
    ? 'disabled'
    : row.cooldownUntil && row.cooldownUntil > now
      ? `cooling until ${hhmm(row.cooldownUntil)}${row.reason ? ` (${row.reason})` : ''}`
      : 'free';
  const used = row.lastUsed ? `last used ${hhmm(row.lastUsed.at)} by ${row.lastUsed.what}` : 'never used';
  return `${account.kind}/${account.name}  ${row.problem ? `? ${row.problem}` : login} · ${state} · ${used}`;
}

/** `legion accounts migrate`: rewrites the config file from profiles to accounts, keeping a `.bak`. */
export function migrateConfigFile(path: string): { changed: boolean; notes: string[] } {
  if (!existsSync(path)) return { changed: false, notes: [] };
  const text = readFileSync(path, 'utf8');
  const { doc, notes } = migrateProfiles(parse(text));
  if (notes.length === 0) return { changed: false, notes };
  // The config may hold secrets (remote.apiKey): keep its mode on the backup and the replacement.
  const mode = statSync(path).mode & 0o777;
  const bak = `${path}.bak`;
  copyFileSync(path, bak);
  chmodSync(bak, mode);
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, stringify(doc), { flag: 'wx', mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return { changed: true, notes };
}

/** Probes an account's login; an account that cannot even start (unset tokenEnv, missing tokenFile) is unknown. */
export async function probeAccount(
  probe: () => Promise<{ installed: boolean; loggedIn: boolean | null }>,
): Promise<{ installed: boolean; loggedIn: boolean | null; problem: string | null }> {
  try {
    return { ...(await probe()), problem: null };
  } catch (err) {
    // ConfigError messages name the variable or file, never the token.
    return { installed: true, loggedIn: null, problem: err instanceof Error ? err.message : 'cannot probe' };
  }
}
