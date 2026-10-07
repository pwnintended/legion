/**
 * Codex adapter: `AgentEngine` over `codex app-server` (JSON-RPC 2.0, JSONL on stdio), one child
 * process per session. See README.md for the verified protocol details and the config-isolation choice.
 */
import { spawn } from 'node:child_process';
import type { AgentEngine, AgentSession, EngineInfo, SessionOptions } from '@shared/engine';
import { appServerArgs, prepareCodexHome, resolveBinary } from './config';
import { JsonRpcPeer, LineSplitter } from './json-rpc';
import type { ClientMethod, ClientMethods } from './methods';
import { CodexSession, type OpenMode } from './session';

export { CodexSession } from './session';

export interface CodexEngineOptions {
  /**
   * Legion-owned CODEX_HOME (e.g. `<dataDir>/codex-home`): only the user's `auth.json` is linked into
   * it, so user config, hooks, rules and AGENTS.md don't leak into Legion runs. Threads are stored there,
   * so keep it stable across restarts (resume needs it). `null` = use the user's own CODEX_HOME.
   */
  codexHome: string | null;
  /** Environment used by `probe()` (sessions use `SessionOptions.env`). Needs the login-shell PATH. */
  env?: Readonly<Record<string, string>>;
  /** Binary name or absolute path (default `codex`, resolved on the PATH of the env in use). */
  binary?: string;
  /** Reported as `clientInfo.version` to the app-server. */
  clientVersion?: string;
  /** stderr lines of codex child processes. */
  onStderr?: (line: string) => void;
}

const PROBE_TIMEOUT_MS = 20_000;

export class CodexEngine implements AgentEngine {
  readonly kind = 'codex' as const;

  constructor(private readonly options: CodexEngineOptions) {}

  start(opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, { kind: 'start' });
  }

  resume(sessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, { kind: 'resume', threadId: sessionId });
  }

  private async open(opts: SessionOptions, mode: OpenMode): Promise<AgentSession> {
    const binary = this.options.binary ?? 'codex';
    const command = await resolveBinary(binary, opts.env);
    if (!command) throw new Error(`${binary} not found on PATH`);
    const home = await prepareCodexHome(this.options.codexHome, opts.env);
    return CodexSession.open(opts, mode, {
      command,
      args: appServerArgs(),
      codexHome: home.path,
      clientVersion: this.options.clientVersion ?? '0.0.0',
      onStderr: this.options.onStderr,
    });
  }

  /**
   * One short-lived app-server: initialize (version from the user agent), `account/read` (login state;
   * no network), `model/list`. Never starts a turn.
   */
  async probe(): Promise<EngineInfo> {
    const env = this.options.env ?? cleanEnv(process.env);
    const binary = this.options.binary ?? 'codex';
    const base: EngineInfo = {
      kind: 'codex',
      installed: false,
      path: null,
      version: null,
      loggedIn: null,
      account: null,
      models: [],
      error: null,
      probedAt: Date.now(),
    };
    const path = await resolveBinary(binary, env);
    if (!path) return { ...base, error: `${binary} not found on PATH` };
    const info: EngineInfo = { ...base, installed: true, path };
    try {
      const home = await prepareCodexHome(this.options.codexHome, env);
      return { ...info, ...(await probeAppServer(path, { ...env, CODEX_HOME: home.path }, this.options)) };
    } catch (error) {
      return { ...info, error: (error as Error).message };
    }
  }
}

async function probeAppServer(
  command: string,
  env: Record<string, string>,
  options: CodexEngineOptions,
): Promise<Pick<EngineInfo, 'version' | 'loggedIn' | 'account' | 'models' | 'error'>> {
  const child = spawn(command, appServerArgs(), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const gone = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const rpc = new JsonRpcPeer({
    write: (line) => child.stdin.write(`${line}\n`),
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });
  const call = <M extends ClientMethod>(method: M, params: ClientMethods[M][0]) =>
    rpc.request<ClientMethods[M][1]>(method, params);
  const lines = new LineSplitter();
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of lines.push(chunk)) rpc.receive(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => options.onStderr?.(chunk.trimEnd()));
  child.once('error', (error) => rpc.close(error));
  child.once('exit', (code) => rpc.close(new Error(`codex app-server exited (code ${code ?? 'null'})`)));
  try {
    const init = await call('initialize', {
      clientInfo: { name: 'legion', title: 'Legion', version: options.clientVersion ?? '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify('initialized');
    const version = /^[^/\s]+\/(\S+)/.exec(init.userAgent)?.[1] ?? null;
    const account = await call('account/read', { refreshToken: false });
    const models = await call('model/list', { includeHidden: false }).then(
      (list) => list.data.filter((model) => !model.hidden).map((model) => model.id),
      () => [] as string[],
    );
    const label =
      account.account?.type === 'chatgpt'
        ? [account.account.email, account.account.planType].filter(Boolean).join(' · ') || 'ChatGPT'
        : account.account?.type === 'apiKey'
          ? 'API key'
          : account.account?.type === 'amazonBedrock'
            ? 'Amazon Bedrock'
            : null;
    const loggedIn = account.account !== null || !account.requiresOpenaiAuth;
    return {
      version,
      loggedIn,
      account: label,
      models,
      error: loggedIn ? null : 'not logged in: run `codex login`',
    };
  } finally {
    rpc.close();
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await gone;
    clearTimeout(timer);
  }
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}
