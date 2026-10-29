/**
 * Process and thread configuration for Codex sessions: binary resolution, config isolation
 * (Legion-owned CODEX_HOME), permission profile → sandbox/approval policy, MCP servers.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { isAllowedCommand } from '../../util/shell.ts';
import { HERDR_ENV_PREFIX, type McpServer, type PermissionProfile, type SessionOptions } from '../types.ts';
import type { JsonValue } from './protocol/serde_json/JsonValue.ts';
import type {
  CommandExecutionRequestApprovalParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  UserInput,
} from './protocol/v2/index.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Prefix of the env vars (set in the child env only) that carry MCP bearer tokens: `LEGION_MCP_TOKEN_<NAME>`
 * for the server called `name`.
 */
export const MCP_TOKEN_ENV_PREFIX = 'LEGION_MCP_TOKEN_';

/**
 * MCP tool timeout: a day, so a tool that waits for a human (e.g. `request_human_input`) can block until
 * someone answers (the server never times out; Claude gets the same via `MCP_TOOL_TIMEOUT`).
 */
export const MCP_TOOL_TIMEOUT_SEC = 86_400;

/**
 * Features turned off for every Legion app-server: user hooks, ChatGPT apps/connectors, plugins,
 * memories and desktop-app tools. Legion sessions get only the built-in coding tools + the given MCP servers.
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

/** `codex app-server` arguments, after the account's own `args`. */
export function appServerArgs(accountArgs: readonly string[] = []): string[] {
  const features = DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]);
  return [...accountArgs, 'app-server', ...features];
}

/** Process env, then the account's env, then the session's: the env a Codex child starts from. */
export function mergeEnv(...layers: (Env | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Resolve an executable: a path is checked as is, a bare name is looked up on `env.PATH`. */
export function resolveBinary(name: string, env: Env): string | null {
  if (name.includes('/')) return isExecutable(name) ? resolve(name) : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The user's own CODEX_HOME (where `codex login` put auth.json): `$CODEX_HOME` of the merged env, else ~/.codex. */
export function userCodexHome(env: Env): string {
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
 * refreshes reach the user's real file. Credentials are never read or copied. Threads (rollouts) live in
 * the Legion home, so resuming needs the same home.
 *
 * Falls back to the user's own home (not isolated; hooks etc. are still disabled via `-c features.*`)
 * when the user has no auth.json (keyring credential store) and no API-key env auth.
 */
export async function prepareCodexHome(legionHome: string, env: Env): Promise<CodexHome> {
  const userHome = userCodexHome(env);
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
      await symlink(userAuth, link, 'file');
    }
  }
  return { path: home, isolated: true };
}

/** Env var name for the bearer token of MCP server `name`. */
export function mcpTokenEnv(name: string): string {
  return `${MCP_TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** An `Authorization: Bearer <token>` header's token, if any (header names are case-insensitive). */
function bearerToken(headers: Readonly<Record<string, string>>): { key: string; token: string } | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue;
    const match = /^Bearer\s+(\S.*)$/i.exec(value.trim());
    if (match?.[1]) return { key, token: match[1] };
  }
  return null;
}

/**
 * Child environment: `base` (process + account + session env) plus CODEX_HOME and the MCP bearer tokens.
 * Token vars inherited from elsewhere are dropped so a stale one can't reach a server, and Herdr's pane vars so
 * the worker's own Herdr hook can't claim Legion's pane.
 */
export function childEnv(
  base: Readonly<Record<string, string>>,
  mcp: SessionOptions['mcp'],
  codexHome: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith(MCP_TOKEN_ENV_PREFIX) && !key.startsWith(HERDR_ENV_PREFIX)) env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  for (const [name, server] of Object.entries(mcp ?? {})) {
    const bearer = server.type === 'http' ? bearerToken(server.headers) : null;
    if (bearer) env[mcpTokenEnv(name)] = bearer.token;
  }
  return env;
}

/**
 * One `mcp_servers.<name>` entry (same keys as config.toml), pre-approved: being handed to the session is the
 * approval. A bearer `Authorization` header goes through `bearer_token_env_var` (the token stays in the child env).
 */
export function mcpServerConfig(name: string, server: McpServer): Record<string, JsonValue> {
  const common = { default_tools_approval_mode: 'approve', tool_timeout_sec: MCP_TOOL_TIMEOUT_SEC };
  if (server.type === 'stdio') {
    return { command: server.command, args: [...server.args], env: { ...server.env }, ...common };
  }
  const bearer = bearerToken(server.headers);
  const headers = Object.fromEntries(Object.entries(server.headers).filter(([key]) => key !== bearer?.key));
  const config: Record<string, JsonValue> = { url: server.url, ...common };
  if (bearer) config.bearer_token_env_var = mcpTokenEnv(name);
  if (Object.keys(headers).length > 0) config.http_headers = headers;
  return config;
}

/** Thread-level config overrides (`config` map on thread/start and thread/resume, same keys as config.toml). */
export function threadConfig(opts: SessionOptions): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = {};
  const servers: Record<string, JsonValue> = {};
  for (const [name, server] of Object.entries(opts.mcp ?? {})) servers[name] = mcpServerConfig(name, server);
  if (Object.keys(servers).length > 0) config.mcp_servers = servers;
  // Agent-written worktree (reviewer): ignore its AGENTS.md. Project `.codex/config.toml` is only read for
  // trusted projects, and the Legion CODEX_HOME trusts none; hooks are off for every session.
  if (opts.untrustedWorkdir) config.project_doc_max_bytes = 0;
  config.web_search = opts.permission.web ? 'live' : 'disabled';
  if (opts.permission.mode === 'workspace_write' && opts.addDirs && opts.addDirs.length > 0) {
    config.sandbox_workspace_write = { writable_roots: opts.addDirs.map((dir) => resolve(opts.cwd, dir)) };
  }
  return config;
}

type PolicyParams = Pick<ThreadStartParams, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>;

/**
 * read_only → read-only + never. workspace_write → workspace-write + on-request when the human answers (`ask`);
 * with `auto`, everything is allowed: no sandbox, no approvals (`--dangerously-bypass-approvals-and-sandbox`).
 * `sandboxed: false` (a remote box, where codex's bubblewrap sandbox cannot make namespaces and the box is the
 * sandbox): full access with the same approvals.
 */
export function policyFor(permission: PermissionProfile, sandboxed = true): PolicyParams {
  if (permission.mode === 'read_only') {
    return {
      sandbox: sandboxed ? 'read-only' : 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    };
  }
  if (permission.approvals === 'auto') {
    return { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
  }
  return {
    sandbox: sandboxed ? 'workspace-write' : 'danger-full-access',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  };
}

export function threadStartParams(opts: SessionOptions, sandboxed = true): ThreadStartParams {
  return {
    cwd: opts.cwd,
    model: opts.model ?? null,
    ...policyFor(opts.permission, sandboxed),
    config: threadConfig(opts),
    developerInstructions: opts.systemPrompt ?? null,
  };
}

export function threadResumeParams(threadId: string, opts: SessionOptions, sandboxed = true): ThreadResumeParams {
  return {
    threadId,
    cwd: opts.cwd,
    model: opts.model ?? null,
    ...policyFor(opts.permission, sandboxed),
    config: threadConfig(opts),
    developerInstructions: opts.systemPrompt ?? null,
    excludeTurns: true,
  };
}

/** A user message: the images (local PNG files), then the text. */
export function userInput(text: string, images: readonly string[] = []): UserInput[] {
  return [
    ...images.map((path): UserInput => ({ type: 'localImage', path })),
    ...(text || images.length === 0 ? [{ type: 'text' as const, text, text_elements: [] }] : []),
  ];
}

export function turnStartParams(
  threadId: string,
  text: string,
  opts: SessionOptions,
  images: readonly string[] = [],
): TurnStartParams {
  const params: TurnStartParams = { threadId, input: userInput(text, images) };
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
 * (`util/shell.ts`). Accepting runs the command outside the sandbox, so anything else is asked.
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
