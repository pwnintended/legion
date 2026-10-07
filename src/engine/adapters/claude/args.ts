/**
 * Pure command-line builder for the `claude` CLI (flags verified against 2.1.289 `claude --help`).
 *
 * Every flag is re-passed on resume: the CLI does not restore model, permissions, MCP config, add-dirs or
 * settings from the transcript.
 */
import type { McpServer } from '@shared/domain';
import { type McpConnection, type PermissionProfile, type SessionOptions, sessionExtras } from '@shared/engine';
import { hasShellMeta } from '../../util/shell';

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
  // Echoes each stdin user message when the CLI takes it in: how the session knows a steer is still queued.
  '--replay-user-messages',
];

/**
 * Flag settings (`--settings <json>`). Auto-memory is off so agents never write
 * `~/.claude/projects/<cwd>/memory/` (the CLI does so even in `dontAsk` mode when asked to "remember").
 */
export const LEGION_FLAG_SETTINGS = { autoMemoryEnabled: false } as const;

/** Name of the per-session plugin that carries the user's allowed skills (they show up as `legion-skills:<name>`). */
export const SKILLS_PLUGIN_NAME = 'legion-skills';

/**
 * Skills the CLI ships that `disableBundledSkills` does not cover; turned off by name when a session has a skill
 * allowlist. (An override for a skill that does not exist is ignored.)
 */
export const CLI_EXTRA_SKILLS: readonly string[] = ['plugin-authoring'];

/**
 * `--settings` payload. A skill allowlist switches the bundled skills off and turns off by name the repo skills
 * (`disabledSkills`) that are not on it; user skills only exist when the session's plugin brings them.
 */
export function flagSettings(skills: SessionOptions['skills'], disabledSkills: readonly string[] = []): object {
  if (!skills) return LEGION_FLAG_SETTINGS;
  const off = [...new Set([...CLI_EXTRA_SKILLS, ...disabledSkills])].filter((name) => !skills.allow.includes(name));
  return {
    ...LEGION_FLAG_SETTINGS,
    disableBundledSkills: true,
    skillOverrides: Object.fromEntries(off.map((name) => [name, 'off'])),
  };
}

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

/**
 * A coordinating session may only talk (Legion MCP tools): no reads (they need no permission, so they must be
 * denied by name), no shell, no web, no sub-agents or scratch state.
 */
export const COORDINATE_DENIED: readonly string[] = [
  ...READ_ONLY_DENIED,
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'NotebookRead',
  'TodoWrite',
  'Skill',
  'ToolSearch',
];

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
export const WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch'];

export function permissionArgs(
  profile: PermissionProfile,
  mcp: McpConnection | null,
  extraServers: readonly string[] = [],
): PermissionArgs {
  const mcpRules = [...(mcp ? [`mcp__${LEGION_MCP_SERVER}`] : []), ...extraServers.map((name) => `mcp__${name}`)];
  const webRules = profile.web ? [...WEB_TOOLS] : [];
  if (profile.mode === 'read_only' || profile.mode === 'coordinate') {
    const denied = profile.mode === 'coordinate' ? COORDINATE_DENIED : READ_ONLY_DENIED;
    return {
      mode: 'dontAsk',
      allowedTools: [...mcpRules, ...webRules],
      disallowedTools: [...ALWAYS_DENIED, ...denied.filter((tool) => !profile.web || !WEB_TOOLS.includes(tool))],
      askHost: false,
    };
  }
  return {
    mode: 'acceptEdits',
    allowedTools: [...new Set([...profile.allowedCommands.flatMap(bashRules), ...mcpRules, ...webRules])],
    disallowedTools: [...ALWAYS_DENIED],
    askHost: profile.askHuman,
  };
}

/**
 * `--mcp-config` payload: the Legion server (streamable HTTP + bearer token) when there is one, plus the
 * project's allowed servers.
 */
export function mcpConfig(
  mcp: McpConnection | null,
  extra: Readonly<Record<string, McpServer>> = {},
): { mcpServers: Record<string, unknown> } {
  const servers: Record<string, unknown> = {};
  if (mcp) {
    servers[LEGION_MCP_SERVER] = { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } };
  }
  for (const [name, server] of Object.entries(extra)) {
    servers[name] =
      server.type === 'http'
        ? { type: 'http', url: server.url, headers: server.headers }
        : { type: 'stdio', command: server.command, args: server.args, env: server.env };
  }
  return { mcpServers: servers };
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
  /** Plugin folder that exposes the allowed user skills (`--plugin-dir`); null = none. */
  skillsPluginDir?: string | null;
  /** Repo skills (found in the working directory) the allowlist leaves out; turned off by name. */
  disabledSkills?: readonly string[];
}

export function buildClaudeArgs({
  opts,
  sessionId,
  resume,
  mcpConfigPath,
  skillsPluginDir,
  disabledSkills,
}: BuildArgsInput): string[] {
  if (sessionId && resume) throw new Error('buildClaudeArgs: sessionId and resume are mutually exclusive');
  const args = [...BASE_ARGS];
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);

  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.outputSchema) args.push('--json-schema', JSON.stringify(opts.outputSchema));

  const extras = sessionExtras(opts);
  const perms = permissionArgs(opts.permission, opts.mcp, Object.keys(extras.extraMcp));
  args.push('--permission-mode', perms.mode);
  if (perms.askHost) args.push('--permission-prompt-tool', 'stdio');
  else args.push('--permission-prompts', 'none');
  if (perms.allowedTools.length > 0) args.push('--allowedTools', perms.allowedTools.join(','));
  if (perms.disallowedTools.length > 0) args.push('--disallowedTools', perms.disallowedTools.join(','));

  // Config isolation: only the repo's own settings (CLAUDE.md, .claude/settings.json), only Legion's MCP.
  // A cwd with agent-written content (reviewer, finalizer) gets no setting source at all: a coder could
  // have planted hooks or permission rules in the worktree's .claude/ (the CLI reads '' as "none").
  if (opts.untrustedWorkdir) args.push('--setting-sources=');
  else args.push('--setting-sources', 'project');
  args.push('--settings', JSON.stringify(flagSettings(extras.skills, disabledSkills)));
  args.push('--strict-mcp-config');
  if (opts.mcp || Object.keys(extras.extraMcp).length > 0) {
    args.push('--mcp-config', mcpConfigPath ?? JSON.stringify(mcpConfig(opts.mcp, extras.extraMcp)));
  }
  if (skillsPluginDir) args.push('--plugin-dir', skillsPluginDir);

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
