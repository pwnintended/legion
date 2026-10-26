/**
 * Pure command-line builder for the `claude` CLI (flags verified against 2.1.289 `claude --help`).
 *
 * Every flag is re-passed on resume: the CLI does not restore model, permissions, MCP config, add-dirs or
 * settings from the transcript.
 */
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hasShellMeta } from '../../util/shell.ts';
import type { McpServer, PermissionProfile, SessionOptions } from '../types.ts';
import { READ_ONLY_GUIDE } from './read-only-policy.ts';

/** Base flags: headless, stream-json both ways, partial messages for live text. */
export const BASE_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  // Echoes each stdin user message when the CLI takes it in: how the session knows a steer is still queued.
  '--replay-user-messages',
];

/**
 * Flag settings (`--settings <json>`). Auto-memory is off so agents never write
 * `$CLAUDE_CONFIG_DIR/projects/<cwd>/memory/` (the CLI does so even in `dontAsk` mode when asked to "remember").
 */
export const LEGION_FLAG_SETTINGS = { autoMemoryEnabled: false } as const;

export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Never allowed, whatever the profile: Legion owns commits, remotes and worktrees, and an agent must not
 * leave anything running or scheduled behind (these tools ship with the CLI and some need no permission).
 */
export const ALWAYS_DENIED: readonly string[] = [
  'Bash(git commit *)',
  'Bash(git push *)',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
];

/** Tools a read-only session must not even see (removed from the model's context). */
export const READ_ONLY_DENIED: readonly string[] = [...EDIT_TOOLS, 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

export const WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch'];

/** MCP server names become tool prefixes (`mcp__<name>__<tool>`) and comma-separated rules. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * `Bash(cmd)` + `Bash(cmd *)`: the exact command and the command with arguments (the CLI's matcher is
 * operator-aware, so `Bash(cmd *)` never covers `cmd && other`). A command that itself contains shell
 * syntax only gets its exact rule, the same strictness as the Codex pre-approval (`util/shell.ts`).
 */
export function bashRules(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];
  return hasShellMeta(trimmed) ? [`Bash(${trimmed})`] : [`Bash(${trimmed})`, `Bash(${trimmed} *)`];
}

export interface PermissionArgs {
  mode: 'acceptEdits' | 'default';
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * Map a `PermissionProfile` onto Claude's permission flags. Prompts always go to the host over the control
 * protocol (`--permission-prompt-tool stdio` → `can_use_tool`).
 *
 * Reads (Read/Grep/Glob) inside cwd + `--add-dir`s and shell commands the CLI itself classifies as
 * read-only (`ls`, `git diff`, ...) are allowed in every mode without rules, so they are deliberately not
 * listed: a bare `Read` rule would also allow reading outside the worktree. Edits are covered by
 * `acceptEdits` (working directories only). Anything else asks the host.
 *
 * `read_only` runs in `default` with the prompt tool, not `dontAsk`: `dontAsk` never calls the host and
 * denies every shell command off the CLI's fixed (not configurable) read-only set, so a chain with one
 * unlisted part (`...; npm -v`) fails whole. The session answers those requests itself (`read-only-policy.ts`,
 * never a human); the edit tools are removed outright.
 */
export function permissionArgs(profile: PermissionProfile, mcpServers: readonly string[] = []): PermissionArgs {
  const mcpRules = mcpServers.map((name) => `mcp__${name}`);
  const webRules = profile.web ? [...WEB_TOOLS] : [];
  if (profile.mode === 'read_only') {
    return {
      mode: 'default',
      allowedTools: [...mcpRules, ...webRules],
      disallowedTools: [...ALWAYS_DENIED, ...READ_ONLY_DENIED],
    };
  }
  return {
    mode: 'acceptEdits',
    allowedTools: [...new Set([...profile.allowedCommands.flatMap(bashRules), ...mcpRules, ...webRules])],
    disallowedTools: [...ALWAYS_DENIED],
  };
}

/** `--mcp-config` payload for the session's servers. */
export function mcpConfig(servers: Readonly<Record<string, McpServer>>): { mcpServers: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!MCP_SERVER_NAME.test(name)) throw new Error(`invalid MCP server name "${name}"`);
    out[name] =
      server.type === 'http'
        ? { type: 'http', url: server.url, headers: server.headers }
        : { type: 'stdio', command: server.command, args: server.args, env: server.env };
  }
  return { mcpServers: out };
}

/** The session's MCP servers, or null when it has none. */
export function sessionMcp(opts: SessionOptions): Readonly<Record<string, McpServer>> | null {
  return opts.mcp && Object.keys(opts.mcp).length > 0 ? opts.mcp : null;
}

export interface BuildArgsInput {
  opts: SessionOptions;
  /** New session: pre-assigned UUID (`--session-id`), so the id is known before `system/init`. */
  sessionId?: string | null;
  /** Resume: existing session id (`--resume`). Mutually exclusive with `sessionId`. */
  resume?: string | null;
  /**
   * File holding the MCP config (a 0600 temp file keeps bearer tokens out of `ps`). When null and
   * `opts.mcp` is set, the JSON is passed inline.
   */
  mcpConfigPath?: string | null;
}

/** The adapter's own arguments (the profile's `args` go before them). */
export function buildClaudeArgs({ opts, sessionId, resume, mcpConfigPath }: BuildArgsInput): string[] {
  if (sessionId && resume) throw new Error('buildClaudeArgs: sessionId and resume are mutually exclusive');
  const args = [...BASE_ARGS];
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);

  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  // A read-only session is told the policy that answers its prompts (`read-only-policy.ts`) before it runs anything.
  const guide = opts.permission.mode === 'read_only' ? READ_ONLY_GUIDE : null;
  const systemPrompt = [opts.systemPrompt, guide].filter(Boolean).join('\n\n');
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (opts.outputSchema) args.push('--json-schema', JSON.stringify(opts.outputSchema));

  const mcp = sessionMcp(opts);
  const perms = permissionArgs(opts.permission, Object.keys(mcp ?? {}));
  args.push('--permission-mode', perms.mode);
  args.push('--permission-prompt-tool', 'stdio');
  if (perms.allowedTools.length > 0) args.push('--allowedTools', perms.allowedTools.join(','));
  if (perms.disallowedTools.length > 0) args.push('--disallowedTools', perms.disallowedTools.join(','));

  // Config isolation: only the repo's own settings (CLAUDE.md, .claude/settings.json), only the session's MCP.
  // A cwd with agent-written content (reviewers) gets no setting source at all: a coder could have planted
  // hooks or permission rules in the worktree's .claude/ (the CLI reads '' as "none").
  // The human's own assistant (`userSettings`) runs like plain `claude`: every source, the user's MCP servers too.
  const userSettings = !!opts.userSettings && !opts.untrustedWorkdir;
  if (opts.untrustedWorkdir) args.push('--setting-sources=');
  else if (userSettings) args.push('--setting-sources', 'user,project,local');
  else args.push('--setting-sources', 'project');
  if (!userSettings) {
    args.push('--settings', JSON.stringify(LEGION_FLAG_SETTINGS));
    args.push('--strict-mcp-config');
  }
  if (mcp) args.push('--mcp-config', mcpConfigPath ?? JSON.stringify(mcpConfig(mcp)));

  // Scratch space: tools write previews and intermediates to /tmp; outside the working directories each
  // read or write there would be an approval.
  if (opts.permission.mode !== 'read_only') for (const dir of tempDirs()) args.push('--add-dir', dir);
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

/** The system's temporary directories, as given and resolved (`/tmp` is `/private/tmp` on macOS). */
export function tempDirs(): string[] {
  const dirs = new Set<string>();
  for (const dir of ['/tmp', tmpdir()]) {
    if (!existsSync(dir)) continue;
    dirs.add(dir);
    try {
      dirs.add(realpathSync(dir));
    } catch {}
  }
  return [...dirs];
}

/**
 * Variables describing a *parent* Claude Code session (present when Legion itself runs inside one, e.g.
 * during development). Inherited, they make the child act as that host's sub-session: host auth refresh
 * over control requests, the host's messaging socket, host-only tools. They are removed from the child env.
 */
export const HOST_SESSION_ENV_VARS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_EAGER_FLUSH',
];

export type EnvLayer = Readonly<Record<string, string | undefined>> | null | undefined;

/**
 * The child's environment: `layers` laid over each other in order (typically `process.env`, the profile's env,
 * the session's env), with the parent Claude Code session variables removed from every layer (a caller may
 * have built its layer from `process.env`).
 */
export function childEnv(...layers: EnvLayer[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) if (value !== undefined) out[name] = value;
  }
  for (const name of HOST_SESSION_ENV_VARS) delete out[name];
  return out;
}
