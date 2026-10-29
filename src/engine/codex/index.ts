/**
 * Codex adapter: `AgentEngine` over `codex app-server` (JSON-RPC 2.0, JSONL on stdio), one child
 * process per session. See README.md for the verified protocol details and the config-isolation choice.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Logger, silentLogger } from '../../util/log.ts';
import type { AgentEngine, AgentSession, EngineInfo, EngineProfile, SessionOptions } from '../types.ts';
import { appServerArgs, childEnv, mergeEnv, prepareCodexHome, resolveBinary } from './config.ts';
import { JsonRpcPeer, LineSplitter } from './json-rpc.ts';
import type { ClientMethod, ClientMethods } from './methods.ts';
import type { ModelListResponse } from './protocol/v2/index.ts';
import { CodexSession, type CodexSpawn, type OpenMode } from './session.ts';

export { type CodexChild, type CodexProcessSpec, CodexSession, type CodexSpawn, type OpenMode } from './session.ts';

export interface CodexEngineOptions {
  log?: Logger;
  /**
   * Legion-owned CODEX_HOME (default `~/.legion/codex-home/<profile.name>`): only the user's `auth.json` is
   * linked into it, so user config, hooks, rules and AGENTS.md don't leak into Legion runs. Threads are stored
   * there, so keep it stable across restarts (resume needs it).
   */
  home?: string;
  /** Reported as `clientInfo.version` to the app-server. */
  clientVersion?: string;
  /**
   * Run the app-server on another machine (an Upstash Box, `remote/`): `spawn` starts it there. The profile's
   * command is used as is, CODEX_HOME is the box's own (its launcher sets it), and the child gets only the
   * session's env.
   */
  remote?: { spawn: CodexSpawn };
}

const PROBE_TIMEOUT_MS = 20_000;

export class CodexEngine implements AgentEngine {
  readonly kind = 'codex' as const;
  readonly profile: EngineProfile;
  private readonly log: Logger;
  private readonly home: string;
  private readonly clientVersion: string;
  private readonly remote: CodexEngineOptions['remote'];
  /** Told the user once that Codex runs in their own CODEX_HOME. */
  private reportedFallback = false;

  constructor(profile: EngineProfile, opts: CodexEngineOptions = {}) {
    this.profile = profile;
    this.log = opts.log ?? silentLogger;
    this.home = opts.home ?? join(homedir(), '.legion', 'codex-home', profile.name);
    this.clientVersion = opts.clientVersion ?? '0.0.0';
    this.remote = opts.remote;
  }

  start(opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, { kind: 'start' });
  }

  resume(sessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, { kind: 'resume', threadId: sessionId });
  }

  /** The CODEX_HOME sessions run in (where their threads are stored): needed to resume one in the plain CLI. */
  async codexHome(): Promise<string> {
    return (await prepareCodexHome(this.home, mergeEnv(process.env, this.profile.env))).path;
  }

  private async open(opts: SessionOptions, mode: OpenMode): Promise<AgentSession> {
    if (this.remote) {
      const env = childEnv(mergeEnv(this.profile.env, opts.env), opts.mcp, '');
      delete env.CODEX_HOME;
      return CodexSession.open(opts, mode, {
        command: this.profile.command,
        args: appServerArgs(this.profile.args),
        env,
        clientVersion: this.clientVersion,
        log: this.log,
        spawn: this.remote.spawn,
        // Its bubblewrap sandbox cannot make namespaces in a box; the box is the sandbox.
        sandboxed: false,
      });
    }
    const env = mergeEnv(process.env, this.profile.env, opts.env);
    const command = resolveBinary(this.profile.command, env);
    if (!command) throw new Error(`${this.profile.command} not found on PATH`);
    const home = await prepareCodexHome(this.home, env);
    if (!home.isolated && !this.reportedFallback) {
      this.reportedFallback = true;
      this.log.warn(`[codex] no auth.json or API key to link into ${this.home}; using ${home.path}`);
    }
    return CodexSession.open(opts, mode, {
      command,
      args: appServerArgs(this.profile.args),
      env: childEnv(env, opts.mcp, home.path),
      clientVersion: this.clientVersion,
      log: this.log,
    });
  }

  /**
   * One short-lived app-server: initialize (version from the user agent) and `account/read` (login state;
   * no network). Never starts a turn.
   */
  async probe(): Promise<EngineInfo> {
    const env = mergeEnv(process.env, this.profile.env);
    const base: EngineInfo = {
      kind: 'codex',
      profile: this.profile.name,
      installed: false,
      path: null,
      version: null,
      loggedIn: null,
      error: null,
    };
    const path = resolveBinary(this.profile.command, env);
    if (!path) return { ...base, error: `${this.profile.command} not found on PATH` };
    const info: EngineInfo = { ...base, installed: true, path };
    try {
      const home = await prepareCodexHome(this.home, env);
      const result = await withAppServer(
        path,
        appServerArgs(this.profile.args),
        childEnv(env, null, home.path),
        this.clientVersion,
        this.log,
        async (call, init) => {
          const version = /^[^/\s]+\/(\S+)/.exec(init.userAgent)?.[1] ?? null;
          const account = await call('account/read', { refreshToken: false });
          const loggedIn = account.account !== null || !account.requiresOpenaiAuth;
          return { version, loggedIn, error: loggedIn ? null : 'not logged in: run `codex login`' };
        },
      );
      return { ...info, ...result };
    } catch (error) {
      return { ...info, error: (error as Error).message };
    }
  }

  /** The models this Codex offers in its picker (`model/list`), from a short-lived app-server. */
  async listModels(): Promise<{ id: string; name: string; description: string; isDefault: boolean }[]> {
    const env = mergeEnv(process.env, this.profile.env);
    const path = resolveBinary(this.profile.command, env);
    if (!path) throw new Error(`${this.profile.command} not found on PATH`);
    const home = await prepareCodexHome(this.home, env);
    return withAppServer(
      path,
      appServerArgs(this.profile.args),
      childEnv(env, null, home.path),
      this.clientVersion,
      this.log,
      async (call) => {
        const models: { id: string; name: string; description: string; isDefault: boolean }[] = [];
        let cursor: string | null = null;
        do {
          const page: ModelListResponse = await call('model/list', { cursor, includeHidden: false });
          for (const m of page.data) {
            models.push({ id: m.model, name: m.displayName, description: m.description, isDefault: m.isDefault });
          }
          cursor = page.nextCursor;
        } while (cursor && models.length < 200);
        return models;
      },
    );
  }
}

type Call = <M extends ClientMethod>(method: M, params: ClientMethods[M][0]) => Promise<ClientMethods[M][1]>;

/** Runs `fn` against a short-lived, initialized app-server that never starts a turn. */
async function withAppServer<T>(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  clientVersion: string,
  log: Logger,
  fn: (call: Call, init: ClientMethods['initialize'][1]) => Promise<T>,
): Promise<T> {
  const child = spawn(command, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const gone = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const rpc = new JsonRpcPeer({
    write: (line) => child.stdin.write(`${line}\n`),
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });
  const call: Call = (method, params) => rpc.request(method, params);
  const lines = new LineSplitter();
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of lines.push(chunk)) rpc.receive(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => log.info(`[codex] ${chunk.trimEnd()}`));
  child.once('error', (error) => rpc.close(error));
  child.once('exit', (code) => rpc.close(new Error(`codex app-server exited (code ${code ?? 'null'})`)));
  try {
    const init = await call('initialize', {
      clientInfo: { name: 'legion', title: 'Legion', version: clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify('initialized');
    return await fn(call, init);
  } finally {
    rpc.close();
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await gone;
    clearTimeout(timer);
  }
}
