/**
 * `AgentEngine` for Claude Code: spawns the user's installed `claude` CLI (no Agent SDK). Auth is whatever
 * the user's own CLI is logged in with; Legion never reads or passes tokens.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEngine,
  type AgentSession,
  type EngineInfo,
  type SessionOptions,
  sessionExtras,
} from '@shared/engine';
import { type Logger, silentLogger } from '../../context';
import { enginePlatform } from '../../platform';
import { buildClaudeArgs, childEnv, mcpConfig } from './args';
import { type ChildProcessLike, ClaudeSession, type SessionTiming } from './session';
import { prepareSkills } from './skills';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => ChildProcessLike;

export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface ClaudeEngineOptions {
  /** Environment used by `probe()` (sessions use `SessionOptions.env`). Default: `process.env`. */
  env?: Readonly<Record<string, string>>;
  /** Absolute path of the `claude` binary; default: resolved from `PATH`. */
  binaryPath?: string | null;
  spawn?: SpawnFn;
  exec?: ExecFn;
  log?: Logger;
  timing?: Partial<SessionTiming>;
}

/** Model aliases the CLI accepts (`--model`); full model ids work too. */
export const CLAUDE_MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku', 'fable'] as const;

const PROBE_TIMEOUT_MS = 10_000;

/** First executable `claude` on `env.PATH`, or `override` if it is executable. */
export function resolveClaudeBinary(env: Readonly<Record<string, string>>, override?: string | null): string | null {
  return enginePlatform().findExecutable(override || 'claude', env);
}

/** `2.1.289 (Claude Code)` → `2.1.289`. */
export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(output);
  return match?.[1] ?? null;
}

/** `claude auth status --json`: `{loggedIn, authMethod, email?, orgName?, subscriptionType?}`. */
export function parseAuthStatus(output: string): { loggedIn: boolean | null; account: string | null } {
  try {
    const status = JSON.parse(output) as Record<string, unknown>;
    const loggedIn = typeof status.loggedIn === 'boolean' ? status.loggedIn : null;
    const name = [status.email, status.orgName, status.authMethod].find((v) => typeof v === 'string') as
      | string
      | undefined;
    const plan = typeof status.subscriptionType === 'string' ? ` (${status.subscriptionType})` : '';
    return { loggedIn, account: loggedIn && name ? `${name}${plan}` : null };
  } catch {
    return { loggedIn: null, account: null };
  }
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const launch = enginePlatform().launch(command, args, options.env);
  return nodeSpawn(launch.cmd, launch.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim ?? false,
  });
};

const defaultExec: ExecFn = (command, args, options) =>
  new Promise((resolve) => {
    const launch = enginePlatform().launch(command, args, options.env);
    execFile(
      launch.cmd,
      launch.args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim ?? false,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : '')) });
      },
    );
  });

export class ClaudeEngine implements AgentEngine {
  readonly kind = 'claude' as const;
  private readonly env: Readonly<Record<string, string>>;
  private readonly spawn: SpawnFn;
  private readonly exec: ExecFn;
  private readonly log: Logger;

  constructor(private readonly options: ClaudeEngineOptions = {}) {
    this.env = options.env ?? (process.env as Record<string, string>);
    this.spawn = options.spawn ?? defaultSpawn;
    this.exec = options.exec ?? defaultExec;
    this.log = options.log ?? silentLogger;
  }

  /** `claude --version` + `claude auth status --json`; never starts a session. */
  async probe(): Promise<EngineInfo> {
    const base: EngineInfo = {
      kind: 'claude',
      installed: false,
      path: null,
      version: null,
      loggedIn: null,
      account: null,
      models: [...CLAUDE_MODEL_ALIASES],
      error: null,
      probedAt: Date.now(),
    };
    const path = resolveClaudeBinary(this.env, this.options.binaryPath);
    if (!path) return { ...base, error: 'claude CLI not found on PATH' };
    const env = childEnv(this.env);
    const version = await this.exec(path, ['--version'], { env, timeoutMs: PROBE_TIMEOUT_MS });
    if (version.code !== 0) {
      return { ...base, path, error: `claude --version failed: ${(version.stderr || version.stdout).trim()}` };
    }
    // Exits non-zero when logged out but still prints the JSON.
    const auth = await this.exec(path, ['auth', 'status', '--json'], { env, timeoutMs: PROBE_TIMEOUT_MS });
    const { loggedIn, account } = parseAuthStatus(auth.stdout);
    return {
      ...base,
      installed: true,
      path,
      version: parseVersion(version.stdout),
      loggedIn,
      account,
      error: loggedIn === false ? 'Claude Code is not logged in (run `claude auth login`)' : null,
    };
  }

  async start(opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, randomUUID(), false);
  }

  /** Resumes by id; every flag is passed again (the CLI does not restore them). */
  async resume(sessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, sessionId, true);
  }

  private async open(opts: SessionOptions, sessionId: string, resumed: boolean): Promise<AgentSession> {
    const binary = resolveClaudeBinary(opts.env, this.options.binaryPath);
    if (!binary) throw new Error('claude CLI not found on PATH');

    const extras = sessionExtras(opts);
    let tempDir: string | null = null;
    let mcpConfigPath: string | null = null;
    const cleanup = () => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    };
    let skillsPluginDir: string | null = null;
    let disabledSkills: string[] = [];
    try {
      if (opts.mcp || Object.keys(extras.extraMcp).length > 0 || extras.skills) {
        tempDir = mkdtempSync(join(tmpdir(), 'legion-claude-'));
      }
      if (tempDir && (opts.mcp || Object.keys(extras.extraMcp).length > 0)) {
        mcpConfigPath = join(tempDir, 'mcp.json');
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig(opts.mcp, extras.extraMcp)), { mode: 0o600 });
      }
      if (tempDir && extras.skills) {
        const prepared = await prepareSkills(extras.skills, opts.cwd, tempDir);
        skillsPluginDir = prepared.pluginDir;
        disabledSkills = prepared.disabled;
      }
    } catch (error) {
      cleanup();
      throw error;
    }

    const args = buildClaudeArgs({
      opts,
      sessionId: resumed ? null : sessionId,
      resume: resumed ? sessionId : null,
      mcpConfigPath,
      skillsPluginDir,
      disabledSkills,
    });
    let child: ChildProcessLike;
    try {
      child = this.spawn(binary, args, { cwd: opts.cwd, env: childEnv(opts.env) });
    } catch (error) {
      cleanup();
      throw error;
    }
    const session = new ClaudeSession({
      child,
      sessionId,
      opts,
      log: this.log,
      onExit: cleanup,
      ...(this.options.timing ? { timing: this.options.timing } : {}),
    });
    // Before the prompt, so the first turn already runs in auto mode (see `ClaudeSession.setApprovals`).
    if (opts.permission.mode === 'workspace_write' && opts.permission.approvals === 'auto') {
      void session.setApprovals('auto').then((ok) => {
        if (!ok)
          this.log.warn(`claude: auto mode unavailable for ${opts.model ?? 'the default model'}; asking instead`);
      });
    }
    session.begin(opts.prompt, opts.attachments);
    return session;
  }
}
