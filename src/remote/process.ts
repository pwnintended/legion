/**
 * A process in a box that looks like a local child process to the engine adapters: `stdin`, `stdout`, `stderr`,
 * `kill`, and the `spawn` / `exit` / `error` events. Writes and signals before the remote process has started are
 * held and delivered once it has.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { RemoteProcess } from './box.ts';

export type StartRemote = (io: {
  onStdout(data: Uint8Array): void;
  onStderr(data: Uint8Array): void;
}) => Promise<RemoteProcess>;

export class RemoteChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Undefined until the remote process has started (the adapters read that as "never spawned"). */
  pid: number | undefined;
  private proc: RemoteProcess | null = null;
  private held: Uint8Array[] = [];
  private stdinEnded = false;
  private pendingSignal: string | null = null;
  private gone = false;

  constructor(start: StartRemote) {
    super();
    this.stdin = new Writable({
      write: (chunk: Uint8Array, _encoding, done) => {
        if (this.proc) this.proc.write(chunk);
        else this.held.push(chunk);
        done();
      },
      final: (done) => {
        if (this.proc) this.proc.endStdin();
        else this.stdinEnded = true;
        done();
      },
    });
    start({ onStdout: (d) => this.stdout.write(d), onStderr: (d) => this.stderr.write(d) }).then(
      (proc) => this.started(proc),
      (err: unknown) => {
        this.gone = true;
        this.stdout.end();
        this.stderr.end();
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.gone) return false;
    const name = typeof signal === 'number' ? String(signal) : signal.replace(/^SIG/, '');
    if (!this.proc) {
      this.pendingSignal = name;
      return true;
    }
    try {
      this.proc.kill(name);
    } catch {
      return false;
    }
    return true;
  }

  private started(proc: RemoteProcess): void {
    this.proc = proc;
    this.pid = 0;
    for (const chunk of this.held) proc.write(chunk);
    this.held = [];
    if (this.stdinEnded) proc.endStdin();
    this.emit('spawn');
    if (this.pendingSignal) this.kill(`SIG${this.pendingSignal}` as NodeJS.Signals);
    proc.wait().then(
      (code) => this.exited(code < 0 ? null : code),
      () => this.exited(null),
    );
  }

  private exited(code: number | null): void {
    this.gone = true;
    this.stdout.end();
    this.stderr.end();
    this.proc?.close();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}
