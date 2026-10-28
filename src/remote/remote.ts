/**
 * Remote mode (`[remote] enabled`, `legion --remote`, `/remote on`): a run's steps in its own worktrees, agents and
 * `sh` alike, run in Upstash Boxes, one box per worktree, made when a step first needs it and deleted when the run
 * ends. The assistant, leads, and steps in your own checkout stay on this machine. The switch is read at every step,
 * so turning it off or on mid-run is safe: the local worktree is always the source of truth (`workspace.ts`).
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RemoteConfig } from '../config.ts';
import { ClaudeEngine } from '../engine/claude/index.ts';
import { CodexEngine } from '../engine/codex/index.ts';
import type { AgentEngine, AgentSession, EngineProfile, McpServer, SessionOptions } from '../engine/types.ts';
import { gitText } from '../git/exec.ts';
import { type Logger, silentLogger } from '../util/log.ts';
import type { RunHost, ShellOptions, ShellResult } from '../workflow/host.ts';
import type { BoxProvider } from './box.ts';
import { RemoteChild } from './process.ts';
import { Workspace } from './workspace.ts';

export interface RemoteOptions {
  /** Where Legion makes this repository's worktrees (`worktreeRoot`): a run's are under `<root>/<run id>`. */
  worktreeRoot: string;
  config: () => RemoteConfig;
  /** Remote mode is on (read at every step). */
  enabled: () => boolean;
  /** The boxes; throws when there is no API key. Called only when a box is needed. */
  provider: () => BoxProvider;
  log?: Logger;
}

/** Profile names get this suffix in remote mode, so a session is only resumed where it was started. */
export const REMOTE_PROFILE_SUFFIX = '@box';

export class Remote {
  private readonly opts: RemoteOptions;
  private readonly log: Logger;
  /** By worktree top level. */
  private readonly workspaces = new Map<string, Promise<Workspace>>();
  /** Runs that used a box in this process (their boxes are deleted when they end). */
  private readonly used = new Set<string>();
  private readonly warnedMcp = new Set<string>();

  constructor(opts: RemoteOptions) {
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** `host` with its worktree steps sent to boxes while remote mode is on. */
  host(host: RunHost, runId: string): RunHost {
    return {
      ...host,
      engine: (kind) => {
        const local = host.engine(kind);
        return kind === 'fake' || host.dryRun || !this.opts.enabled() ? local : this.engine(local, kind, runId);
      },
      sh: (command, opts) =>
        !host.dryRun && this.opts.enabled() && this.owns(runId, opts.cwd)
          ? this.sh(runId, command, opts)
          : host.sh(command, opts),
    };
  }

  /** Deletes the boxes of a run that ended. */
  async release(runId: string): Promise<void> {
    for (const [path, ws] of [...this.workspaces]) {
      if (inside(path, join(this.opts.worktreeRoot, runId))) {
        this.workspaces.delete(path);
        void ws.catch(() => undefined);
      }
    }
    if (!this.used.delete(runId) && !this.opts.enabled()) return;
    await this.opts.provider().removeLabeled(runLabel(runId));
  }

  /** `cwd` is in one of the run's worktrees (not your checkout, not a lead's). */
  owns(runId: string, cwd: string): boolean {
    const dir = join(this.opts.worktreeRoot, runId);
    return inside(cwd, dir) || inside(realpath(cwd), realpath(dir));
  }

  private engine(local: AgentEngine, kind: 'claude' | 'codex', runId: string): AgentEngine {
    const profile: EngineProfile = { ...local.profile, name: `${local.profile.name}${REMOTE_PROFILE_SUFFIX}` };
    const open = async (opts: SessionOptions, resumeId: string | null): Promise<AgentSession> => {
      const { ws, cwd } = await this.workspace(runId, opts.cwd);
      await ws.push();
      await ws.ensureCli(kind);
      const engine = this.boxEngine(ws, kind, profile.name);
      const boxOpts = { ...opts, cwd, mcp: this.reachable(opts.mcp) };
      // A box made after the session was (a resumed run, an expired box) does not have it: start over.
      const canResume = resumeId !== null && (!ws.created || ws.sessions.has(resumeId));
      if (resumeId && !canResume)
        this.log.info(`remote: session ${resumeId} is not in box ${ws.box.id}; starting a new one`);
      const session = canResume ? await engine.resume(resumeId as string, boxOpts) : await engine.start(boxOpts);
      if (session.id) ws.sessions.add(session.id);
      return pullOnClose(session, ws);
    };
    return {
      kind,
      profile,
      probe: () => local.probe(),
      start: (opts) => (this.owns(runId, opts.cwd) ? open(opts, null) : local.start(opts)),
      resume: (id, opts) => (this.owns(runId, opts.cwd) ? open(opts, id) : local.resume(id, opts)),
    };
  }

  /**
   * The MCP servers a box can use: one on this machine's loopback (`http://127.0.0.1:…`) is out of its reach and
   * left out. Stdio servers start in the box, so they work when its snapshot has them installed.
   */
  private reachable(servers: SessionOptions['mcp']): SessionOptions['mcp'] {
    if (!servers) return servers;
    const out: Record<string, McpServer> = {};
    for (const [name, server] of Object.entries(servers)) {
      if (server.type === 'http' && isLoopback(server.url)) {
        if (!this.warnedMcp.has(name))
          this.log.warn(`remote: MCP server "${name}" (${server.url}) is local; boxes go without it`);
        this.warnedMcp.add(name);
      } else out[name] = server;
    }
    return out;
  }

  /** An engine whose processes run in `ws`'s box, on the CLI installed there. */
  private boxEngine(ws: Workspace, kind: 'claude' | 'codex', name: string): AgentEngine {
    const profile: EngineProfile = { name, kind, command: kind, args: [], env: {} };
    const spawn = (command: string, args: readonly string[], o: { cwd: string; env: Record<string, string> }) =>
      new RemoteChild((io) => ws.start([command, ...args], { cwd: o.cwd, env: o.env, ...io }));
    return kind === 'claude'
      ? new ClaudeEngine(profile, { log: this.log, remote: { spawn, tempDirs: ['/tmp'] } })
      : new CodexEngine(profile, { log: this.log, remote: { spawn } });
  }

  private async sh(runId: string, command: string, opts: ShellOptions): Promise<ShellResult> {
    const { ws, cwd } = await this.workspace(runId, opts.cwd);
    await ws.push();
    try {
      return await ws.exec(['/bin/sh', '-c', command], {
        cwd,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } finally {
      await ws.pull();
    }
  }

  /** The workspace of the worktree holding `cwd`, and `cwd` as a path in it. */
  private async workspace(runId: string, cwd: string): Promise<{ ws: Workspace; cwd: string }> {
    const top = await gitText(cwd, ['rev-parse', '--show-toplevel']);
    const at = join(top, relative(top, realpath(cwd)));
    let ws = this.workspaces.get(top);
    if (!ws) {
      this.used.add(runId);
      ws = this.opts
        .provider()
        .open(boxName(runId, top), ['legion', runLabel(runId)])
        .then(({ box, created }) => {
          this.log.info(`remote: ${created ? 'made' : 'reattached'} box ${box.id} for ${top}`);
          return new Workspace({ path: top, box, created, config: this.opts.config, log: this.log });
        });
      ws.catch(() => this.workspaces.delete(top));
      this.workspaces.set(top, ws);
    }
    return { ws: await ws, cwd: at };
  }
}

/** `session`, whose `close()` also brings the box's changes back: the next step then sees them locally. */
function pullOnClose(session: AgentSession, ws: Workspace): AgentSession {
  let pulled: Promise<void> | null = null;
  return {
    engine: session.engine,
    get id() {
      return session.id;
    },
    events: session.events,
    send: (text, priority) => session.send(text, priority),
    interrupt: () => session.interrupt(),
    respond: (id, decision) => session.respond(id, decision),
    answer: (id, answers) => session.answer(id, answers),
    close: async () => {
      await session.close();
      pulled ??= ws.pull();
      await pulled;
    },
  };
}

/** Box labels: letters, digits, `.`, `_`, `-`, `:`, at most 20 characters. */
export function runLabel(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 20);
}

export function boxName(runId: string, worktree: string): string {
  return `legion-${runLabel(runId)}-${createHash('sha1').update(worktree).digest('hex').slice(0, 10)}`;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.') || host === '0.0.0.0';
  } catch {
    return false;
  }
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
