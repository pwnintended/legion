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
  /** The engine to talk to right now (a profile switch changes it). */
  engine: () => AgentEngine;
  systemPrompt: () => string;
  mcp: Readonly<Record<string, McpServer>>;
  /** Read at every session start, so a config reload applies to the next conversation. */
  model?: () => string | null;
  effort?: () => Effort | null;
  /** Who answers its tool approvals (read at every session start). Default: allowed (`auto`). */
  approvals?: 'ask' | 'auto' | (() => 'ask' | 'auto');
  /** Resume this session (`legion --continue`). */
  sessionId?: string | null;
  log?: Logger;
}

export interface AssistantEvents {
  event: [AgentEvent];
  approval: [AssistantApproval];
  question: [AssistantQuestion];
  resolved: [string];
  busy: [boolean];
  session: [{ id: string; profile: string }];
}

export class Assistant extends EventEmitter<AssistantEvents> {
  private readonly opts: AssistantOptions;
  private readonly log: Logger;
  private session: AgentSession | null = null;
  private opening: Promise<AgentSession> | null = null;
  private sessionId: string | null;
  /** Engine and profile the session id belongs to: another engine or profile cannot resume it. */
  private sessionProfile: { kind: string; name: string } | null = null;
  private readonly pending = new Map<string, AssistantApproval>();
  private readonly questions = new Map<string, AssistantQuestion>();
  private busyState = false;

  constructor(opts: AssistantOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.sessionId = opts.sessionId ?? null;
    if (this.sessionId) this.sessionProfile = profileOf(opts.engine());
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

  /** Sends a user message: starts (or resumes) the session if needed, else queues it into the running one. */
  async send(text: string): Promise<void> {
    this.setBusy(true);
    try {
      if (this.session) {
        await this.session.send(text, 'next');
        return;
      }
      await this.open(text);
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

  /** Ends the process (the session stays resumable). A different engine profile starts a fresh conversation. */
  async restart(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
    if (!sameProfile(this.sessionProfile, this.opts.engine())) {
      this.sessionId = null;
      this.sessionProfile = null;
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

  private open(prompt: string): Promise<AgentSession> {
    if (this.opening) {
      return this.opening.then(async (s) => {
        await s.send(prompt, 'next');
        return s;
      });
    }
    const engine = this.opts.engine();
    const canResume = this.sessionId !== null && sameProfile(this.sessionProfile, engine);
    const opts = {
      cwd: this.opts.cwd,
      prompt,
      systemPrompt: this.opts.systemPrompt(),
      model: this.opts.model?.() ?? null,
      effort: this.opts.effort?.() ?? null,
      // The orchestrator and leads commit (leads on their own branch); workflow agents do not.
      permission: permissionProfile('workspace_write', { approvals: this.approvals(), web: true, git: true }),
      mcp: this.opts.mcp,
      userSettings: true,
    };
    this.opening = (canResume && this.sessionId ? engine.resume(this.sessionId, opts) : engine.start(opts))
      .then((session) => {
        this.session = session;
        this.sessionProfile = profileOf(engine);
        void this.pump(session);
        return session;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async pump(session: AgentSession): Promise<void> {
    try {
      for await (const event of session.events) {
        switch (event.type) {
          case 'session_started':
            this.sessionId = event.sessionId;
            this.emit('session', { id: event.sessionId, profile: this.sessionProfile?.name ?? '' });
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
          case 'turn_complete':
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
      this.emit('event', {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    } finally {
      if (this.session === session) this.session = null;
      this.dropApprovals();
      this.setBusy(false);
    }
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

function profileOf(engine: AgentEngine): { kind: string; name: string } {
  return { kind: engine.profile.kind, name: engine.profile.name };
}

/** Profiles of different engines can share a name (`default`), so the kind counts too. */
function sameProfile(saved: { kind: string; name: string } | null, engine: AgentEngine): boolean {
  return saved !== null && saved.kind === engine.profile.kind && saved.name === engine.profile.name;
}
