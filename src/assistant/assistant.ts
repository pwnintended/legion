/**
 * The agent the user talks to: one long-lived engine session in the working directory (the user's own CLI
 * settings apply), with Legion's MCP tools. The process is started on the first message and kept for the whole
 * conversation; if it exits, the next message resumes the same session.
 */
import { EventEmitter } from 'node:events';
import type { AgentEngine, AgentEvent, AgentSession, ApprovalDecision, Effort, McpServer } from '../engine/types.ts';
import { permissionProfile } from '../engine/types.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';

export interface AssistantApproval {
  id: string;
  tool: string;
  input: unknown;
  reason: string | null;
}

export interface AssistantOptions {
  cwd: string;
  /** The engine to talk to right now (a profile switch changes it). */
  engine: () => AgentEngine;
  systemPrompt: () => string;
  mcp: Readonly<Record<string, McpServer>>;
  model?: string | null;
  effort?: Effort | null;
  approvals?: 'ask' | 'auto';
  /** Resume this session (`legion --continue`). */
  sessionId?: string | null;
  log?: Logger;
}

export interface AssistantEvents {
  event: [AgentEvent];
  approval: [AssistantApproval];
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
  /** Profile the session id belongs to: a different profile cannot resume it. */
  private sessionProfile: string | null = null;
  private readonly pending = new Map<string, AssistantApproval>();
  private busyState = false;

  constructor(opts: AssistantOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.sessionId = opts.sessionId ?? null;
    if (this.sessionId) this.sessionProfile = opts.engine().profile.name;
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

  /** Ends the process (the session stays resumable). A different engine profile starts a fresh conversation. */
  async restart(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
    if (this.sessionProfile !== this.opts.engine().profile.name) {
      this.sessionId = null;
      this.sessionProfile = null;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
  }

  private open(prompt: string): Promise<AgentSession> {
    if (this.opening) {
      return this.opening.then(async (s) => {
        await s.send(prompt, 'next');
        return s;
      });
    }
    const engine = this.opts.engine();
    const canResume = this.sessionId !== null && this.sessionProfile === engine.profile.name;
    const opts = {
      cwd: this.opts.cwd,
      prompt,
      systemPrompt: this.opts.systemPrompt(),
      model: this.opts.model ?? null,
      effort: this.opts.effort ?? null,
      permission: permissionProfile('workspace_write', { approvals: this.opts.approvals ?? 'ask', web: true }),
      mcp: this.opts.mcp,
      userSettings: true,
    };
    this.opening = (canResume && this.sessionId ? engine.resume(this.sessionId, opts) : engine.start(opts))
      .then((session) => {
        this.session = session;
        this.sessionProfile = engine.profile.name;
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
            this.emit('session', { id: event.sessionId, profile: this.sessionProfile ?? '' });
            break;
          case 'approval_request': {
            const approval = { id: event.requestId, tool: event.tool, input: event.input, reason: event.reason };
            this.pending.set(approval.id, approval);
            this.emit('approval', approval);
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
    for (const id of this.pending.keys()) this.emit('resolved', id);
    this.pending.clear();
  }

  private setBusy(busy: boolean): void {
    if (this.busyState === busy) return;
    this.busyState = busy;
    this.emit('busy', busy);
  }
}
