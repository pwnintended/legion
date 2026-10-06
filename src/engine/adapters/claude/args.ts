/**
 * Pure command-line builder for the `claude` CLI (flags verified against 2.1.289 `claude --help`).
 *
 * Every flag is re-passed on resume: the CLI does not restore model, permissions, MCP config, add-dirs or
 * settings from the transcript.
 */
import type { McpConnection, PermissionProfile, SessionOptions } from '@shared/engine';

/** Name of the Legion MCP server inside `--mcp-config`; its tools are `mcp__legion__<tool>`. */
export const LEGION_MCP_SERVER = 'legion';

/** Base flags: headless, stream-json both ways, partial messages for live text. */
export const BASE_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
];

/**
 * Flag settings (`--settings <json>`). Auto-memory is off so agents never write
 * `~/.claude/projects/<cwd>/memory/` (the CLI does so even in `dontAsk` mode when asked to "remember").
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

/** `Bash(cmd)` + `Bash(cmd *)`: the exact command and the command with arguments. */
export function bashRules(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];
  return [`Bash(${trimmed})`, `Bash(${trimmed} *)`];
}

export interface PermissionArgs {
  mode: 'dontAsk' | 'acceptEdits';
  allowedTools: string[];
  disallowedTools: string[];
  /** Route prompts to the host over the control protocol (`can_use_tool`) instead of denying them. */
  askHost: boolean;
}

/**
 * Architecture §6: map a `PermissionProfile` onto Claude's permission flags.
 *
 * Reads (Read/Grep/Glob) inside cwd + `--add-dir`s and shell commands the CLI itself classifies as
 * read-only (`ls`, `git diff`, ...) are allowed in every mode without rules, so they are deliberately not
 * listed: a bare `Read` rule would also allow reading outside the worktree. Edits are covered by
 * `acceptEdits` (working directories only). Anything else asks the host (`can_use_tool`) or, without
 * `askHuman`, is denied (`--permission-prompts none` / `dontAsk`).
 */
export function permissionArgs(profile: PermissionProfile, mcp: McpConnection | null): PermissionArgs {
  const mcpRules = mcp ? [`mcp__${LEGION_MCP_SERVER}`] : [];
  if (profile.mode === 'read_only') {
    return {
      mode: 'dontAsk',
      allowedTools: mcpRules,
      disallowedTools: [...ALWAYS_DENIED, ...READ_ONLY_DENIED],
      askHost: false,
    };
  }
  return {
    mode: 'acceptEdits',
    allowedTools: [...new Set([...profile.allowedCommands.flatMap(bashRules), ...mcpRules])],
    disallowedTools: [...ALWAYS_DENIED],
    askHost: profile.askHuman,
  };
}

/** `--mcp-config` payload with only the Legion server (streamable HTTP + bearer token). */
export function mcpConfig(mcp: McpConnection): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      [LEGION_MCP_SERVER]: {
        type: 'http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
      },
    },
  };
}

export interface BuildArgsInput {
  opts: SessionOptions;
  /** New session: pre-assigned UUID (`--session-id`), so the id is known before `system/init`. */
  sessionId?: string | null;
  /** Resume: existing session id (`--resume`). Mutually exclusive with `sessionId`. */
  resume?: string | null;
  /**
   * File holding the MCP config (a 0600 temp file keeps the bearer token out of `ps`). When null and
   * `opts.mcp` is set, the JSON is passed inline.
   */
  mcpConfigPath?: string | null;
}

export function buildClaudeArgs({ opts, sessionId, resume, mcpConfigPath }: BuildArgsInput): string[] {
  if (sessionId && resume) throw new Error('buildClaudeArgs: sessionId and resume are mutually exclusive');
  const args = [...BASE_ARGS];
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);

  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.outputSchema) args.push('--json-schema', JSON.stringify(opts.outputSchema));

  const perms = permissionArgs(opts.permission, opts.mcp);
  args.push('--permission-mode', perms.mode);
  if (perms.askHost) args.push('--permission-prompt-tool', 'stdio');
  else args.push('--permission-prompts', 'none');
  if (perms.allowedTools.length > 0) args.push('--allowedTools', perms.allowedTools.join(','));
  if (perms.disallowedTools.length > 0) args.push('--disallowedTools', perms.disallowedTools.join(','));

  // Config isolation: only the repo's own settings (CLAUDE.md, .claude/settings.json), only Legion's MCP.
  args.push('--setting-sources', 'project');
  args.push('--settings', JSON.stringify(LEGION_FLAG_SETTINGS));
  args.push('--strict-mcp-config');
  if (opts.mcp) args.push('--mcp-config', mcpConfigPath ?? JSON.stringify(mcpConfig(opts.mcp)));

  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
  return args;
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

export function childEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...env };
  for (const name of HOST_SESSION_ENV_VARS) delete out[name];
  return out;
}
