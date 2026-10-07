/**
 * The interface every agent adapter implements (architecture §6): `adapters/claude`, `adapters/codex`
 * and `adapters/fake`. Adapters own process management and protocol translation; everything above them
 * (orchestrator, RPC, UI) only sees `AgentEvent`s.
 */
import { z } from 'zod';
import {
  type ApprovalDecision,
  ApprovalDecisionSchema,
  type Effort,
  type EngineKind,
  EngineKindSchema,
  type Role,
} from './domain';
import type { AgentEvent } from './events';

export type { ApprovalDecision, EngineKind, Role };
export { ApprovalDecisionSchema };

/** A JSON Schema object (see `schemas/json-schema.ts` → `toStrictJsonSchema`). */
export type JsonSchema = { readonly [key: string]: unknown };

export const EngineInfoSchema = z.object({
  kind: EngineKindSchema,
  installed: z.boolean(),
  /** Absolute path of the resolved binary. */
  path: z.string().nullable(),
  version: z.string().nullable(),
  /** null = unknown (could not determine without a network call). */
  loggedIn: z.boolean().nullable(),
  /** Account label if the CLI reports one (email / plan), for display only. */
  account: z.string().nullable(),
  /** Models the engine offers, if it can list them. */
  models: z.array(z.string()),
  /** Human-readable reason when not usable. */
  error: z.string().nullable(),
  probedAt: z.number().int(),
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;

/**
 * What a session may do. Roles map to profiles via `permissionProfileFor`:
 * - read_only (planner, reviewer, finalizer): Claude `--permission-mode dontAsk` with edit tools
 *   disallowed; Codex `sandbox: read-only`, `approvalPolicy: never`.
 * - workspace_write (coder, resolver): Claude `acceptEdits` + curated allowed tools; everything else is
 *   asked in-band (`--permission-prompt-tool stdio` → `can_use_tool` control requests → `approval_request`);
 *   Codex `sandbox: workspace-write`, `approvalPolicy: on-request` (`item/<kind>/requestApproval`).
 */
export interface PermissionProfile {
  mode: 'read_only' | 'workspace_write';
  /** Shell commands pre-approved for this session (the task's verify commands). Exact-match prefixes. */
  allowedCommands: readonly string[];
  /** Whether anything outside the profile is routed to the human (true) or simply denied (false). */
  askHuman: boolean;
}

export const ROLE_PERMISSION_MODE: { readonly [R in Role]: PermissionProfile['mode'] } = {
  planner: 'read_only',
  reviewer: 'read_only',
  finalizer: 'read_only',
  coder: 'workspace_write',
  resolver: 'workspace_write',
};

export function permissionProfileFor(role: Role, allowedCommands: readonly string[] = []): PermissionProfile {
  const mode = ROLE_PERMISSION_MODE[role];
  return {
    mode,
    allowedCommands: mode === 'workspace_write' ? allowedCommands : [],
    askHuman: mode === 'workspace_write',
  };
}

export interface McpConnection {
  /** Legion MCP server URL, e.g. http://127.0.0.1:43123/mcp */
  url: string;
  /** Per-session bearer token (maps to run/task/attempt/role in the MCP server). */
  token: string;
}

export interface SessionOptions {
  role: Role;
  /** Working directory: the task worktree for coders, the integration worktree or repo for others. */
  cwd: string;
  /** First user message of the session (or the follow-up message when resuming). */
  prompt: string;
  /** Appended to the engine's own system prompt. */
  systemPrompt?: string | null;
  model?: string | null;
  effort?: Effort | null;
  permission: PermissionProfile;
  /** Strict JSON schema for structured output (Claude `--json-schema`, Codex `outputSchema`). */
  outputSchema?: JsonSchema | null;
  /** null = no Legion MCP tools (tests). */
  mcp: McpConnection | null;
  /** Full environment for the child process (login-shell PATH already resolved by main). */
  env: Readonly<Record<string, string>>;
  /**
   * Extra directories. Claude: `--add-dir` (readable, and writable under `acceptEdits`). Codex: extra
   * `writable_roots` for workspace-write sessions (read-only sessions can read everything anyway).
   */
  addDirs?: readonly string[];
  /** Aborting it is equivalent to `session.close()`. */
  signal?: AbortSignal;
  /**
   * The working directory holds content another agent wrote (reviewer, finalizer): load no configuration
   * from it. Claude: no setting sources at all (no project `.claude/settings*.json`, hooks or permissions);
   * Codex: no project docs (`AGENTS.md`). Absent/false = the repo's own project settings apply.
   */
  untrustedWorkdir?: boolean;
}

export interface AgentSession {
  readonly engine: EngineKind;
  /** Engine-native session/thread id. Empty string until `session_started` has been emitted. */
  readonly id: string;
  /** Normalized events. Ends after the `exited` event, when the process is gone. Single consumer. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Send a follow-up / steering message. `now` interrupts the current turn first if supported. */
  send(text: string, priority?: 'now' | 'next'): Promise<void>;
  /** Stop the current turn but keep the session alive. */
  interrupt(): Promise<void>;
  /** Kill the process. Idempotent. */
  close(): Promise<void>;
  /** Answer an `approval_request` by its requestId. */
  respond(requestId: string, decision: ApprovalDecision): Promise<void>;
}

export interface AgentEngine {
  readonly kind: EngineKind;
  /** Installed? version? logged in? Must not start a model turn. */
  probe(): Promise<EngineInfo>;
  /** Start a new session. Resolves once the process is spawned (not when the turn ends). */
  start(opts: SessionOptions): Promise<AgentSession>;
  /** Resume an existing engine-native session with a new prompt. */
  resume(sessionId: string, opts: SessionOptions): Promise<AgentSession>;
}
