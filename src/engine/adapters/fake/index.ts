/**
 * Scripted fake `AgentEngine` for tests and the dev demo mode. It behaves like a long-lived CLI session:
 * `start` emits `session_started`, runs the first turn from the prompt, then idles until `send` (next
 * turn) or `close` (`exited`). Each turn is a list of `FakeStep`s produced by a script function.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentEngine,
  AgentSession,
  ApprovalDecision,
  Approvals,
  EngineInfo,
  SessionAttachment,
  SessionOptions,
} from '@shared/engine';
import type { AgentEvent, ToolKind } from '@shared/events';
import { AsyncQueue, deferred } from '../../util/async-queue';
import { fakeOutputFor } from './fixtures';

export * from './fixtures';

export type FakeStep =
  | { kind: 'emit'; event: AgentEvent }
  /** text_delta chunks followed by a final `message`. */
  | { kind: 'text'; text: string; chunkSize?: number }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; toolKind?: ToolKind; input?: unknown; output?: string | null; ok?: boolean }
  /** Emits `approval_request` and waits for `respond()`; the decision is recorded in `session.decisions`. */
  | {
      kind: 'approval';
      tool: string;
      input?: unknown;
      reason?: string | null;
      requestId?: string;
      /** Steps run only when the request is allowed. */
      onAllow?: FakeStep[];
    }
  /** Writes a file relative to cwd (escaping cwd is an error) and emits tool_call/tool_result/file_change. */
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number | null }
  /** Structured output reported on this turn's `turn_complete`. `'auto'` = derive from outputSchema. */
  | { kind: 'output'; value: unknown }
  /** error + failed turn_complete + exited(code); ends the session. */
  | { kind: 'fail'; message: string; retryable?: boolean; exitCode?: number }
  | { kind: 'delay'; ms: number };

export interface FakeTurnContext {
  opts: SessionOptions;
  /** 0 for the initial prompt, then 1, 2, ... for each `send`. */
  turn: number;
  /** The prompt (turn 0) or the sent text. */
  message: string;
  /** Files sent with this message (`opts.attachments` on turn 0, else `send`'s). */
  attachments: readonly SessionAttachment[];
  resumed: boolean;
}

export type FakeScript = (ctx: FakeTurnContext) => FakeStep[];

export const FAKE_SCENARIOS = {
  /** Short text, a read, structured output derived from the outputSchema (if any). */
  success: (ctx) => [
    { kind: 'text', text: `Fake ${ctx.opts.role} on it.` },
    { kind: 'tool', name: 'Read', toolKind: 'read', input: { path: 'README.md' }, output: '# readme' },
    { kind: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
    { kind: 'output', value: 'auto' },
  ],
  /** Coder that edits a file in cwd and reports done. */
  edit: () => [
    { kind: 'text', text: 'Writing the change.' },
    { kind: 'write_file', path: 'FAKE_CHANGE.md', content: 'fake change\n' },
    { kind: 'output', value: 'auto' },
  ],
  /** Asks for approval to run a command; writes a file only if allowed. */
  approval: () => [
    {
      kind: 'approval',
      tool: 'Bash',
      input: { command: 'touch APPROVED.md' },
      reason: 'needs to run a command',
      requestId: 'fake-approval-1',
      onAllow: [{ kind: 'write_file', path: 'APPROVED.md', content: 'approved\n' }],
    },
    { kind: 'output', value: 'auto' },
  ],
  /** Structured output only. */
  structured: () => [{ kind: 'output', value: 'auto' }],
  /** Fails with a retryable error. */
  fail: () => [
    { kind: 'text', text: 'Trying...' },
    { kind: 'fail', message: 'fake failure', retryable: true, exitCode: 1 },
  ],
} satisfies Record<string, FakeScript>;

export type FakeScenarioName = keyof typeof FAKE_SCENARIOS;

export interface FakeEngineOptions {
  /** Script or built-in scenario (default `success`). */
  script?: FakeScript | FakeScenarioName;
  /** Delay before each step, to make streams observable in the UI (default 0). */
  stepDelayMs?: number;
  /** Emit `exited` right after the first turn instead of idling (one-shot CLI style). */
  exitAfterTurn?: boolean;
  info?: Partial<EngineInfo>;
}

export interface FakeSessionRecord {
  id: string;
  opts: SessionOptions;
  resumed: boolean;
  session: FakeSession;
}

let sessionCounter = 0;

export class FakeEngine implements AgentEngine {
  readonly kind = 'fake' as const;
  /** Every session started or resumed, for test assertions. */
  readonly sessions: FakeSessionRecord[] = [];
  private readonly script: FakeScript;

  constructor(private readonly options: FakeEngineOptions = {}) {
    const script = options.script ?? 'success';
    this.script = typeof script === 'function' ? script : FAKE_SCENARIOS[script];
  }

  async probe(): Promise<EngineInfo> {
    return {
      kind: 'fake',
      installed: true,
      path: null,
      version: 'fake-1.0.0',
      loggedIn: true,
      account: 'fake@legion.test',
      models: ['fake-small', 'fake-large'],
      error: null,
      probedAt: Date.now(),
      ...this.options.info,
    };
  }

  async start(opts: SessionOptions): Promise<AgentSession> {
    sessionCounter += 1;
    return this.open(`fake-session-${process.pid}-${sessionCounter}`, opts, false);
  }

  async resume(sessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(sessionId, opts, true);
  }

  private open(id: string, opts: SessionOptions, resumed: boolean): FakeSession {
    const session = new FakeSession(id, opts, resumed, this.script, this.options);
    this.sessions.push({ id, opts, resumed, session });
    session.begin();
    return session;
  }
}

class Interrupted extends Error {}

export class FakeSession implements AgentSession {
  readonly engine = 'fake' as const;
  readonly events = new AsyncQueue<AgentEvent>();
  /** Approval decisions received, by requestId. */
  readonly decisions = new Map<string, ApprovalDecision>();
  /** Messages received through `send`. */
  readonly sent: { text: string; priority: 'now' | 'next'; attachments: readonly SessionAttachment[] }[] = [];
  /** Every `setApprovals` call, in order. */
  readonly approvalSwitches: Approvals[] = [];

  private sessionId = '';
  private turn = 0;
  private closed = false;
  private turnAbort: AbortController | null = null;
  private turnDone: Promise<void> = Promise.resolve();
  private readonly approvals = new Map<string, ReturnType<typeof deferred<ApprovalDecision>>>();

  constructor(
    private readonly initialId: string,
    private readonly opts: SessionOptions,
    private readonly resumed: boolean,
    private readonly script: FakeScript,
    private readonly options: FakeEngineOptions,
  ) {
    opts.signal?.addEventListener('abort', () => void this.close(), { once: true });
  }

  get id(): string {
    return this.sessionId;
  }

  begin(): void {
    this.sessionId = this.initialId;
    this.emit({
      type: 'session_started',
      sessionId: this.sessionId,
      model: this.opts.model ?? 'fake-small',
      version: 'fake-1.0.0',
    });
    this.startTurn(this.opts.prompt, this.opts.attachments ?? []);
  }

  private emit(event: AgentEvent): void {
    if (!this.closed) this.events.push(event);
  }

  private startTurn(message: string, attachments: readonly SessionAttachment[]): void {
    const abort = new AbortController();
    this.turnAbort = abort;
    const steps = this.script({ opts: this.opts, turn: this.turn, message, attachments, resumed: this.resumed });
    this.turn += 1;
    this.turnDone = this.runTurn(steps, abort.signal).finally(() => {
      if (this.turnAbort === abort) this.turnAbort = null;
    });
  }

  private async runTurn(steps: FakeStep[], signal: AbortSignal): Promise<void> {
    const state = { output: null as unknown, failed: false };
    try {
      await this.runSteps(steps, signal, state);
      if (state.failed) return;
      this.emit({ type: 'turn_complete', structuredOutput: state.output, isError: false, reason: null });
      if (this.options.exitAfterTurn) await this.finish(0);
    } catch (error) {
      if (error instanceof Interrupted) {
        this.emit({ type: 'turn_complete', structuredOutput: null, isError: true, reason: 'interrupted' });
        return;
      }
      this.emit({ type: 'error', message: (error as Error).message, retryable: false });
      this.emit({ type: 'turn_complete', structuredOutput: null, isError: true, reason: 'error' });
      await this.finish(1);
    }
  }

  private async runSteps(
    steps: FakeStep[],
    signal: AbortSignal,
    state: { output: unknown; failed: boolean },
  ): Promise<void> {
    for (const step of steps) {
      if (this.closed || state.failed) return;
      if (signal.aborted) throw new Interrupted();
      if (this.options.stepDelayMs) await this.wait(this.options.stepDelayMs, signal);
      await this.runStep(step, signal, state);
    }
  }

  private async runStep(
    step: FakeStep,
    signal: AbortSignal,
    state: { output: unknown; failed: boolean },
  ): Promise<void> {
    switch (step.kind) {
      case 'emit':
        this.emit(step.event);
        return;
      case 'text': {
        const size = step.chunkSize ?? 16;
        for (let i = 0; i < step.text.length; i += size) {
          this.emit({ type: 'text_delta', text: step.text.slice(i, i + size) });
        }
        this.emit({ type: 'message', text: step.text });
        return;
      }
      case 'reasoning':
        this.emit({ type: 'reasoning', text: step.text });
        return;
      case 'tool': {
        const id = `fake-tool-${Math.random().toString(36).slice(2, 10)}`;
        this.emit({ type: 'tool_call', id, name: step.name, input: step.input ?? {}, kind: step.toolKind ?? 'other' });
        this.emit({ type: 'tool_result', id, ok: step.ok ?? true, output: step.output ?? null });
        return;
      }
      case 'approval': {
        const requestId = step.requestId ?? `fake-approval-${Math.random().toString(36).slice(2, 10)}`;
        const pending = deferred<ApprovalDecision>();
        this.approvals.set(requestId, pending);
        this.emit({
          type: 'approval_request',
          requestId,
          tool: step.tool,
          input: step.input ?? {},
          reason: step.reason ?? null,
        });
        const decision = await this.race(pending.promise, signal);
        this.approvals.delete(requestId);
        if (decision.behavior === 'allow') {
          await this.runSteps(step.onAllow ?? [], signal, state);
        } else {
          this.emit({ type: 'message', text: `Approval denied: ${decision.message}` });
          if (decision.interrupt) throw new Interrupted();
        }
        return;
      }
      case 'write_file':
        await this.writeFile(step.path, step.content);
        return;
      case 'usage':
        this.emit({
          type: 'usage',
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          costUsd: step.costUsd ?? null,
        });
        return;
      case 'output':
        state.output = step.value === 'auto' ? fakeOutputFor(this.opts.outputSchema) : step.value;
        return;
      case 'fail':
        state.failed = true;
        this.emit({ type: 'error', message: step.message, retryable: step.retryable ?? false });
        this.emit({ type: 'turn_complete', structuredOutput: null, isError: true, reason: step.message });
        await this.finish(step.exitCode ?? 1);
        return;
      case 'delay':
        await this.wait(step.ms, signal);
        return;
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const target = resolve(this.opts.cwd, path);
    const rel = relative(this.opts.cwd, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`fake write outside cwd: ${path}`);
    const id = `fake-edit-${Math.random().toString(36).slice(2, 10)}`;
    this.emit({ type: 'tool_call', id, name: 'Write', input: { path: rel, content }, kind: 'edit' });
    const previous = await readFile(target, 'utf8').catch(() => null);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    this.emit({ type: 'tool_result', id, ok: true, output: null });
    this.emit({
      type: 'file_change',
      path: rel,
      added: countLines(content),
      removed: previous === null ? 0 : countLines(previous),
    });
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return this.race(new Promise((done) => setTimeout(done, ms)), signal);
  }

  private race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Interrupted());
    return new Promise<T>((res, rej) => {
      const onAbort = () => rej(new Interrupted());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          res(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          rej(error);
        },
      );
    });
  }

  private async finish(code: number | null): Promise<void> {
    if (this.closed) return;
    this.emit({ type: 'exited', code });
    this.closed = true;
    this.turnAbort?.abort();
    this.events.end();
  }

  async send(
    text: string,
    priority: 'now' | 'next' = 'next',
    attachments?: readonly SessionAttachment[] | null,
  ): Promise<void> {
    if (this.closed) throw new Error('session is closed');
    this.sent.push({ text, priority, attachments: attachments ?? [] });
    if (priority === 'now') this.turnAbort?.abort();
    await this.turnDone;
    if (this.closed) throw new Error('session is closed');
    this.startTurn(text, attachments ?? []);
  }

  async interrupt(): Promise<void> {
    this.turnAbort?.abort();
    await this.turnDone;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.turnAbort?.abort();
    await this.turnDone.catch(() => undefined);
    await this.finish(0);
  }

  async setApprovals(approvals: Approvals): Promise<boolean> {
    this.approvalSwitches.push(approvals);
    return !this.closed;
  }

  async respond(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    this.decisions.set(requestId, decision);
    pending.resolve(decision);
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}
