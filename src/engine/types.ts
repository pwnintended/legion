/**
 * The interface every agent adapter implements: `engine/claude`, `engine/codex` and `engine/fake`. Adapters own
 * process management and protocol translation; everything above them (workflow runtime, assistant, TUI) only sees
 * `AgentEvent`s.
 */

export const ENGINE_KINDS = ['claude', 'codex', 'fake'] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** A JSON Schema object (see `util/json-schema.ts` → `toStrictJsonSchema`). */
export type JsonSchema = { readonly [key: string]: unknown };

/**
 * How to launch an engine's CLI: the session's profile for that kind (`config.ts`). The binary is spawned
 * directly (no shell), with `env` laid over the process environment.
 */
export interface EngineProfile {
  /** Profile name as configured, e.g. "claude-1". Recorded in run journals so resumes use the same account. */
  name: string;
  kind: EngineKind;
  /** Binary name or path, e.g. "claude". */
  command: string;
  /** Extra arguments placed before the adapter's own. */
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface EngineInfo {
  kind: EngineKind;
  profile: string;
  installed: boolean;
  /** Absolute path of the resolved binary. */
  path: string | null;
  version: string | null;
  /** null = unknown (could not determine without a network call). */
  loggedIn: boolean | null;
  /** Human-readable reason when not usable. */
  error: string | null;
}

/**
 * What a session may do.
 * - read_only (planners, reviewers): Claude `--permission-mode default` with edit tools disallowed; what it would
 *   ask is answered by a host-side policy (read-only probes and reads pass, the rest is denied), never a human;
 *   Codex `sandbox: read-only`, `approvalPolicy: never`.
 * - workspace_write (coders, the assistant): Claude `acceptEdits` + curated allowed tools; everything else is asked
 *   in-band (`approval_request`); Codex `sandbox: workspace-write`, `approvalPolicy: on-request`. With
 *   `approvals: auto` things are allowed by default: Claude's auto mode (its classifier answers), Codex with no
 *   sandbox and no approvals (`--dangerously-bypass-approvals-and-sandbox`).
 */
export interface PermissionProfile {
  mode: 'read_only' | 'workspace_write';
  /** Shell commands pre-approved for this session. Exact-match prefixes (`util/shell.ts`). */
  allowedCommands: readonly string[];
  /** Web search and fetch tools are allowed. */
  web: boolean;
  /** What `workspace_write` would ask: the human answers (`ask`), or it is allowed (`auto`: Claude auto mode, Codex bypass). */
  approvals: Approvals;
  /**
   * May run `git commit` and `git push` itself (the assistant and leads, `workspace_write` only). Workflow agents may
   * not: their workflow commits and merges through its git steps.
   */
  git: boolean;
}

export type Approvals = 'ask' | 'auto';

export function permissionProfile(
  mode: PermissionProfile['mode'],
  opts: Partial<Omit<PermissionProfile, 'mode'>> = {},
): PermissionProfile {
  return {
    mode,
    allowedCommands: mode === 'workspace_write' ? (opts.allowedCommands ?? []) : [],
    web: opts.web ?? false,
    approvals: mode === 'workspace_write' ? (opts.approvals ?? 'ask') : 'ask',
    git: mode === 'workspace_write' && (opts.git ?? false),
  };
}

/** An MCP server handed to a session. */
export type McpServer =
  | { type: 'http'; url: string; headers: Readonly<Record<string, string>> }
  | { type: 'stdio'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> };

export interface SessionOptions {
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
  /** MCP servers by name (e.g. `legion` for the assistant's workflow tools). */
  mcp?: Readonly<Record<string, McpServer>> | null;
  /** Extra environment for the child process, laid over the profile's env. */
  env?: Readonly<Record<string, string>>;
  /** Extra readable (and, for workspace_write, writable) directories. */
  addDirs?: readonly string[];
  /** Aborting it is equivalent to `session.close()`. */
  signal?: AbortSignal;
  /**
   * The working directory holds content another agent wrote (reviewers): load no configuration from it.
   * Claude: no setting sources; Codex: no project docs (`AGENTS.md`).
   */
  untrustedWorkdir?: boolean;
  /**
   * Run like a plain CLI started by the human: the user's own settings, skills, plugins, hooks and MCP servers
   * apply. Claude only; `untrustedWorkdir` wins. Used for the assistant.
   */
  userSettings?: boolean;
}

export type ApprovalDecision =
  | {
      behavior: 'allow';
      scope: 'once' | 'session';
      /** Replacement tool input (Claude only); null = use the original input. */
      updatedInput: unknown;
    }
  | { behavior: 'deny'; message: string; interrupt: boolean };

export type ToolKind = 'read' | 'edit' | 'command' | 'mcp' | 'other';

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type AgentEvent =
  | { type: 'session_started'; sessionId: string; model: string | null; version: string | null }
  /** Streaming assistant text, coalesced by the adapter. */
  | { type: 'text_delta'; text: string }
  /** Final assistant text of one message. */
  | { type: 'message'; text: string }
  | { type: 'reasoning'; text: string }
  /** What the model is producing before it shows up as an event of its own. */
  | { type: 'activity'; activity: 'thinking' | 'output' | 'tool_input'; tool: string | null; chars: number }
  | { type: 'tool_call'; id: string; name: string; input: unknown; kind: ToolKind }
  | { type: 'tool_result'; id: string; ok: boolean; output: string | null }
  | { type: 'file_change'; path: string; added: number; removed: number }
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'approval_request'; requestId: string; tool: string; input: unknown; reason: string | null }
  /** The agent asks the user (Claude `AskUserQuestion`, Codex `request_user_input`); answer with `answer()`. */
  | { type: 'question'; requestId: string; questions: UserQuestion[] }
  /** Cumulative for the session when the engine reports it: take the latest, never sum. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'rate_limit'; engine: EngineKind; window: string; usedPct: number; resetsAt: number | null }
  /**
   * The account is out of quota (not a transient 429 the CLI retries itself). Emitted just before the failing
   * `error` / `turn_complete`. `resetsAt` is epoch ms when the CLI reported one.
   */
  | { type: 'limit_reached'; engine: EngineKind; kind: 'usage' | 'rate'; resetsAt: number | null; message: string }
  | { type: 'turn_complete'; structuredOutput: unknown; isError: boolean; reason: string | null }
  | { type: 'error'; message: string; retryable: boolean }
  /** Always the last event of a session's stream. */
  | { type: 'exited'; code: number | null };

export type AgentEventType = AgentEvent['type'];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

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
  /** Answer a `question` by its requestId; null when the user declines to answer. */
  answer(requestId: string, answers: QuestionAnswers | null): Promise<void>;
}

/** One question an agent asks the user, the same shape for both engines. */
export interface UserQuestion {
  /** What the answer is keyed by. */
  id: string;
  /** A short label (a chip), when the agent gave one. */
  header: string | null;
  question: string;
  options: { label: string; description: string | null }[];
  /** More than one option may be picked. */
  multiSelect: boolean;
  /** A typed answer is allowed besides the options (always, when there are none). */
  allowOther: boolean;
  /** The answer should not be shown (a password, a token). */
  secret: boolean;
}

/** Answers by question id: the picked option labels, or the typed text, as a list. */
export type QuestionAnswers = Record<string, string[]>;

export interface AgentEngine {
  readonly kind: EngineKind;
  readonly profile: EngineProfile;
  /** Installed? version? logged in? Must not start a model turn. */
  probe(): Promise<EngineInfo>;
  /** Start a new session. Resolves once the process is spawned (not when the turn ends). */
  start(opts: SessionOptions): Promise<AgentSession>;
  /** Resume an existing engine-native session with a new prompt. */
  resume(sessionId: string, opts: SessionOptions): Promise<AgentSession>;
}

/**
 * Herdr's pane variables: with them, a worker's own Herdr hook would report its session as the pane's agent
 * (Legion reports the pane itself, see tui/herdr.ts).
 */
export const HERDR_ENV_PREFIX = 'HERDR_';
