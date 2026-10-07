/**
 * The interface every agent adapter implements (architecture §6): `adapters/claude`, `adapters/codex`
 * and `adapters/fake`. Adapters own process management and protocol translation; everything above them
 * (orchestrator, RPC, UI) only sees `AgentEvent`s.
 */
import { z } from 'zod';
import type { AttachmentKind } from './attachments';
import {
  type ApprovalDecision,
  ApprovalDecisionSchema,
  type Effort,
  type EngineKind,
  EngineKindSchema,
  type McpServer,
  ROLES,
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
 * - coordinate (future lead / assistant roles): the session may only talk, through the Legion MCP tools. Claude
 *   `dontAsk` with every file, shell, web and sub-agent tool disallowed; Codex `sandbox: read-only` (best effort:
 *   its tool list is not configurable).
 */
export interface PermissionProfile {
  mode: 'read_only' | 'workspace_write' | 'coordinate';
  /** Shell commands pre-approved for this session (the task's verify commands). Exact-match prefixes. */
  allowedCommands: readonly string[];
  /** Whether anything outside the profile is routed to the human (true) or simply denied (false). */
  askHuman: boolean;
  /** Web search and fetch tools are allowed (research roles). Claude: `WebSearch`/`WebFetch`; Codex: `web_search`. */
  web: boolean;
  /**
   * Who answers what `workspace_write` would ask (`settings.permissions.approvals`): the human (`ask`), or the
   * engine's own automatic review (`auto`: Claude's auto mode, Codex's auto-review approvals).
   */
  approvals: Approvals;
}

export type Approvals = 'ask' | 'auto';

export const ROLE_PERMISSION_MODE: { readonly [R in Role]: PermissionProfile['mode'] } = {
  planner: 'read_only',
  reviewer: 'read_only',
  finalizer: 'read_only',
  coder: 'workspace_write',
  resolver: 'workspace_write',
  lead: 'coordinate',
  researcher: 'read_only',
  research_lead: 'coordinate',
  assistant: 'coordinate',
};

/** Roles whose profile includes the web tools. */
export const WEB_ROLES: ReadonlySet<Role> = new Set<Role>(['researcher', 'research_lead']);

export function permissionProfileFor(
  role: Role,
  allowedCommands: readonly string[] = [],
  approvals: Approvals = 'ask',
): PermissionProfile {
  const mode = ROLE_PERMISSION_MODE[role];
  return {
    mode,
    allowedCommands: mode === 'workspace_write' ? allowedCommands : [],
    askHuman: mode === 'workspace_write',
    web: WEB_ROLES.has(role),
    approvals: mode === 'workspace_write' ? approvals : 'ask',
  };
}

/**
 * Roles that coordinate other agents: they get the messaging MCP tools (`list_agents`, `send_message`,
 * `wait_for_reply`) even without a parent. A non-coordinator gets the tools only when it was opened with a
 * parent attempt.
 */
export const COORDINATOR_ROLES: ReadonlySet<Role> = new Set<Role>(['lead', 'research_lead', 'assistant']);

/** Roles that may be given MCP servers and skills: every one that is more than a talker (`coordinate`). */
export const ACCESS_ROLES: readonly Role[] = ROLES.filter((role) => ROLE_PERMISSION_MODE[role] !== 'coordinate');

export interface McpConnection {
  /** Legion MCP server URL, e.g. http://127.0.0.1:43123/mcp */
  url: string;
  /** Per-session bearer token (maps to run/task/attempt/role in the MCP server). */
  token: string;
}

/**
 * The skills a session may use (`settings.access`, resolved by the orchestrator). Absent = the CLI's own
 * default set. `allow` names every permitted skill; `user` is the part of it that lives in the user's skill
 * folders, with the directory to expose (repo skills are found in the working directory by the adapter).
 */
export interface SessionSkills {
  allow: readonly string[];
  user: readonly { name: string; dir: string }[];
}

/**
 * What a session gets besides the built-in tools: the project's MCP servers and skill allowlist. Only sessions
 * that can do more than talk (not `coordinate`) get any.
 */
export function sessionExtras(opts: Pick<SessionOptions, 'permission' | 'extraMcp' | 'skills'>): {
  extraMcp: Readonly<Record<string, McpServer>>;
  skills: SessionSkills | null;
} {
  if (opts.permission.mode === 'coordinate') return { extraMcp: {}, skills: null };
  return { extraMcp: opts.extraMcp ?? {}, skills: opts.skills ?? null };
}

/**
 * A file sent to the agent with a message (`SessionOptions.attachments`, `AgentSession.send`). Adapters
 * read it from `path`: Claude gets images and PDFs as base64 content blocks, Codex gets images as
 * `localImage` inputs; text files are inlined (both), anything else is referenced by path.
 */
export interface SessionAttachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** Absolute path of the stored, content-addressed file. */
  path: string;
  size: number;
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
  /** MCP servers besides Legion's (name → server), from the project's access settings. Absent = none. */
  extraMcp?: Readonly<Record<string, McpServer>> | null;
  /** Skill allowlist; absent = the CLI's default set. Ignored for `coordinate` sessions. */
  skills?: SessionSkills | null;
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
  /** Files sent with `prompt` (the first message of this start/resume only). */
  attachments?: readonly SessionAttachment[] | null;
}

export interface AgentSession {
  readonly engine: EngineKind;
  /** Engine-native session/thread id. Empty string until `session_started` has been emitted. */
  readonly id: string;
  /** Normalized events. Ends after the `exited` event, when the process is gone. Single consumer. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Send a follow-up / steering message. `now` interrupts the current turn first if supported. */
  send(text: string, priority?: 'now' | 'next', attachments?: readonly SessionAttachment[] | null): Promise<void>;
  /** Stop the current turn but keep the session alive. */
  interrupt(): Promise<void>;
  /** Kill the process. Idempotent. */
  close(): Promise<void>;
  /** Answer an `approval_request` by its requestId. */
  respond(requestId: string, decision: ApprovalDecision): Promise<void>;
  /**
   * Switch a live `workspace_write` session's approvals. Resolves false when the engine refused (e.g. Claude's
   * auto mode is not available for the model: the session keeps asking). Absent: only new sessions change.
   */
  setApprovals?(approvals: Approvals): Promise<boolean>;
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
