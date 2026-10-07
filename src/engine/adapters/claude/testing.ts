/**
 * Test helpers for the Claude adapter (not used in production code):
 * - `FakeChild`: an in-memory child process speaking stream-json over PassThrough pipes.
 * - `replayFixture`: plays a recorded transcript (`fixtures/*.jsonl`) through a `FakeChild`, waiting for the
 *   session to write each recorded stdin message before continuing.
 * - `recordingSpawn`: wraps a spawn function and appends everything crossing stdin/stdout to a JSONL file
 *   (used by the live tests with `LEGION_RECORD_DIR` to produce fixtures).
 */
import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { SpawnFn } from './engine';
import { LineBuffer } from './parser';
import type { ChildProcessLike } from './session';

export type FixtureLine =
  | { dir: 'in'; msg: Record<string, unknown> }
  | { dir: 'in'; end: true }
  | { dir: 'out'; msg: Record<string, unknown> }
  | { dir: 'exit'; code: number | null };

export function loadFixture(path: string): FixtureLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
}

/** `session_id` of a fixture's first `system/init`. */
export function fixtureSessionId(lines: FixtureLine[]): string {
  for (const line of lines) {
    if (line.dir === 'out' && line.msg.type === 'system' && line.msg.subtype === 'init') {
      return String(line.msg.session_id);
    }
  }
  throw new Error('fixture has no system/init');
}

export class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Everything the session wrote, parsed. */
  readonly written: Record<string, unknown>[] = [];
  readonly signals: NodeJS.Signals[] = [];
  stdinEnded = false;
  exited = false;
  /** What `kill` does; default: exit as if killed by the signal. */
  onKill: (signal: NodeJS.Signals) => void = (signal) => this.exit(null, signal);

  constructor() {
    super();
    const lines = new LineBuffer();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        this.written.push(JSON.parse(line) as Record<string, unknown>);
        this.emit('stdin');
      }
    });
    this.stdin.on('end', () => {
      this.stdinEnded = true;
      this.emit('stdin');
    });
  }

  /** First written message at index >= `from` matching `predicate`, waiting for it if necessary. */
  async waitFor(
    predicate: (msg: Record<string, unknown>) => boolean,
    from = 0,
  ): Promise<{ msg: Record<string, unknown>; index: number }> {
    for (;;) {
      const index = this.written.findIndex((msg, i) => i >= from && predicate(msg));
      if (index >= 0) return { msg: this.written[index] as Record<string, unknown>, index };
      await new Promise((resolve) => this.once('stdin', resolve));
    }
  }

  async waitForStdinEnd(): Promise<void> {
    while (!this.stdinEnded) await new Promise((resolve) => this.once('stdin', resolve));
  }

  send(msg: unknown): void {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('exit', code, signal));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (!this.exited) this.onKill(signal);
    return true;
  }
}

function matches(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  if (expected.type !== actual.type) return false;
  if (expected.type === 'control_request') {
    const a = expected.request as Record<string, unknown> | undefined;
    const b = actual.request as Record<string, unknown> | undefined;
    return a?.subtype === b?.subtype;
  }
  if (expected.type === 'control_response') {
    const a = expected.response as Record<string, unknown> | undefined;
    const b = actual.response as Record<string, unknown> | undefined;
    return a?.request_id === b?.request_id;
  }
  return true;
}

/**
 * Plays `lines` through `child`. Recorded stdin messages are awaited (in order) from the session; the ids
 * of our own control requests are mapped onto the recorded ones so recorded responses still match.
 */
export async function replayFixture(child: FakeChild, lines: FixtureLine[]): Promise<void> {
  const idMap = new Map<string, string>();
  let next = 0;
  for (const line of lines) {
    if (line.dir === 'in') {
      if ('end' in line) {
        await child.waitForStdinEnd();
        continue;
      }
      const expected = line.msg;
      const { msg, index } = await child.waitFor((actual) => matches(expected, actual), next);
      next = index + 1;
      if (expected.type === 'control_request') idMap.set(String(expected.request_id), String(msg.request_id));
    } else if (line.dir === 'out') {
      let msg = line.msg;
      if (msg.type === 'control_response') {
        const response = msg.response as Record<string, unknown>;
        const mapped = idMap.get(String(response.request_id));
        if (mapped) msg = { ...msg, response: { ...response, request_id: mapped } };
      }
      child.send(msg);
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      child.exit(line.code);
    }
  }
}

/** Wraps `spawn` so that every message crossing the child's stdin/stdout is appended to `file`. */
export function recordingSpawn(spawn: SpawnFn, file: string): SpawnFn {
  return (command, args, options) => {
    writeFileSync(file, '');
    const record = (line: FixtureLine) => appendFileSync(file, `${JSON.stringify(line)}\n`);
    const child = spawn(command, args, options);
    const stdin = child.stdin;
    if (stdin) {
      const write = stdin.write.bind(stdin) as (chunk: string) => boolean;
      const end = stdin.end.bind(stdin) as () => void;
      stdin.write = ((chunk: string) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) record({ dir: 'in', msg: JSON.parse(line) });
        return write(chunk);
      }) as typeof stdin.write;
      stdin.end = (() => {
        record({ dir: 'in', end: true });
        end();
        return stdin;
      }) as typeof stdin.end;
    }
    const lines = new LineBuffer();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      for (const line of lines.push(String(chunk))) {
        try {
          record({ dir: 'out', msg: JSON.parse(line) });
        } catch {
          // not part of the protocol
        }
      }
    });
    child.on('exit', (code) => record({ dir: 'exit', code }));
    return child;
  };
}
