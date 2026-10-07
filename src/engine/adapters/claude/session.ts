/**
 * One live `claude -p --input-format stream-json` process = one `AgentSession`.
 *
 * stdin stays open for the session's lifetime: the first prompt and every `send` are stream-json user
 * messages; interrupts and permission answers go over the control protocol on the same pipe.
 */
import type { Readable, Writable } from 'node:stream';
import type { AgentSession, ApprovalDecision, SessionAttachment, SessionOptions } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import type { Logger } from '../../context';
import { AsyncQueue, deferred } from '../../util/async-queue';
import { ClaudeStreamParser, LineBuffer, type ParserOutput } from './parser';
import {
  controlError,
  controlSuccess,
  interruptRequest,
  type PendingPermission,
  permissionResponse,
  type StdinMessage,
  userMessage,
} from './protocol';

/** The subset of `ChildProcess` the session uses (tests pass a fake). */
export interface ChildProcessLike {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface SessionTiming {
  /** Window for coalescing `text_delta`s (0 = emit every delta). */
  coalesceMs: number;
  /** How long to wait for the turn to end after an interrupt request, then after SIGINT. */
  interruptTimeoutMs: number;
  /** After `close()` ends stdin on an idle session: time to exit on its own before SIGTERM. */
  closeGraceMs: number;
  /** After SIGTERM: time before SIGKILL. */
  killTimeoutMs: number;
}

export const DEFAULT_TIMING: SessionTiming = {
  coalesceMs: 50,
  interruptTimeoutMs: 5_000,
  closeGraceMs: 2_000,
  killTimeoutMs: 3_000,
};

export interface ClaudeSessionInit {
  child: ChildProcessLike;
  /** Pre-assigned (`--session-id`) or resumed (`--resume`) id; replaced by `system/init`'s if different. */
  sessionId: string;
  opts: SessionOptions;
  log: Logger;
  timing?: Partial<SessionTiming>;
  /** Called once after the process is gone (temp file cleanup). */
  onExit?: () => void;
}

const STDERR_TAIL = 4_000;

export class ClaudeSession implements AgentSession {
  readonly engine = 'claude' as const;
  readonly events = new AsyncQueue<AgentEvent>();

  private sessionId: string;
  private readonly child: ChildProcessLike;
  private readonly parser: ClaudeStreamParser;
  private readonly lines = new LineBuffer();
  private readonly timing: SessionTiming;
  private readonly log: Logger;
  private readonly onExit: (() => void) | undefined;

  private readonly approvals = new Map<string, PendingPermission>();
  private readonly controls = new Map<string, ReturnType<typeof deferred<void>>>();
  private readonly turnWaiters: (() => void)[] = [];
  private readonly loggedUnknown = new Set<string>();
  private readonly exitedSignal = deferred<void>();

  private busy = false;
  private closing = false;
  private exited = false;
  private exitCode: number | null = null;
  private stdoutDone = false;
  private processGone = false;
  private stderrTail = '';
  private textBuffer = '';
  private textTimer: ReturnType<typeof setTimeout> | null = null;
  private controlCounter = 0;

  constructor(init: ClaudeSessionInit) {
    this.child = init.child;
    this.sessionId = init.sessionId;
    this.log = init.log;
    this.onExit = init.onExit;
    this.timing = { ...DEFAULT_TIMING, ...init.timing };
    this.parser = new ClaudeStreamParser({ cwd: init.opts.cwd, structuredOutput: Boolean(init.opts.outputSchema) });

    const { stdout, stderr, stdin } = this.child;
    stdout?.setEncoding('utf8');
    stdout?.on('data', (chunk: string) => {
      for (const line of this.lines.push(chunk)) this.handleLine(line);
    });
    stdout?.on('end', () => {
      for (const line of this.lines.flush()) this.handleLine(line);
      this.stdoutDone = true;
      this.maybeFinish();
    });
    if (!stdout) this.stdoutDone = true;
    stderr?.setEncoding('utf8');
    stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    stdin?.on('error', (error) => this.log.warn(`claude stdin: ${error.message}`));
    this.child.on('error', (error) => {
      this.stderrTail += `\n${error.message}`;
      this.processGone = true;
      this.stdoutDone = true;
      this.maybeFinish();
    });
    this.child.on('exit', (code) => {
      this.exitCode = code;
      this.processGone = true;
      // Grandchildren can hold stdout open; don't wait for it forever.
      setTimeout(() => {
        this.stdoutDone = true;
        this.maybeFinish();
      }, 1_000).unref?.();
      this.maybeFinish();
    });
    init.opts.signal?.addEventListener('abort', () => void this.close(), { once: true });
  }

  get id(): string {
    return this.sessionId;
  }

  /** Writes the first prompt. Called by the engine right after spawning. */
  begin(prompt: string, attachments?: readonly SessionAttachment[] | null): void {
    this.busy = true;
    this.write(userMessage(prompt, undefined, attachments));
  }

  async send(
    text: string,
    priority: 'now' | 'next' = 'next',
    attachments?: readonly SessionAttachment[] | null,
  ): Promise<void> {
    if (this.exited || this.closing) throw new Error('session is closed');
    const message = userMessage(text, priority, attachments);
    if (priority === 'now' && this.busy) this.parser.noteInterrupt();
    this.busy = true;
    this.write(message);
  }

  async interrupt(): Promise<void> {
    if (this.exited || !this.busy) return;
    const turnEnded = this.waitTurn();
    this.parser.noteInterrupt();
    const requestId = this.nextControlId('interrupt');
    const ack = deferred<void>();
    this.controls.set(requestId, ack);
    this.write(interruptRequest(requestId));
    if (await within(turnEnded, this.timing.interruptTimeoutMs)) return;
    this.log.warn('claude: interrupt request timed out, sending SIGINT');
    this.child.kill('SIGINT');
    if (await within(turnEnded, this.timing.interruptTimeoutMs)) return;
    // Give up on the process; the transcript on disk stays resumable with `resume(sessionId)`.
    this.log.warn('claude: SIGINT did not end the turn, killing the process');
    this.closing = true;
    await this.terminate();
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.closing = true;
    this.child.stdin?.end();
    if (!this.busy && (await within(this.exitedSignal.promise, this.timing.closeGraceMs))) return;
    await this.terminate();
  }

  async respond(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    this.approvals.delete(requestId);
    if (decision.behavior === 'deny' && decision.interrupt) this.parser.noteInterrupt();
    this.write(permissionResponse(pending, decision));
  }

  private async terminate(): Promise<void> {
    if (this.exited) return;
    this.child.kill('SIGTERM');
    if (await within(this.exitedSignal.promise, this.timing.killTimeoutMs)) return;
    this.child.kill('SIGKILL');
    await this.exitedSignal.promise;
  }

  private write(message: StdinMessage): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      if (!this.exited && !this.closing) this.log.warn(`claude: dropped ${message.type} (stdin closed)`);
      return;
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private nextControlId(kind: string): string {
    this.controlCounter += 1;
    return `legion-${kind}-${this.controlCounter}`;
  }

  private waitTurn(): Promise<void> {
    if (!this.busy || this.exited) return Promise.resolve();
    return new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  private handleLine(line: string): void {
    for (const output of this.parser.handleLine(line)) this.handleOutput(output);
  }

  private handleOutput(output: ParserOutput): void {
    switch (output.kind) {
      case 'event':
        this.handleEvent(output.event);
        return;
      case 'permission':
        this.approvals.set(output.request.requestId, output.request);
        this.emit({
          type: 'approval_request',
          requestId: output.request.requestId,
          tool: output.request.toolName,
          input: output.request.input,
          reason: output.reason,
        });
        return;
      case 'control_request':
        this.logOnce(`control:${output.subtype}`, `claude: declining unsupported control request ${output.subtype}`);
        this.write(
          output.subtype === 'elicitation'
            ? controlSuccess(output.requestId, { action: 'decline' })
            : controlError(output.requestId, `Legion does not handle ${output.subtype}`),
        );
        return;
      case 'control_response': {
        const pending = this.controls.get(output.requestId);
        this.controls.delete(output.requestId);
        if (!output.ok) this.log.warn(`claude: control request ${output.requestId} failed: ${output.error}`);
        pending?.resolve();
        return;
      }
      case 'control_cancel':
        this.approvals.delete(output.requestId);
        return;
      case 'unknown':
        this.logOnce(`type:${output.type}`, `claude: ignoring unknown stream-json message type "${output.type}"`);
        return;
    }
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'session_started':
        if (event.sessionId) this.sessionId = event.sessionId;
        break;
      case 'text_delta':
        this.busy = true;
        this.bufferText(event.text);
        return;
      case 'turn_complete':
        this.emit(event);
        this.endTurn();
        return;
      case 'usage':
      case 'rate_limit':
      case 'error':
        break;
      default:
        this.busy = true;
    }
    this.emit(event);
  }

  private endTurn(): void {
    this.busy = false;
    this.approvals.clear();
    for (const resolve of this.turnWaiters.splice(0)) resolve();
  }

  private bufferText(text: string): void {
    if (this.timing.coalesceMs <= 0) {
      this.events.push({ type: 'text_delta', text });
      return;
    }
    this.textBuffer += text;
    this.textTimer ??= setTimeout(() => this.flushText(), this.timing.coalesceMs);
  }

  private flushText(): void {
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = null;
    if (this.textBuffer.length === 0) return;
    const text = this.textBuffer;
    this.textBuffer = '';
    this.events.push({ type: 'text_delta', text });
  }

  private emit(event: AgentEvent): void {
    if (this.exited) return;
    this.flushText();
    this.events.push(event);
  }

  private maybeFinish(): void {
    if (this.exited || !this.processGone || !this.stdoutDone) return;
    const stderr = this.stderrTail.trim();
    if (this.busy) {
      if (!this.closing) {
        this.emit({
          type: 'error',
          message: stderr || `claude exited with code ${this.exitCode ?? 'null'} mid-turn`,
          retryable: false,
        });
      }
      this.emit({
        type: 'turn_complete',
        structuredOutput: null,
        isError: true,
        reason: this.closing ? 'interrupted' : 'process_exited',
      });
      this.endTurn();
    } else if (!this.closing && this.exitCode !== 0 && stderr) {
      this.emit({ type: 'error', message: stderr, retryable: false });
    }
    this.emit({ type: 'exited', code: this.exitCode });
    this.exited = true;
    this.events.end();
    for (const pending of this.controls.values()) pending.resolve();
    this.controls.clear();
    this.approvals.clear();
    this.exitedSignal.resolve();
    try {
      this.onExit?.();
    } catch (error) {
      this.log.warn(`claude: exit cleanup failed: ${(error as Error).message}`);
    }
  }

  private logOnce(key: string, message: string): void {
    if (this.loggedUnknown.has(key)) return;
    this.loggedUnknown.add(key);
    this.log.warn(message);
  }
}

/** Resolves true if `promise` settles within `ms`, false on timeout. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
