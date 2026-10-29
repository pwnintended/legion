/**
 * A cross-process lock without removal races. The lock is a numbered file `<path>.<gen>`; the highest generation is
 * the current one. A holder owns the name it created with `wx`, and generation numbers are never reused, so
 * nothing a process does with a name can hit another owner's file:
 * - acquire: the highest generation is released (`<path>.<gen>.released`), or absent, or older than `staleMs`
 *   (a dead holder): create generation + 1 exclusively. Of several contenders exactly one wins that name, and a
 *   contender that looked at an older generation just fails and looks again.
 * - release: rename the own file to `.released`. A former owner that wakes up after a takeover finds its file gone
 *   (or renames a file nobody else uses) and so cannot disturb its successor.
 * - the winner of generation n deletes older generations (never the highest, so the numbers keep growing).
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface LockOptions {
  /** A held lock older than this belongs to a dead (or long stopped) holder and is taken over. */
  staleMs?: number;
  /** Give up waiting after this long. */
  waitMs?: number;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface Gen {
  gen: number;
  released: boolean;
  file: string;
}

function generations(path: string): Gen[] {
  const dir = dirname(path);
  const name = basename(path);
  const out: Gen[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.startsWith(`${name}.`)) continue;
    const m = /^(\d+)(\.released)?$/.exec(n.slice(name.length + 1));
    if (m) out.push({ gen: Number(m[1]), released: m[2] !== undefined, file: join(dir, n) });
  }
  return out.sort((a, b) => a.gen - b.gen);
}

function createExclusive(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, randomUUID());
  } finally {
    closeSync(fd);
  }
  return true;
}

function ageMs(file: string): number | null {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Waits for the lock and returns its release function. */
export function acquireLock(path: string, opts: LockOptions = {}): () => void {
  const staleMs = opts.staleMs ?? 10_000;
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  mkdirSync(dirname(path), { recursive: true });
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    const all = generations(path);
    const top = all[all.length - 1];
    const age = top && !top.released ? ageMs(top.file) : null;
    // `age === null` for a held top means it vanished between listing and stat: look again.
    const free = !top || top.released || (age !== null && age > staleMs);
    if (free) {
      const gen = (top?.gen ?? 0) + 1;
      const mine = `${path}.${gen}`;
      if (createExclusive(mine)) {
        for (const old of all) {
          try {
            unlinkSync(old.file);
          } catch {
            // already gone
          }
        }
        return () => {
          try {
            renameSync(mine, `${mine}.released`);
          } catch {
            // our generation was cleaned up by a takeover
          }
        };
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`account pool is locked (${path})`);
    sleep(delay);
  }
}
