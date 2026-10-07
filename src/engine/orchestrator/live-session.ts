/**
 * One live agent process bound to one `Attempt`: pumps the session's events into hooks (persistence,
 * inbox, usage), and hands the lifecycle code one `TurnResult` per finished turn.
 *
 * Takeover: `beginTakeover()` marks the session so that its end (we close it, a human resumes it in a
 * PTY) is not reported as an exit. `endTakeover()` (the PTY exited) resumes the engine session with a
 * hand-back prompt and keeps pumping, so the code waiting in `nextTurn()` never notices.
 */
import type { EngineKind, Role } from '@shared/domain';
import type { AgentEngine, AgentSession, SessionOptions } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import { deferred } from '../util/async-queue';

export interface AgentError {
  readonly message: string;
  readonly retryable: boolean;
}

export type TurnResult =
  | {
      readonly kind: 'turn';
      readonly structuredOutput: unknown;
      readonly isError: boolean;
      readonly reason: string | null;
      /** Last `error` event of the session, if any. */
      readonly error: AgentError | null;
    }
  | { readonly kind: 'exited'; readonly code: number | null; readonly error: AgentError | null };

export interface AttemptRef {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly role: Role;
}

export interface AgentRunHooks {
  onEvent(run: AgentRun, event: AgentEvent): void;
  /** The process is gone for good (not during a takeover). Called once. */
  onEnd(run: AgentRun): void;
  /** A takeover started (`taken: true`) or the session was resumed after it (`taken: false`). */
  onTakeover(run: AgentRun, taken: boolean): void;
  /** Whether the attempt may continue after a takeover (its run/task still active). Checked before resuming. */
  canHandBack(run: AgentRun): boolean;
}

export interface MarkDone {
  readonly summary: string;
  readonly commitMessage: string;
}

export const HANDBACK_PROMPT =
  'A human took over this session in a terminal and has now handed it back to you. Look at the current state of the working directory and continue your job from there, then finish exactly as originally instructed.';

export class AgentRun {
  /** Set by the MCP `mark_task_done` tool during the current turn. */
  markDone: MarkDone | null = null;
  lastError: AgentError | null = null;
  ended = false;
  /** The takeover ended after the run/task was cancelled, archived or finished: not resumed. */
  handBackRefused = false;
  /** Set while a human interrupt / steer is in progress: the interrupted turn is not a result. */
  humanInterrupt = false;
  /** A turn is running (from the prompt or a send until its `turn_complete`). */
  inTurn = false;
  private readonly results: TurnResult[] = [];
  private waiter: ((result: TurnResult) => void) | null = null;
  private exitCode: number | null = null;
  private closing = false;
  private takeover: ReturnType<typeof deferred<void>> | null = null;

  constructor(
    readonly attempt: AttemptRef,
    /** Engine kind the orchestrator asked for (rate limits and concurrency are tracked per nominal kind). */
    readonly nominal: EngineKind,
    readonly engine: AgentEngine,
    public session: AgentSession,
    readonly opts: SessionOptions,
    private readonly hooks: AgentRunHooks,
  ) {}

  get sessionId(): string {
    return this.session.id;
  }

  get takenOver(): boolean {
    return this.takeover !== null;
  }

  start(): void {
    this.inTurn = true;
    void this.pump(this.session);
  }

  /** The next finished turn, or the exit if the process ended first. */
  nextTurn(): Promise<TurnResult> {
    const ready = this.results.shift();
    if (ready) return Promise.resolve(ready);
    if (this.ended) return Promise.resolve({ kind: 'exited', code: this.exitCode, error: this.lastError });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Follow-up message in the same process (schema/validation retries). */
  async send(text: string): Promise<void> {
    this.markDone = null;
    this.inTurn = true;
    await this.session.send(text, 'next');
  }

  /**
   * A message from the human or another agent into this session. `next` joins the running turn (or starts
   * one when idle); `now` interrupts it first, and the interrupted turn is not reported as a result.
   */
  async steer(
    text: string,
    priority: 'now' | 'next',
    attachments: Parameters<AgentSession['send']>[2] = null,
  ): Promise<void> {
    if (priority === 'now' && this.inTurn) this.humanInterrupt = true;
    this.inTurn = true;
    await this.session.send(text, priority, attachments);
  }

  /** Record an event that did not come from the engine (the human's own messages) in the transcript. */
  record(event: AgentEvent): void {
    this.hooks.onEvent(this, event);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.takeover?.resolve();
    await this.session.close().catch(() => undefined);
  }

  /** Stop the structured session so a human can resume it in a terminal. */
  async beginTakeover(): Promise<void> {
    if (this.takeover || this.ended) throw new Error('session is not live');
    this.takeover = deferred<void>();
    this.hooks.onTakeover(this, true);
    await this.session.interrupt().catch(() => undefined);
    await this.session.close().catch(() => undefined);
  }

  /** The human is done (the PTY exited): resume the engine session. */
  endTakeover(): void {
    this.takeover?.resolve();
  }

  private push(result: TurnResult): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(result);
    } else {
      this.results.push(result);
    }
  }

  private handle(event: AgentEvent): void {
    this.hooks.onEvent(this, event);
    switch (event.type) {
      case 'error':
        this.lastError = { message: event.message, retryable: event.retryable };
        return;
      case 'exited':
        this.exitCode = event.code;
        return;
      case 'turn_complete':
        this.inTurn = false;
        if (this.takeover) return;
        if (event.reason === 'interrupted' && this.humanInterrupt) {
          this.humanInterrupt = false;
          return;
        }
        this.push({
          kind: 'turn',
          structuredOutput: event.structuredOutput,
          isError: event.isError,
          reason: event.reason,
          error: this.lastError,
        });
        if (!event.isError) this.lastError = null;
        return;
      default:
        return;
    }
  }

  private async pump(session: AgentSession): Promise<void> {
    try {
      for await (const event of session.events) this.handle(event);
    } catch (error) {
      this.lastError = { message: (error as Error).message, retryable: true };
    }
    const takeover = this.takeover;
    if (takeover && !this.closing) {
      await takeover.promise;
      this.takeover = null;
      if (!this.closing && !this.hooks.canHandBack(this)) {
        this.handBackRefused = true;
        this.lastError = { message: 'the run or task ended during the takeover', retryable: false };
      } else if (!this.closing) {
        try {
          const resumed = await this.engine.resume(session.id, {
            ...this.opts,
            prompt: HANDBACK_PROMPT,
            attachments: null,
          });
          if (this.closing || !this.hooks.canHandBack(this)) {
            // Cancelled / archived while the resume was in flight: never let the hand-back turn run.
            this.handBackRefused = !this.closing;
            await resumed.close().catch(() => undefined);
          } else {
            this.session = resumed;
            this.inTurn = true;
            this.hooks.onTakeover(this, false);
            void this.pump(this.session);
            return;
          }
        } catch (error) {
          this.lastError = { message: `could not resume after takeover: ${(error as Error).message}`, retryable: true };
        }
      }
    }
    this.ended = true;
    this.push({ kind: 'exited', code: this.exitCode, error: this.lastError });
    this.hooks.onEnd(this);
  }
}
