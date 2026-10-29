/**
 * The agent the user talks to: one long-lived engine session in the working directory (the user's own CLI
 * settings apply), with Legion's MCP tools. The process is started on the first message and kept for the whole
 * conversation; if it exits, the next message resumes the same session.
 */
import { EventEmitter } from 'node:events';
import type {
  AgentEngine,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  Effort,
  McpServer,
  QuestionAnswers,
  UserQuestion,
} from '../engine/types.ts';
import { permissionProfile } from '../engine/types.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';

export interface AssistantApproval {
  id: string;
  tool: string;
  input: unknown;
  reason: string | null;
}

/** Questions the agent asks the user (`AskUserQuestion` / `request_user_input`). */
export interface AssistantQuestion {
  id: string;
  questions: UserQuestion[];
}

export interface AssistantOptions {
  cwd: string;
  /**
   * The engine to talk to right now: the caller keeps the same account across calls (affinity) until it hits a limit.
   * A conversation only continues on the account it started on.
   */
  engine: () => AgentEngine;
  /**
   * The account hit its limit during a turn. Cools it down and returns what to tell the user; the next
   * `engine()` should then be another account, and the next message starts a new conversation on it.
   */
  onLimit?: (engine: AgentEngine, event: Extract<AgentEvent, { type: 'limit_reached' }>) => string | null;
  systemPrompt: () => string;
  mcp: Readonly<Record<string, McpServer>>;
  /** Read at every session start, so a config reload applies to the next conversation. */
  model?: () => string | null;
  effort?: () => Effort | null;
  /** Who answers its tool approvals (read at every session start). Default: allowed (`auto`). */
  approvals?: 'ask' | 'auto' | (() => 'ask' | 'auto');
  /** Resume this session (`legion --continue`), which belongs to this account. */
  sessionId?: string | null;
  sessionAccount?: { kind: string; name: string } | null;
  log?: Logger;
}

export interface AssistantEvents {
  event: [AgentEvent];
  approval: [AssistantApproval];
  question: [AssistantQuestion];
  resolved: [string];
  busy: [boolean];
  session: [{ id: string; account: string }];
}

export class Assistant extends EventEmitter<AssistantEvents> {
  private readonly opts: AssistantOptions;
  private readonly log: Logger;
  private session: AgentSession | null = null;
  private opening: Promise<AgentSession> | null = null;
  private sessionId: string | null;
  /** Engine and account the session id belongs to: another engine or account cannot resume it. */
  private sessionAccount: { kind: string; name: string } | null = null;
  private readonly pending = new Map<string, AssistantApproval>();
  private readonly questions = new Map<string, AssistantQuestion>();
  private busyState = false;
  /** Counts the sessions opened: a pump whose session is no longer the latest leaves the state alone. */
  private generation = 0;

  constructor(opts: AssistantOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.sessionId = opts.sessionId ?? null;
    if (this.sessionId && opts.sessionAccount) this.sessionAccount = opts.sessionAccount;
  }

  get busy(): boolean {
    return this.busyState;
  }

  get id(): string | null {
    return this.sessionId;
  }

  pendingApprovals(): AssistantApproval[] {
    return [...this.pending.values()];
  }

  /**
   * Sends a user message (with `images`, paths to PNG files): starts (or resumes) the session if needed, else
   * queues it into the running one.
   */
  async send(text: string, images: readonly string[] = []): Promise<void> {
    this.setBusy(true);
    try {
      if (this.session) {
        await this.session.send(text, 'next', images);
        return;
      }
      await this.open(text, images);
    } catch (err) {
      this.setBusy(false);
      throw err;
    }
  }

  /** A note from Legion itself (a run finished). Only delivered into a conversation that exists. */
  async notify(text: string): Promise<boolean> {
    if (!this.session && !this.sessionId) return false;
    await this.send(text);
    return true;
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt();
  }

  async answer(id: string, decision: ApprovalDecision): Promise<void> {
    if (!this.pending.delete(id)) return;
    this.emit('resolved', id);
    await this.session?.respond(id, decision).catch((err: unknown) => this.log.warn('approval answer failed', err));
  }

  /** Answers the agent's questions; null declines them. */
  async answerQuestions(id: string, answers: QuestionAnswers | null): Promise<void> {
    if (!this.questions.delete(id)) return;
    this.emit('resolved', id);
    await this.session?.answer(id, answers).catch((err: unknown) => this.log.warn('question answer failed', err));
  }

  pendingQuestions(): AssistantQuestion[] {
    return [...this.questions.values()];
  }

  /** Ends the process (the session stays resumable). A different engine account starts a fresh conversation. */
  async restart(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
    let same = false;
    try {
      same = sameAccount(this.sessionAccount, this.opts.engine());
    } catch {
      // Nothing free: the next message reports it.
    }
    if (!same) {
      this.sessionId = null;
      this.sessionAccount = null;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
  }

  private approvals(): 'ask' | 'auto' {
    const a = this.opts.approvals;
    return (typeof a === 'function' ? a() : a) ?? 'auto';
  }

  private open(prompt: string, images: readonly string[] = []): Promise<AgentSession> {
    if (this.opening) {
      return this.opening.then(async (s) => {
        await s.send(prompt, 'next', images);
        return s;
      });
    }
    const engine = this.opts.engine();
    const canResume = this.sessionId !== null && sameAccount(this.sessionAccount, engine);
    const opts = {
      cwd: this.opts.cwd,
      prompt,
      images,
      systemPrompt: this.opts.systemPrompt(),
      model: this.opts.model?.() ?? null,
      effort: this.opts.effort?.() ?? null,
      // The orchestrator and leads commit (leads on their own branch); workflow agents do not.
      permission: permissionProfile('workspace_write', { approvals: this.approvals(), web: true, git: true }),
      mcp: this.opts.mcp,
      userSettings: true,
    };
    // Counted when opening starts, so the session it replaces stands down at once.
    const generation = ++this.generation;
    this.opening = (canResume && this.sessionId ? engine.resume(this.sessionId, opts) : engine.start(opts))
      .then((session) => {
        this.session = session;
        this.sessionAccount = accountOf(engine);
        void this.pump(session, engine, generation);
        return session;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async pump(session: AgentSession, engine: AgentEngine, generation: number): Promise<void> {
    let limited = false;
    // Once another session took over (after a limit or a restart), what is left of this one's stream while its
    // process ends must not touch the conversation, the approvals or the busy state: they are the new one's.
    const replaced = () => this.generation !== generation;
    try {
      for await (const event of session.events) {
        if (replaced()) continue;
        switch (event.type) {
          case 'session_started':
            this.sessionId = event.sessionId;
            this.emit('session', { id: event.sessionId, account: this.sessionAccount?.name ?? '' });
            break;
          case 'approval_request': {
            const approval = { id: event.requestId, tool: event.tool, input: event.input, reason: event.reason };
            this.pending.set(approval.id, approval);
            this.emit('approval', approval);
            break;
          }
          case 'question': {
            const question = { id: event.requestId, questions: event.questions };
            this.questions.set(question.id, question);
            this.emit('question', question);
            break;
          }
          case 'limit_reached': {
            // This conversation cannot go on with this account: the next message starts a new one elsewhere.
            limited = true;
            const note = this.opts.onLimit?.(engine, event) ?? null;
            if (note) this.emit('event', { type: 'error', message: note, retryable: false });
            break;
          }
          case 'turn_complete':
            if (limited) this.retire(session);
            this.dropApprovals();
            this.setBusy(false);
            break;
          default:
            break;
        }
        this.emit('event', event);
      }
    } catch (err) {
      this.log.error('assistant session failed', err);
      if (replaced()) return;
      this.emit('event', {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    } finally {
      if (!replaced()) {
        if (limited) this.retire(session);
        if (this.session === session) this.session = null;
        this.dropApprovals();
        this.setBusy(false);
      }
    }
  }

  /** Forgets a conversation whose account hit its limit; the process ends. */
  private retire(session: AgentSession): void {
    if (this.session === session) this.session = null;
    this.sessionId = null;
    this.sessionAccount = null;
    void session.close().catch(() => undefined);
  }

  /** Approvals do not outlive their turn (the CLI withdraws them). */
  private dropApprovals(): void {
    for (const id of [...this.pending.keys(), ...this.questions.keys()]) this.emit('resolved', id);
    this.pending.clear();
    this.questions.clear();
  }

  private setBusy(busy: boolean): void {
    if (this.busyState === busy) return;
    this.busyState = busy;
    this.emit('busy', busy);
  }
}

function accountOf(engine: AgentEngine): { kind: string; name: string } {
  return { kind: engine.account.kind, name: engine.account.name };
}

/** Accounts of different engines can share a name (`default`), so the kind counts too. */
function sameAccount(saved: { kind: string; name: string } | null, engine: AgentEngine): boolean {
  return saved !== null && saved.kind === engine.account.kind && saved.name === engine.account.name;
}
