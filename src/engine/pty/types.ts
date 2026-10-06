/** The slice of node-pty's `IPty` the manager uses; tests inject a fake. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type PtySpawn = (cmd: string, args: string[], options: PtySpawnOptions) => PtyProcess;

/**
 * Extra renderer → engine message on a terminal port, on top of `TerminalMessage` in `@shared/rpc`:
 * the renderer acknowledges the bytes it has written to xterm. Flow control is enabled for a port only
 * after its first ack, so clients that never ack are never paused.
 */
export interface PtyAckMessage {
  type: 'ack';
  bytes: number;
}
