/**
 * Process and thread configuration for Codex sessions: binary resolution, config isolation
 * (Legion-owned CODEX_HOME), permission profile → sandbox/approval policy, Legion MCP server.
 */
import { constants } from 'node:fs';
import { access, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { SessionOptions } from '@shared/engine';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol/v2';

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

/** `codex app-server` arguments. */
export function appServerArgs(): string[] {
  return ['app-server', ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`])];
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
  if (opts.mcp) {
    config.mcp_servers = {
      legion: {
        url: opts.mcp.url,
        bearer_token_env_var: MCP_TOKEN_ENV,
        default_tools_approval_mode: 'approve',
      },
    };
  }
  if (opts.permission.mode === 'workspace_write' && opts.addDirs && opts.addDirs.length > 0) {
    config.sandbox_workspace_write = { writable_roots: opts.addDirs.map((dir) => resolve(opts.cwd, dir)) };
  }
  return config;
}

type PolicyParams = Pick<ThreadStartParams, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>;

/** Architecture §6: read_only → read-only + never; workspace_write → workspace-write + on-request. */
export function policyFor(opts: SessionOptions): PolicyParams {
  if (opts.permission.mode === 'read_only') {
    return { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' };
  }
  return {
    sandbox: 'workspace-write',
    approvalPolicy: opts.permission.askHuman ? 'on-request' : 'never',
    approvalsReviewer: 'user',
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

export function userInput(text: string): UserInput[] {
  return [{ type: 'text', text, text_elements: [] }];
}

export function turnStartParams(threadId: string, text: string, opts: SessionOptions): TurnStartParams {
  const params: TurnStartParams = { threadId, input: userInput(text) };
  // Legion's effort scale (low..max) is a subset of Codex's (low..max, ultra).
  if (opts.effort) params.effort = opts.effort;
  if (opts.outputSchema) params.outputSchema = opts.outputSchema as JsonValue;
  return params;
}

/** True when every command the request covers starts with one of the pre-approved commands. */
export function isPreapproved(commands: readonly string[], allowed: readonly string[]): boolean {
  if (commands.length === 0 || allowed.length === 0) return false;
  return commands.every((command) => {
    const trimmed = command.trim();
    return allowed.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
  });
}
