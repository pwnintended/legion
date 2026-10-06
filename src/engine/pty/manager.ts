import { newId } from '@shared/ids';
import type { TerminalMessage } from '@shared/rpc';
import { type MessageEndpoint, type PortLike, toEndpoint } from '@shared/rpc-transport';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import type { PtyProcess, PtySpawn } from './types';

export interface PtyOpenOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Re-opening a session with the same key attaches to the live one instead of spawning. */
  key?: string;
  /** Kill the process this long after the last view detached (ms). Omit/0 = keep until closed. */
  detachedTtlMs?: number;
}

export interface PtyManagerOptions {
  spawn: PtySpawn;
  /** Lines of scrollback kept in the headless mirror (default 5000). */
  scrollback?: number;
  /** Pause the pty when a view has this many unacknowledged bytes (default 512 KiB). */
  highWaterBytes?: number;
  /** Resume once every view is below this (default 128 KiB). */
  lowWaterBytes?: number;
  /** Output coalescing window in ms (default 4). */
  flushMs?: number;
  onExit?: (terminalId: string, code: number | null) => void;
  log?: (message: string) => void;
}

interface Attachment {
  endpoint: MessageEndpoint;
  /** Output arriving while the hydration snapshot is being taken. */
  held: string[] | null;
  sent: number;
  acked: number;
  /** Set by the first ack: only clients that ack are subject to back-pressure. */
  flow: boolean;
  offMessage: () => void;
  offClose: () => void;
}

interface Session {
  id: string;
  key: string | null;
  proc: PtyProcess;
  mirror: Terminal;
  serializer: SerializeAddon;
  attachments: Set<Attachment>;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  paused: boolean;
  exited: boolean;
  exitCode: number | null;
  ttlMs: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

export interface PtyInfo {
  terminalId: string;
  pid: number;
  exited: boolean;
  attached: number;
}

const DEFAULT_HIGH = 512 * 1024;
const DEFAULT_LOW = 128 * 1024;
const MAX_PENDING = 64 * 1024;

/**
 * Owns the pty sessions. Each session has a headless xterm mirror so a view that attaches later (tile
 * re-opened, renderer reloaded) gets the screen and scrollback back as one serialized `data` message,
 * followed by live output. Views attach and detach freely; only `close`, process exit or the detached TTL
 * end a session.
 */
export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private readonly high: number;
  private readonly low: number;
  private readonly flushMs: number;
  private readonly scrollback: number;

  constructor(private readonly options: PtyManagerOptions) {
    this.high = options.highWaterBytes ?? DEFAULT_HIGH;
    this.low = options.lowWaterBytes ?? DEFAULT_LOW;
    this.flushMs = options.flushMs ?? 4;
    this.scrollback = options.scrollback ?? 5000;
  }

  /** Spawn (or, for a known `key`, find) a session. */
  open(opts: PtyOpenOptions): { terminalId: string; pid: number; reused: boolean } {
    if (opts.key) {
      for (const session of this.sessions.values()) {
        if (session.key === opts.key && !session.exited) {
          this.resize(session.id, opts.cols, opts.rows);
          return { terminalId: session.id, pid: session.proc.pid, reused: true };
        }
      }
    }
    const proc = this.options.spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
    });
    const mirror = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer as unknown as Parameters<Terminal['loadAddon']>[0]);
    const session: Session = {
      id: newId('terminal'),
      key: opts.key ?? null,
      proc,
      mirror,
      serializer,
      attachments: new Set(),
      pending: '',
      flushTimer: null,
      paused: false,
      exited: false,
      exitCode: null,
      ttlMs: opts.detachedTtlMs ?? 0,
      ttlTimer: null,
    };
    this.sessions.set(session.id, session);
    proc.onData((data) => this.onData(session, data));
    proc.onExit(({ exitCode }) => this.onExit(session, exitCode));
    this.armTtl(session);
    return { terminalId: session.id, pid: proc.pid, reused: false };
  }

  has(terminalId: string): boolean {
    return this.sessions.has(terminalId);
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => ({
      terminalId: s.id,
      pid: s.proc.pid,
      exited: s.exited,
      attached: s.attachments.size,
    }));
  }

  /**
   * Connect a view. The port first receives one `data` message with the serialized screen + scrollback
   * (if there is any), then live output; `exit` is sent if the process is already gone.
   */
  attach(terminalId: string, port: PortLike | MessageEndpoint): void {
    const session = this.sessions.get(terminalId);
    const endpoint = toEndpoint(port);
    if (!session) {
      endpoint.close();
      throw new Error(`unknown terminal ${terminalId}`);
    }
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }
    const attachment: Attachment = {
      endpoint,
      held: [],
      sent: 0,
      acked: 0,
      flow: false,
      offMessage: () => {},
      offClose: () => {},
    };
    attachment.offMessage = endpoint.onMessage((data) => this.onPortMessage(session, attachment, data));
    attachment.offClose = endpoint.onClose(() => this.detach(session, attachment));
    session.attachments.add(attachment);

    // write('') completes after everything written so far, so the snapshot is exactly the output seen
    // before this call; anything arriving meanwhile is held and sent right after it.
    session.mirror.write('', () => {
      if (!session.attachments.has(attachment)) return;
      const snapshot = session.serializer.serialize({ scrollback: this.scrollback });
      const held = attachment.held ?? [];
      attachment.held = null;
      if (snapshot) this.send(attachment, { type: 'data', data: snapshot });
      if (held.length > 0) this.send(attachment, { type: 'data', data: held.join('') });
      if (session.exited) this.send(attachment, { type: 'exit', code: session.exitCode });
    });
  }

  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (session && !session.exited) session.proc.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    if (session.mirror.cols !== cols || session.mirror.rows !== rows) session.mirror.resize(cols, rows);
    if (!session.exited) {
      try {
        session.proc.resize(cols, rows);
      } catch (error) {
        this.options.log?.(`pty resize failed: ${(error as Error).message}`);
      }
    }
    return true;
  }

  /** End a session: kill the process if it is still running, drop the mirror, close all views. */
  close(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    this.sessions.delete(terminalId);
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    if (!session.exited) {
      session.exited = true;
      try {
        session.proc.kill();
      } catch {
        // already gone
      }
    }
    for (const attachment of [...session.attachments]) {
      attachment.offMessage();
      attachment.offClose();
      attachment.endpoint.close();
    }
    session.attachments.clear();
    session.mirror.dispose();
    return true;
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  // -------------------------------------------------------------------------------------------

  private onData(session: Session, data: string): void {
    session.mirror.write(data);
    session.pending += data;
    if (session.pending.length >= MAX_PENDING) this.flush(session);
    else if (!session.flushTimer) session.flushTimer = setTimeout(() => this.flush(session), this.flushMs);
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    const data = session.pending;
    if (!data) return;
    session.pending = '';
    for (const attachment of session.attachments) {
      if (attachment.held) attachment.held.push(data);
      else this.send(attachment, { type: 'data', data });
    }
    this.updateFlow(session);
  }

  private onExit(session: Session, code: number | null): void {
    this.flush(session);
    session.exited = true;
    session.exitCode = code;
    if (session.paused) session.paused = false;
    for (const attachment of session.attachments) {
      if (!attachment.held) this.send(attachment, { type: 'exit', code });
    }
    this.options.onExit?.(session.id, code);
    // An exited session nobody watches would linger forever; give a detached one the usual grace period.
    this.armTtl(session);
  }

  private onPortMessage(session: Session, attachment: Attachment, raw: unknown): void {
    const message = raw as { type?: string; data?: unknown; bytes?: unknown } | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'input' && typeof message.data === 'string') {
      this.write(session.id, message.data);
    } else if (message.type === 'ack' && typeof message.bytes === 'number') {
      attachment.flow = true;
      attachment.acked += message.bytes;
      this.updateFlow(session);
    }
  }

  private detach(session: Session, attachment: Attachment): void {
    if (!session.attachments.delete(attachment)) return;
    attachment.offMessage();
    attachment.offClose();
    this.updateFlow(session);
    this.armTtl(session);
  }

  private send(attachment: Attachment, message: TerminalMessage): void {
    if (message.type === 'data') attachment.sent += message.data.length;
    try {
      attachment.endpoint.postMessage(message);
    } catch (error) {
      this.options.log?.(`pty port send failed: ${(error as Error).message}`);
    }
  }

  private updateFlow(session: Session): void {
    if (session.exited) return;
    let worst = 0;
    for (const attachment of session.attachments) {
      if (attachment.flow) worst = Math.max(worst, attachment.sent - attachment.acked);
    }
    if (!session.paused && worst > this.high) {
      session.paused = true;
      session.proc.pause();
    } else if (session.paused && worst <= this.low) {
      session.paused = false;
      session.proc.resume();
    }
  }

  private armTtl(session: Session): void {
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }
    if (session.ttlMs <= 0 || session.attachments.size > 0 || !this.sessions.has(session.id)) return;
    session.ttlTimer = setTimeout(() => this.close(session.id), session.ttlMs);
    session.ttlTimer.unref?.();
  }
}
