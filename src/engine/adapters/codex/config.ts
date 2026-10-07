/**
 * Process and thread configuration for Codex sessions: binary resolution, config isolation
 * (Legion-owned CODEX_HOME), permission profile → sandbox/approval policy, Legion MCP server.
 */
import { constants } from 'node:fs';
import { access, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { type SessionAttachment, type SessionOptions, sessionExtras } from '@shared/engine';
import { CODEX_TOOL_TIMEOUT_SEC } from '../../mcp/config';
import { isAllowedCommand } from '../../util/shell';
import { messageText, type ReadFile } from '../attachments';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type {
  CommandExecutionRequestApprovalParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  UserInput,
} from './protocol/v2';

/** Env var (set in the child env only) that carries the Legion MCP bearer token. */
export const MCP_TOKEN_ENV = 'LEGION_MCP_TOKEN';

/**
 * Features turned off for every Legion app-server: user hooks, ChatGPT apps/connectors, plugins,
 * memories and desktop-app tools. Legion sessions get only the built-in coding tools + the Legion MCP.
 */
export const DISABLED_FEATURES = [
  'hooks',
  'apps',
  'plugins',
  'remote_plugin',
  'memories',
  'computer_use',
  'browser_use',
  'image_generation',
] as const;

/**
 * `codex app-server` arguments. `disabledSkills` are turned off by name (`skills.config`): Codex has no "only
 * these skills" switch, so a session's allowlist disables every skill it finds that is not on it.
 */
export function appServerArgs(disabledSkills: readonly string[] = []): string[] {
  const features = DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]);
  // TOML inline table entries; a JSON string is a valid TOML basic string.
  const skills =
    disabledSkills.length > 0
      ? [
          '-c',
          `skills.config=[${disabledSkills.map((name) => `{name=${JSON.stringify(name)},enabled=false}`).join(',')}]`,
        ]
      : [];
  return ['app-server', ...features, ...skills];
}

/** Resolve an executable from the PATH in `env` (GUI apps don't inherit the login shell's PATH). */
export async function resolveBinary(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (isAbsolute(name)) return (await isExecutable(name)) ? name : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await lstat(path)).isDirectory() === false;
  } catch {
    return false;
  }
}

/** The user's own CODEX_HOME (where `codex login` put auth.json). */
export function userCodexHome(env: Readonly<Record<string, string | undefined>>): string {
  return env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(env.HOME ?? homedir(), '.codex');
}

export interface CodexHome {
  /** CODEX_HOME for the child process. */
  path: string;
  /** False when we had to fall back to the user's own CODEX_HOME. */
  isolated: boolean;
}

/**
 * Prepare the Legion-owned CODEX_HOME: a directory whose `auth.json` is a symlink to the user's.
 * Nothing else from the user's home is used (no config.toml, hooks.json, rules, AGENTS.md, skills,
 * plugins), so Legion runs are isolated, while the ChatGPT login keeps working: codex writes auth.json
 * in place (verified: a write through the symlink updates the target and keeps the link), so token
 * refreshes reach the user's real file. Threads (rollouts) live in the Legion home, so resuming needs
 * the same home.
 *
 * Falls back to the user's own home (not isolated; hooks etc. are still disabled via `-c features.*`)
 * when the user has no auth.json (keyring credential store or API-key env auth).
 */
export async function prepareCodexHome(
  legionHome: string | null,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CodexHome> {
  const userHome = userCodexHome(env);
  if (legionHome === null) return { path: userHome, isolated: false };
  const home = resolve(legionHome);
  if (home === userHome) return { path: userHome, isolated: false };
  const userAuth = join(userHome, 'auth.json');
  const hasUserAuth = await lstat(userAuth).then(
    () => true,
    () => false,
  );
  if (!hasUserAuth && !env.OPENAI_API_KEY && !env.CODEX_API_KEY) return { path: userHome, isolated: false };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const link = join(home, 'auth.json');
  if (hasUserAuth) {
    const current = await readlink(link).catch(() => null);
    if (current !== userAuth) {
      await rm(link, { force: true });
      await symlink(userAuth, link);
    }
  }
  return { path: home, isolated: true };
}

/** Child environment: the caller's env plus CODEX_HOME and the MCP bearer token. */
export function childEnv(opts: Pick<SessionOptions, 'env' | 'mcp'>, codexHome: string): Record<string, string> {
  const env: Record<string, string> = { ...opts.env, CODEX_HOME: codexHome };
  if (opts.mcp) env[MCP_TOKEN_ENV] = opts.mcp.token;
  else delete env[MCP_TOKEN_ENV];
  return env;
}

/** Thread-level config overrides (`config` map on thread/start and thread/resume, same keys as config.toml). */
export function threadConfig(opts: SessionOptions): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = {};
  const servers: Record<string, JsonValue> = {};
  if (opts.mcp) {
    servers.legion = {
      url: opts.mcp.url,
      bearer_token_env_var: MCP_TOKEN_ENV,
      default_tools_approval_mode: 'approve',
      // request_human_input blocks until a human answers in the inbox (the server never times out).
      tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
    };
  }
  // The project's own servers, pre-approved like Legion's (the grant in settings is the approval).
  for (const [name, server] of Object.entries(sessionExtras(opts).extraMcp)) {
    servers[name] =
      server.type === 'http'
        ? { url: server.url, http_headers: server.headers, default_tools_approval_mode: 'approve' }
        : { command: server.command, args: server.args, env: server.env, default_tools_approval_mode: 'approve' };
  }
  if (Object.keys(servers).length > 0) config.mcp_servers = servers;
  // Agent-written worktree (reviewer, finalizer): ignore its AGENTS.md. Project `.codex/config.toml` is only
  // read for trusted projects, and the Legion CODEX_HOME trusts none; hooks are off for every session.
  if (opts.untrustedWorkdir) config.project_doc_max_bytes = 0;
  if (opts.permission.web) config.web_search = 'live';
  if (opts.permission.mode === 'workspace_write' && opts.addDirs && opts.addDirs.length > 0) {
    config.sandbox_workspace_write = { writable_roots: opts.addDirs.map((dir) => resolve(opts.cwd, dir)) };
  }
  return config;
}

type PolicyParams = Pick<ThreadStartParams, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>;

/**
 * Architecture §6: read_only → read-only + never; workspace_write → workspace-write + on-request. `coordinate` is
 * best effort on Codex (its tool list cannot be trimmed): read-only sandbox, never ask.
 */
export function policyFor(opts: SessionOptions): PolicyParams {
  if (opts.permission.mode === 'read_only' || opts.permission.mode === 'coordinate') {
    return { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' };
  }
  return {
    sandbox: 'workspace-write',
    approvalPolicy: opts.permission.askHuman ? 'on-request' : 'never',
    // `auto`: Codex's own reviewer answers the approval requests (what `--approve-for-me` does).
    approvalsReviewer: opts.permission.approvals === 'auto' ? 'auto_review' : 'user',
  };
}

export function threadStartParams(opts: SessionOptions): ThreadStartParams {
  return {
    cwd: opts.cwd,
    model: opts.model ?? null,
    ...policyFor(opts),
    config: threadConfig(opts),
    developerInstructions: opts.systemPrompt ?? null,
  };
}

export function threadResumeParams(threadId: string, opts: SessionOptions): ThreadResumeParams {
  return {
    threadId,
    cwd: opts.cwd,
    model: opts.model ?? null,
    ...policyFor(opts),
    config: threadConfig(opts),
    developerInstructions: opts.systemPrompt ?? null,
    excludeTurns: true,
  };
}

/** What Codex takes natively: images, as `localImage` inputs (the app-server reads the file). */
export const codexNative = (attachment: SessionAttachment): boolean => attachment.kind === 'image';

/**
 * A user message: one text input (text files inlined, PDFs and other files referenced by path) followed by
 * a `localImage` input per image attachment.
 */
export function userInput(
  text: string,
  attachments?: readonly SessionAttachment[] | null,
  read?: ReadFile,
): UserInput[] {
  const input: UserInput[] = [
    { type: 'text', text: messageText(text, attachments, codexNative, read), text_elements: [] },
  ];
  for (const attachment of attachments ?? []) {
    if (codexNative(attachment)) input.push({ type: 'localImage', path: attachment.path });
  }
  return input;
}

export function turnStartParams(
  threadId: string,
  text: string,
  opts: SessionOptions,
  attachments?: readonly SessionAttachment[] | null,
): TurnStartParams {
  const params: TurnStartParams = { threadId, input: userInput(text, attachments) };
  // Legion's effort scale (low..max) is a subset of Codex's (low..max, ultra).
  if (opts.effort) params.effort = opts.effort;
  if (opts.outputSchema) params.outputSchema = opts.outputSchema as JsonValue;
  return params;
}

/** The fields of an `item/commandExecution/requestApproval` that decide whether Legion may answer it alone. */
export type PreapprovalRequest = Pick<
  CommandExecutionRequestApprovalParams,
  'kind' | 'command' | 'additionalPermissions' | 'networkApprovalContext' | 'proposedNetworkPolicyAmendments'
>;

/**
 * True when Legion may accept a command approval without asking the human: a plain command request (no
 * extra filesystem/network permissions, no stdin write) whose actual `command` (not the display-only
 * `commandActions`) is one of the allowed verify/setup commands, optionally followed by plain arguments
 * (`util/shell.ts`). Accepting runs the command outside the sandbox, so anything else goes to the inbox.
 */
export function isPreapproved(request: PreapprovalRequest, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  if ((request.kind ?? 'command') !== 'command') return false;
  if (request.additionalPermissions != null || request.networkApprovalContext != null) return false;
  if ((request.proposedNetworkPolicyAmendments ?? []).length > 0) return false;
  const command = request.command?.trim();
  if (!command) return false;
  return isAllowedCommand(command, allowed);
}
