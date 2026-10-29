/**
 * Which account the next agent session uses. The state is one file shared by every Legion process (cooldowns must
 * be seen by all); each read-modify-write holds a lock file and replaces the file atomically.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { implicitBoxAccount } from './box.ts';
import type { Account, AccountKind } from './index.ts';
import { acquireLock } from './lock.ts';

interface AccountState {
  cooldownUntil: number | null;
  reason: string | null;
  lastUsed: { at: number; what: string } | null;
}

interface PoolState {
  version: 1;
  cursor: Record<AccountKind, number>;
  accounts: Record<string, AccountState>;
}

export interface PoolStatus extends AccountState {
  account: Account;
}

function emptyState(): PoolState {
  return { version: 1, cursor: { claude: 0, codex: 0 }, accounts: {} };
}

export class AccountPool {
  private readonly file: string;
  private readonly accounts: (kind: AccountKind) => Account[];
  private readonly now: () => number;

  constructor(opts: { file: string; accounts: (kind: AccountKind) => Account[]; now?: () => number }) {
    this.file = opts.file;
    this.accounts = opts.accounts;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Round-robin over the enabled accounts (in a box: the `remote` ones), skipping cooling ones and `avoid`. `prefer`
   * wins when it is available. Records the use.
   */
  acquire(
    kind: AccountKind,
    req: { what: string; prefer?: string | null; avoid?: readonly string[]; where?: 'local' | 'box' },
  ): { account: Account } | { exhausted: true; earliestReset: number | null } {
    let list = this.accounts(kind).filter((a) => a.enabled && (req.where !== 'box' || a.remote));
    // No account can go to a box: the box's own login is one implicit account, with cooldowns like any other.
    if (req.where === 'box' && list.length === 0) list = [implicitBoxAccount(kind)];
    return this.update((state) => {
      const now = this.now();
      const avoid = new Set(req.avoid ?? []);
      const candidates = list.filter((a) => !avoid.has(a.name));
      const until = (a: Account) => state.accounts[`${kind}/${a.name}`]?.cooldownUntil ?? null;
      const free = (a: Account) => (until(a) ?? 0) <= now;
      let pick = req.prefer ? candidates.find((a) => a.name === req.prefer && free(a)) : undefined;
      if (!pick && candidates.length > 0) {
        const start = state.cursor[kind] % list.length;
        for (let i = 0; i < list.length; i++) {
          const idx = (start + i) % list.length;
          const a = list[idx] as Account;
          if (avoid.has(a.name) || !free(a)) continue;
          pick = a;
          state.cursor[kind] = idx + 1;
          break;
        }
      }
      if (!pick) {
        const resets = candidates.map(until).filter((t): t is number => t !== null && t > now);
        return { exhausted: true as const, earliestReset: resets.length > 0 ? Math.min(...resets) : null };
      }
      const key = `${kind}/${pick.name}`;
      state.accounts[key] = { ...blank(state.accounts[key]), lastUsed: { at: now, what: req.what } };
      return { account: pick };
    });
  }

  cooldown(kind: AccountKind, name: string, until: number, reason: string): void {
    this.update((state) => {
      const key = `${kind}/${name}`;
      state.accounts[key] = { ...blank(state.accounts[key]), cooldownUntil: until, reason };
    });
  }

  /** Ends the cooldown of one account, or of every account of the kind. */
  clear(kind: AccountKind, name?: string): void {
    this.update((state) => {
      for (const [key, entry] of Object.entries(state.accounts)) {
        if (!key.startsWith(`${kind}/`) || (name !== undefined && key !== `${kind}/${name}`)) continue;
        state.accounts[key] = { ...entry, cooldownUntil: null, reason: null };
      }
    });
  }

  status(kind: AccountKind): PoolStatus[] {
    const state = this.read();
    const now = this.now();
    return this.accounts(kind).map((account) => {
      const entry = blank(state.accounts[`${kind}/${account.name}`]);
      const cooling = entry.cooldownUntil !== null && entry.cooldownUntil > now;
      return {
        account,
        cooldownUntil: cooling ? entry.cooldownUntil : null,
        reason: cooling ? entry.reason : null,
        lastUsed: entry.lastUsed,
      };
    });
  }

  private read(): PoolState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PoolState>;
      if (raw.version !== 1 || typeof raw.accounts !== 'object' || raw.accounts === null) return emptyState();
      return {
        version: 1,
        cursor: { claude: raw.cursor?.claude ?? 0, codex: raw.cursor?.codex ?? 0 },
        accounts: raw.accounts,
      };
    } catch {
      return emptyState();
    }
  }

  private update<T>(fn: (state: PoolState) => T): T {
    const unlock = acquireLock(`${this.file}.lock`);
    try {
      const state = this.read();
      const result = fn(state);
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(tmp, this.file);
      return result;
    } finally {
      unlock();
    }
  }
}

function blank(entry: AccountState | undefined): AccountState {
  return { cooldownUntil: null, reason: null, lastUsed: null, ...entry };
}
