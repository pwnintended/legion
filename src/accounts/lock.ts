/**
 * A cross-process lock: the file `<path>`, created exclusively (`wx`) and holding its owner's token
 * (`<pid> <uuid>`). Release removes it only while it still holds the owner's token.
 *
 * A lock whose owner process is gone, or that is older than `staleMs`, is taken over: it is renamed to a name of the
 * taker's own (atomic, so of several takers exactly one gets it), and if what was renamed is not the lock that was
 * judged stale (another taker replaced it meanwhile) it is put back. What is left is a very narrow window after a
 * stall of `staleMs` (the pool's critical sections take milliseconds), and the pool's state tolerates the rare lost
 * update: a cooldown is reported again by the next step that hits the limit, the cursor only spreads the load.
 */
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LockOptions {
  /** A held lock older than this belongs to a dead (or long stopped) holder and is taken over. */
  staleMs?: number;
  /** Give up waiting after this long. */
  waitMs?: number;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readToken(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock holding `token` belongs to nobody alive (or has been held for longer than `staleMs`). */
function isStale(file: string, token: string, staleMs: number): boolean {
  // Empty: its owner created it and has not written its token yet (or died right then: the age tells).
  if (token !== '' && !alive(Number(token.split(' ')[0]))) return true;
  try {
    return Date.now() - statSync(file).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Takes a stale lock away, unless someone replaced it with a live one meanwhile (then it is put back). */
function takeOver(path: string, stale: string): void {
  const mine = `${path}.${randomUUID()}.stale`;
  try {
    renameSync(path, mine);
  } catch {
    return; // someone else took it over first
  }
  if (readToken(mine) !== stale) {
    try {
      linkSync(mine, path); // fails when a third holder created one meanwhile: theirs stays
    } catch {
      // keep theirs
    }
  }
  try {
    unlinkSync(mine);
  } catch {
    // gone
  }
}

/** Waits for the lock and returns its release function. */
export function acquireLock(path: string, opts: LockOptions = {}): () => void {
  const staleMs = opts.staleMs ?? 10_000;
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  const token = `${process.pid} ${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true });
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try {
      writeFileSync(path, token, { flag: 'wx' });
      return () => {
        if (readToken(path) !== token) return; // taken over after a long stall: not ours to remove
        try {
          unlinkSync(path);
        } catch {
          // gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = readToken(path);
    if (held !== null && isStale(path, held, staleMs)) {
      takeOver(path, held);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`account pool is locked (${path})`);
    sleep(delay);
  }
}
