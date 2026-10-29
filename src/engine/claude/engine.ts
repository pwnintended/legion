/**
 * `AgentEngine` for Claude Code: spawns the user's installed `claude` CLI (no Agent SDK). Auth is whatever
 * the account's CLI account (`CLAUDE_CONFIG_DIR` in the account env, else the CLI default) is logged in with;
 * Legion never reads or passes credentials.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { type Logger, silentLogger } from '../../util/log.ts';
import type { AgentEngine, AgentSession, EngineAccount, EngineInfo, SessionOptions } from '../types.ts';
import { buildClaudeArgs, childEnv, mcpConfig, sessionMcp } from './args.ts';
import { type ChildProcessLike, ClaudeSession, type SessionTiming } from './session.ts';

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
  log?: Logger;
  /** The environment the account's env is laid over. Default: `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Run the CLI on another machine (an Upstash Box, `remote/`): `spawn` starts it there. The account's command is
   * used as is (no local lookup), MCP config goes inline (no local temp file), and the child gets only the session's
   * env: nothing of this machine's.
   */
  remote?: { spawn: SpawnFn; tempDirs: readonly string[] };
  /** Test seams. */
  spawn?: SpawnFn;
  exec?: ExecFn;
  timing?: Partial<SessionTiming>;
}

/** Model aliases the CLI accepts (`--model`); full model ids work too. */
export const CLAUDE_MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku', 'fable'] as const;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Absolute path of `command`: a path (absolute, or relative to the current directory) when it is an
 * executable file, else the first executable `command` on `env.PATH`.
 */
export function resolveBinary(command: string, env: Readonly<Record<string, string>>): string | null {
  if (command.length === 0) return null;
  if (isAbsolute(command) || command.includes('/')) {
    const path = resolve(command);
    return isExecutableFile(path) ? path : null;
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && isAbsolute(dir));
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `2.1.289 (Claude Code)` → `2.1.289`. */
export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(output);
  return match?.[1] ?? null;
}

/** `claude auth status --json`: `{loggedIn, authMethod, ...}`; only `loggedIn` is used. */
export function parseAuthStatus(output: string): boolean | null {
  try {
    const status = JSON.parse(output) as Record<string, unknown>;
    return typeof status.loggedIn === 'boolean' ? status.loggedIn : null;
  } catch {
    return null;
  }
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });

const defaultExec: ExecFn = (command, args, options) =>
  new Promise((resolvePromise) => {
    execFile(command, [...args], { env: options.env, timeout: options.timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolvePromise({
        code,
        stdout: String(stdout),
        stderr: String(stderr || (error && !stdout ? error.message : '')),
      });
    });
  });

export class ClaudeEngine implements AgentEngine {
  readonly kind = 'claude' as const;
  readonly account: EngineAccount;
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;
  private readonly spawn: SpawnFn;
  private readonly exec: ExecFn;
  private readonly log: Logger;
  private readonly timing: Partial<SessionTiming> | undefined;
  private readonly remote: ClaudeEngineOptions['remote'];

  constructor(account: EngineAccount, opts: ClaudeEngineOptions = {}) {
    this.account = account;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.remote = opts.remote;
    this.spawn = opts.remote?.spawn ?? opts.spawn ?? defaultSpawn;
    this.exec = opts.exec ?? defaultExec;
    this.log = opts.log ?? silentLogger;
    this.timing = opts.timing;
  }

  /** `claude --version` + `claude auth status --json` under the account's env; never starts a model turn. */
  async probe(): Promise<EngineInfo> {
    const base: EngineInfo = {
      kind: 'claude',
      account: this.account.name,
      installed: false,
      path: null,
      version: null,
      loggedIn: null,
      error: null,
    };
    // The merged env carries the account's `CLAUDE_CONFIG_DIR`, so `auth status` reports that account.
    const env = this.env();
    const path = resolveBinary(this.account.command, env);
    if (!path) return { ...base, error: `${this.account.command} not found on PATH` };
    const run = (args: string[]) =>
      this.exec(path, [...this.account.args, ...args], { env, timeoutMs: PROBE_TIMEOUT_MS });
    const version = await run(['--version']);
    if (version.code !== 0) {
      return { ...base, path, error: `claude --version failed: ${(version.stderr || version.stdout).trim()}` };
    }
    // Exits non-zero when logged out but still prints the JSON.
    const loggedIn = parseAuthStatus((await run(['auth', 'status', '--json'])).stdout);
    return {
      ...base,
      installed: true,
      path,
      version: parseVersion(version.stdout),
      loggedIn,
      error:
        loggedIn === false
          ? `Claude Code is not logged in (account ${this.account.name}: run \`claude auth login\`)`
          : null,
    };
  }

  async start(opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, randomUUID(), false);
  }

  /** Resumes by id; every flag is passed again (the CLI does not restore them). */
  async resume(sessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, sessionId, true);
  }

  /** process env → account env → session env, parent Claude Code session variables stripped. */
  private env(session?: Readonly<Record<string, string>>): Record<string, string> {
    return childEnv(this.baseEnv, this.account.env, session);
  }

  private async open(opts: SessionOptions, sessionId: string, resumed: boolean): Promise<ClaudeSession> {
    if (opts.signal?.aborted) throw new Error('session aborted before start');
    const env = this.remote ? childEnv(this.account.env, opts.env) : this.env(opts.env);
    const binary = this.remote ? this.account.command : resolveBinary(this.account.command, env);
    if (!binary) throw new Error(`${this.account.command} not found on PATH`);

    const mcp = sessionMcp(opts);
    let tempDir: string | null = null;
    let mcpConfigPath: string | null = null;
    const cleanup = () => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    };
    try {
      if (mcp && !this.remote) {
        tempDir = mkdtempSync(join(tmpdir(), 'legion-claude-'));
        mcpConfigPath = join(tempDir, 'mcp.json');
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig(mcp)), { mode: 0o600 });
      }
    } catch (error) {
      cleanup();
      throw error;
    }

    const args = [
      ...this.account.args,
      ...buildClaudeArgs({
        opts,
        sessionId: resumed ? null : sessionId,
        resume: resumed ? sessionId : null,
        mcpConfigPath,
        ...(this.remote ? { tempDirs: this.remote.tempDirs } : {}),
      }),
    ];
    let child: ChildProcessLike;
    try {
      child = this.spawn(binary, args, { cwd: opts.cwd, env });
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
      ...(this.timing ? { timing: this.timing } : {}),
    });
    // Before the prompt, so the first turn already runs in auto mode (see `ClaudeSession.setApprovals`).
    if (opts.permission.mode === 'workspace_write' && opts.permission.approvals === 'auto') {
      void session.setApprovals('auto').then((ok) => {
        if (!ok)
          this.log.warn(`claude: auto mode unavailable for ${opts.model ?? 'the default model'}; asking instead`);
      });
    }
    session.begin(opts.prompt);
    return session;
  }
}
