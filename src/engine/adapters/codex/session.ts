/**
 * One Legion session = one `codex app-server` child process = one thread (isolation; a crash takes down
 * one attempt only). Lifecycle: initialize → initialized → thread/start | thread/resume → turn/start.
 * `send` steers the active turn (turn/steer) or starts a new one; `interrupt` = turn/interrupt; approval
 * server requests become `approval_request` events and stay pending until `respond`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import type { AgentSession, ApprovalDecision, SessionOptions } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import { AsyncQueue, deferred } from '../../util/async-queue';
import { childEnv, isPreapproved, threadResumeParams, threadStartParams, turnStartParams, userInput } from './config';
import { JSON_RPC_ERROR, JsonRpcError, JsonRpcPeer, LineSplitter, type RequestOptions } from './json-rpc';
import type { ClientMethod, ClientMethods, ServerNotification, ServerRequest } from './methods';
import { APPROVAL_METHODS, approvalRequestId, approvalResponse, CodexNormalizer } from './normalize';

export interface CodexProcessSpec {
  /** Executable (absolute path). */
  command: string;
  args: readonly string[];
  /** CODEX_HOME for the child. */
  codexHome: string;
  clientVersion: string;
  /** stderr lines of the child (codex logs warnings/errors there). */
  onStderr?: (line: string) => void;
}

export type OpenMode = { kind: 'start' } | { kind: 'resume'; threadId: string };

/** Coalescing window for `text_delta` events (shared/events.ts asks for ~50 ms). */
const DELTA_FLUSH_MS = 50;
const INIT_TIMEOUT_MS = 30_000;
const THREAD_TIMEOUT_MS = 60_000;
const INTERRUPT_WAIT_MS = 15_000;
const EXIT_GRACE_MS = 2_000;
const STDERR_TAIL = 20;

export class CodexSession implements AgentSession {
  readonly engine = 'codex' as const;
  readonly events = new AsyncQueue<AgentEvent>();

  private threadId = '';
  private version: string | null = null;
  private readonly child: ChildProcess;
  private readonly rpc: JsonRpcPeer;
  private readonly normalizer: CodexNormalizer;
  private readonly approvals = new Map<string, { request: ServerRequest; resolve(result: unknown): void }>();
  private readonly stderrTail: string[] = [];

  private activeTurnId: string | null = null;
  private readonly completedTurns = new Set<string>();
  private turnDone = deferred();
  private turnStarting: Promise<void> | null = null;

  private textBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private exitCode: number | null = null;
  private readonly exited = deferred();
  private hasExited = false;

  private constructor(
    private readonly opts: SessionOptions,
    private readonly spec: CodexProcessSpec,
  ) {
    this.normalizer = new CodexNormalizer({ cwd: opts.cwd, structuredOutput: Boolean(opts.outputSchema) });
    this.turnDone.resolve();
    this.child = spawn(spec.command, [...spec.args], {
      cwd: opts.cwd,
      env: childEnv(opts, spec.codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rpc = new JsonRpcPeer({
      write: (line) => {
        if (!this.child.stdin?.writable) throw new Error('codex app-server stdin is closed');
        this.child.stdin.write(`${line}\n`);
      },
      onNotification: (method, params) => this.onNotification({ method, params } as ServerNotification),
      onRequest: (method, params, id) => this.onServerRequest({ method, params, id } as ServerRequest),
      onProtocolError: (message, line) => spec.onStderr?.(`[legion] ${message}: ${line.slice(0, 200)}`),
      requestTimeoutMs: 60_000,
    });
    this.wireProcess();
  }

  /** Spawn, handshake and open the thread; the first turn is started when `opts.prompt` is non-empty. */
  static async open(opts: SessionOptions, mode: OpenMode, spec: CodexProcessSpec): Promise<CodexSession> {
    const session = new CodexSession(opts, spec);
    try {
      await session.handshake(mode);
    } catch (error) {
      await session.close();
      throw new Error(`codex app-server failed to start: ${(error as Error).message}${session.stderrSuffix()}`);
    }
    if (opts.signal) {
      if (opts.signal.aborted) void session.close();
      else opts.signal.addEventListener('abort', () => void session.close(), { once: true });
    }
    return session;
  }

  get id(): string {
    return this.threadId;
  }

  private async handshake(mode: OpenMode): Promise<void> {
    const spawned = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', () => resolve());
      this.child.once('error', reject);
    });
    await spawned;
    const init = await this.call(
      'initialize',
      {
        clientInfo: { name: 'legion', title: 'Legion', version: this.spec.clientVersion },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    this.version = /^[^/\s]+\/(\S+)/.exec(init.userAgent)?.[1] ?? null;
    this.rpc.notify('initialized');
    const opened =
      mode.kind === 'start'
        ? await this.call('thread/start', threadStartParams(this.opts), { timeoutMs: THREAD_TIMEOUT_MS })
        : await this.call('thread/resume', threadResumeParams(mode.threadId, this.opts), {
            timeoutMs: THREAD_TIMEOUT_MS,
          });
    this.threadId = opened.thread.id;
    this.emit([{ type: 'session_started', sessionId: this.threadId, model: opened.model, version: this.version }]);
    if (this.opts.prompt.trim() !== '') await this.startTurn(this.opts.prompt);
  }

  private call<M extends ClientMethod>(
    method: M,
    params: ClientMethods[M][0],
    options?: RequestOptions,
  ): Promise<ClientMethods[M][1]> {
    return this.rpc.request<ClientMethods[M][1]>(method, params, options);
  }

  // -------------------------------------------------------------------------------------------
  // AgentSession
  // -------------------------------------------------------------------------------------------

  async send(text: string, priority: 'now' | 'next' = 'next'): Promise<void> {
    this.assertOpen();
    await this.turnStarting;
    if (this.activeTurnId) {
      if (priority === 'now') {
        await this.interrupt();
      } else {
        try {
          await this.call('turn/steer', {
            threadId: this.threadId,
            input: userInput(text),
            expectedTurnId: this.activeTurnId,
          });
          return;
        } catch {
          // Not steerable (turn just ended, review turn, ...): queue as the next turn.
          await this.turnDone.promise;
        }
      }
    }
    this.assertOpen();
    await this.startTurn(text);
  }

  async interrupt(): Promise<void> {
    await this.turnStarting?.catch(() => undefined);
    const turnId = this.activeTurnId;
    if (!turnId || this.hasExited) return;
    const done = this.turnDone.promise;
    try {
      await this.call('turn/interrupt', { threadId: this.threadId, turnId }, { timeoutMs: INTERRUPT_WAIT_MS });
    } catch (error) {
      // "no active turn to interrupt": it ended meanwhile.
      if (!(error instanceof JsonRpcError)) throw error;
    }
    await Promise.race([done, this.exited.promise, sleep(INTERRUPT_WAIT_MS)]);
  }

  async close(): Promise<void> {
    if (this.closing) return this.exited.promise;
    this.closing = true;
    if (this.activeTurnId && !this.hasExited) {
      await Promise.race([this.interrupt().catch(() => undefined), sleep(3_000)]);
    }
    if (!this.hasExited) {
      this.child.stdin?.end();
      await Promise.race([this.exited.promise, sleep(EXIT_GRACE_MS)]);
    }
    if (!this.hasExited) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited.promise, sleep(EXIT_GRACE_MS)]);
    }
    if (!this.hasExited) this.child.kill('SIGKILL');
    await this.exited.promise;
  }

  async respond(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    this.approvals.delete(requestId);
    pending.resolve(approvalResponse(pending.request, decision));
    const cancelsItself =
      pending.request.method === 'item/commandExecution/requestApproval' ||
      pending.request.method === 'item/fileChange/requestApproval' ||
      pending.request.method === 'execCommandApproval' ||
      pending.request.method === 'applyPatchApproval' ||
      pending.request.method === 'mcpServer/elicitation/request';
    if (decision.behavior === 'deny' && decision.interrupt && !cancelsItself) await this.interrupt();
  }

  // -------------------------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------------------------

  private startTurn(text: string): Promise<void> {
    const done = deferred();
    this.turnDone = done;
    const starting = this.call('turn/start', turnStartParams(this.threadId, text, this.opts)).then(
      ({ turn }) => {
        // Lines after the response may already have completed the turn before this continuation runs.
        if (!this.completedTurns.has(turn.id)) this.activeTurnId = turn.id;
      },
      (error: unknown) => {
        done.resolve();
        throw error;
      },
    );
    const settled = starting.then(
      () => undefined,
      () => undefined,
    );
    this.turnStarting = settled;
    void settled.then(() => {
      if (this.turnStarting === settled) this.turnStarting = null;
    });
    return starting;
  }

  private onNotification(notification: ServerNotification): void {
    const params = notification.params as { threadId?: unknown } | undefined;
    // Sub-agent threads stream on the same connection; only our thread drives the session.
    if (this.threadId && typeof params?.threadId === 'string' && params.threadId !== this.threadId) return;
    switch (notification.method) {
      case 'turn/started':
        if (!this.completedTurns.has(notification.params.turn.id)) this.activeTurnId = notification.params.turn.id;
        break;
      case 'turn/completed':
        this.completedTurns.add(notification.params.turn.id);
        if (this.activeTurnId === notification.params.turn.id || this.activeTurnId === null) this.activeTurnId = null;
        break;
      case 'serverRequest/resolved':
        // Codex withdrew the request (turn interrupted / finished); it no longer expects an answer.
        this.approvals.delete(approvalRequestId(notification.params.requestId));
        break;
      default:
        break;
    }
    this.emit(this.normalizer.handle(notification));
    if (notification.method === 'turn/completed' && this.activeTurnId === null) this.turnDone.resolve();
  }

  private onServerRequest(request: ServerRequest): unknown {
    if (APPROVAL_METHODS.has(request.method)) {
      if (
        request.method === 'item/commandExecution/requestApproval' &&
        isPreapproved(request.params, this.opts.permission.allowedCommands)
      ) {
        return { decision: 'accept' };
      }
      const event = this.normalizer.approvalRequest(request);
      if (!event) throw new JsonRpcError(JSON_RPC_ERROR.methodNotFound, `unsupported request: ${request.method}`);
      const requestId = approvalRequestId(request.id);
      return new Promise((resolve) => {
        this.approvals.set(requestId, { request, resolve });
        this.emit([event]);
      });
    }
    if (request.method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
    // Dynamic tools, ChatGPT token refresh, attestation: Legion registers none of these.
    throw new JsonRpcError(JSON_RPC_ERROR.methodNotFound, `Legion does not handle ${request.method}`);
  }

  // -------------------------------------------------------------------------------------------
  // Events & process
  // -------------------------------------------------------------------------------------------

  private emit(events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (event.type === 'text_delta') {
        this.textBuffer += event.text;
        this.flushTimer ??= setTimeout(() => this.flushText(), DELTA_FLUSH_MS);
        continue;
      }
      this.flushText();
      this.events.push(event);
    }
  }

  private flushText(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.textBuffer === '') return;
    const text = this.textBuffer;
    this.textBuffer = '';
    this.events.push({ type: 'text_delta', text });
  }

  private wireProcess(): void {
    const { child } = this;
    child.stdin?.on('error', () => undefined);
    const lines = new LineSplitter();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) this.rpc.receive(line);
    });
    const errLines = new LineSplitter();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of errLines.push(chunk)) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
        this.spec.onStderr?.(line);
      }
    });
    child.once('error', (error) => {
      // spawn failure (ENOENT, EACCES): no 'exit' follows.
      if (child.pid === undefined) this.onExit(null, error.message);
    });
    child.once('exit', (code) => {
      const rest = lines.flush();
      if (rest !== null) this.rpc.receive(rest);
      this.onExit(code, null);
    });
  }

  private onExit(code: number | null, spawnError: string | null): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.exitCode = code;
    this.rpc.close(new Error(spawnError ?? `codex app-server exited (code ${code ?? 'null'})`));
    this.approvals.clear();
    if (this.activeTurnId !== null) {
      if (!this.closing) {
        this.emit([
          {
            type: 'error',
            message: `codex app-server exited unexpectedly (code ${code ?? 'null'})${this.stderrSuffix()}`,
            retryable: true,
          },
        ]);
      }
      this.emit(this.normalizer.abortTurn(this.closing ? 'interrupted' : 'exited'));
      this.activeTurnId = null;
    } else if (!this.closing && this.threadId) {
      this.emit([
        {
          type: 'error',
          message: `codex app-server exited (code ${code ?? 'null'})${this.stderrSuffix()}`,
          retryable: true,
        },
      ]);
    }
    this.turnDone.resolve();
    this.flushText();
    this.events.push({ type: 'exited', code: this.exitCode });
    this.events.end();
    this.exited.resolve();
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.filter((line) => /error|fatal|panic/i.test(line)).slice(-3);
    return tail.length > 0 ? `: ${tail.join(' | ')}` : '';
  }

  private assertOpen(): void {
    if (this.closing || this.hasExited) throw new Error('session is closed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
