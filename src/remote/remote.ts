/**
 * Remote mode (`[remote] enabled`, `legion --remote`, `/remote on`): a run's steps in its own worktrees, agents and
 * `sh` alike, run in Upstash Boxes, one box per worktree, made when a step first needs it and deleted when the run
 * ends. The assistant, leads, and steps in your own checkout stay on this machine. The switch is read at every step,
 * so turning it off or on mid-run is safe: the local worktree is always the source of truth (`workspace.ts`).
 *
 * Boxes start from the box image (`image.ts`), which the box agent (the builtin `box` workflow) makes and extends.
 * Agents in a box do not install system packages or toolchains themselves: they ask with `legion-need`, the request
 * goes to the assistant, and the assistant has the box agent add it (`provision_box`). Boxes already running are
 * brought up to a new image before their next step.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RemoteConfig } from '../config.ts';
import { ClaudeEngine } from '../engine/claude/index.ts';
import { CodexEngine } from '../engine/codex/index.ts';
import type {
  AgentEngine,
  AgentEvent,
  AgentSession,
  EngineProfile,
  McpServer,
  SessionOptions,
} from '../engine/types.ts';
import { gitText } from '../git/exec.ts';
import { type Logger, silentLogger } from '../util/log.ts';
import type { RunHost, ShellOptions, ShellResult } from '../workflow/host.ts';
import type { BoxProvider } from './box.ts';
import { type BoxImage, readBoxFiles, readImage, writeBoxFiles, writeImage } from './image.ts';
import { RemoteChild } from './process.ts';
import { type NeedRequest, Workspace } from './workspace.ts';

/** The builtin workflow of the box agent: its steps always run in a box, and it may install things. */
export const BOX_WORKFLOW = 'box';

/** Told to every workflow agent in a box (except the box agent). */
export const BOX_GUIDE = `# Your machine
You work in a remote Linux box (an Upstash Box, Debian), in a copy of the worktree that is synced back when your step ends. Its tools and dependencies come from the project's box image.
- Installing project dependencies as part of your change is fine (\`pnpm install\` after editing package.json, cargo fetching crates).
- A system package, toolchain or CLI that is missing (apt packages, a language runtime, ffmpeg, a linter): do not install it yourself. Run \`legion-need '<what, with the version if it matters>' '<why you need it>'\`. The assistant decides, and the box agent adds it to the box image for every agent.
- Then carry on with what you can do without it. If you cannot finish without it, end your turn and say plainly that you are blocked on it.`;

export interface RemoteOptions {
  /** The user's checkout: the box image's state and files live in its `.legion/box/`. */
  repo: string;
  /** Where Legion makes this repository's worktrees (`worktreeRoot`): a run's are under `<root>/<run id>`. */
  worktreeRoot: string;
  config: () => RemoteConfig;
  /** Remote mode is on (read at every step). */
  enabled: () => boolean;
  /** The boxes; throws when there is no API key. Called only when a box is needed. */
  provider: () => BoxProvider;
  /** An agent asked for a tool or dependency (`legion-need`). */
  onNeed?: (need: Need) => void;
  /** Something the assistant should know about remote mode. */
  notify?: (text: string) => void;
  log?: Logger;
}

export interface Need extends NeedRequest {
  runId: string;
  /** The agent step that asked (null when unknown). */
  step: string | null;
  at: number;
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
  /** The step key of each box session, as the runtime reports it. */
  private readonly steps = new WeakMap<AgentSession, string>();
  /** Requests not yet handed to the box agent. */
  private needs: Need[] = [];
  private toldNoImage = false;
  /** Runs of the box agent, which make the image rather than need it. */
  private readonly boxRuns = new Set<string>();

  constructor(opts: RemoteOptions) {
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** `host` with its worktree steps sent to boxes while remote mode is on (always, for the box agent's runs). */
  host(host: RunHost, run: { id: string; workflow: string }): RunHost {
    const boxRun = run.workflow === BOX_WORKFLOW;
    if (boxRun) this.boxRuns.add(run.id);
    const on = () => !host.dryRun && (boxRun || this.opts.enabled());
    return {
      ...host,
      engine: (kind) => {
        const local = host.engine(kind);
        return kind === 'fake' || !on() ? local : this.engine(local, kind, run.id, boxRun);
      },
      sh: (command, opts) =>
        on() && this.owns(run.id, opts.cwd) ? this.sh(run.id, command, opts) : host.sh(command, opts),
      agentSession: (step, session) => {
        if (session) this.steps.set(session, step);
        host.agentSession?.(step, session);
      },
      box: {
        prepare: async (cwd) => this.prepare(cwd),
        snapshot: (cwd, about) => this.snapshot(run.id, cwd, about),
      },
    };
  }

  /** The image boxes start from: the box agent's, else `[remote] snapshot`; null: fresh boxes. */
  image(): { snapshot: string; clone: string | null; managed: BoxImage | null } | null {
    const managed = readImage(this.opts.repo);
    if (managed) return { snapshot: managed.snapshot, clone: managed.clone, managed };
    const { snapshot, clone } = this.opts.config();
    return snapshot ? { snapshot, clone: clone ?? null, managed: null } : null;
  }

  /** Requests not yet given to the box agent. */
  pendingNeeds(): readonly Need[] {
    return this.needs;
  }

  /** The box agent takes these over (`provision_box`). */
  clearNeeds(): void {
    this.needs = [];
  }

  /** Deletes the boxes of a run that ended. */
  async release(runId: string): Promise<void> {
    this.boxRuns.delete(runId);
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

  private engine(local: AgentEngine, kind: 'claude' | 'codex', runId: string, boxRun: boolean): AgentEngine {
    const profile: EngineProfile = { ...local.profile, name: `${local.profile.name}${REMOTE_PROFILE_SUFFIX}` };
    const open = async (opts: SessionOptions, resumeId: string | null): Promise<AgentSession> => {
      const { ws, cwd } = await this.workspace(runId, opts.cwd);
      await this.upToDate(ws);
      await ws.push();
      await ws.ensureCli(kind);
      const engine = this.boxEngine(ws, kind, profile.name);
      const boxOpts: SessionOptions = {
        ...opts,
        cwd,
        mcp: this.reachable(opts.mcp),
        systemPrompt: boxRun
          ? (opts.systemPrompt ?? null)
          : [opts.systemPrompt, BOX_GUIDE].filter(Boolean).join('\n\n'),
      };
      // A box made after the session was (a resumed run, an expired box) does not have it: start over.
      const canResume = resumeId !== null && (!ws.created || ws.sessions.has(resumeId));
      if (resumeId && !canResume)
        this.log.info(`remote: session ${resumeId} is not in box ${ws.box.id}; starting a new one`);
      const session = canResume ? await engine.resume(resumeId as string, boxOpts) : await engine.start(boxOpts);
      if (session.id) ws.sessions.add(session.id);
      return this.boxSession(session, ws, runId);
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
   * `session` as the runtime sees it: a `legion-need` it runs is collected as soon as it has run, and `close()`
   * brings the box's changes back, so the next step sees them locally.
   */
  private boxSession(session: AgentSession, ws: Workspace, runId: string): AgentSession {
    const remote = this;
    let pulled: Promise<void> | null = null;
    const needCalls = new Set<string>();
    function step(): string | null {
      return remote.steps.get(wrapper) ?? null;
    }
    const wrapper: AgentSession = {
      engine: session.engine,
      get id() {
        return session.id;
      },
      events: (async function* (): AsyncGenerator<AgentEvent> {
        for await (const event of session.events) {
          if (event.type === 'tool_call' && JSON.stringify(event.input ?? '').includes('legion-need')) {
            needCalls.add(event.id);
          } else if (event.type === 'tool_result' && needCalls.delete(event.id)) {
            void remote.collect(ws, runId, step());
          }
          yield event;
        }
      })(),
      send: (text, priority) => session.send(text, priority),
      interrupt: () => session.interrupt(),
      respond: (id, decision) => session.respond(id, decision),
      answer: (id, answers) => session.answer(id, answers),
      close: async () => {
        await session.close();
        pulled ??= ws.pull().then(() => remote.collect(ws, runId, step()));
        await pulled;
      },
    };
    return wrapper;
  }

  /** Hands the box's waiting `legion-need` requests to the assistant. */
  private async collect(ws: Workspace, runId: string, step: string | null): Promise<void> {
    let requests: NeedRequest[];
    try {
      requests = await ws.takeRequests();
    } catch (err) {
      this.log.warn(`remote: reading legion-need requests from box ${ws.box.id}`, err);
      return;
    }
    for (const request of requests) {
      if (!request.what) continue;
      const need: Need = { ...request, runId, step, at: Date.now() };
      this.needs.push(need);
      this.opts.onNeed?.(need);
    }
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
    await this.upToDate(ws);
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

  /** A box made from an older image (or reattached, image unknown) gets the current one's files run in it. */
  private async upToDate(ws: Workspace): Promise<void> {
    const image = this.image();
    if (!image || ws.image === image.snapshot) return;
    await ws.upgrade(image.snapshot, readBoxFiles(this.opts.repo));
  }

  /** The box agent's worktree gets the box files as they are in the user's checkout (committed or not). */
  private prepare(cwd: string): string[] {
    return writeBoxFiles(cwd, readBoxFiles(this.opts.repo));
  }

  /**
   * After the box agent: its box becomes the box image. Its box files go into the user's checkout, the previous
   * image the box agent made is deleted, and boxes that are running get the new files.
   */
  private async snapshot(
    runId: string,
    cwd: string,
    about: { requests: string[]; summary: string },
  ): Promise<{ snapshot: string; changed: string[] }> {
    const { ws } = await this.workspace(runId, cwd);
    await ws.pull();
    await ws.installEnv();
    const snapshot = await ws.box.snapshot(`legion-image-${runLabel(runId)}`);
    const previous = readImage(this.opts.repo);
    writeImage(this.opts.repo, {
      snapshot,
      clone: ws.path,
      builtAt: Date.now(),
      runId,
      requests: about.requests,
      summary: about.summary,
    });
    ws.image = snapshot;
    const files = readBoxFiles(ws.path);
    const changed = writeBoxFiles(this.opts.repo, files);
    if (previous && previous.snapshot !== snapshot) {
      await this.opts
        .provider()
        .deleteSnapshot(previous.snapshot)
        .catch((err) => this.log.warn(`remote: deleting the old box image ${previous.snapshot}`, err));
    }
    for (const [path, other] of this.workspaces) {
      if (path === ws.path) continue;
      void other
        .then((o) => o.upgrade(snapshot, files))
        .catch((err) => this.log.warn(`remote: bringing the box of ${path} up to the new image`, err));
    }
    return { snapshot, changed };
  }

  /** The workspace of the worktree holding `cwd`, and `cwd` as a path in it. */
  private async workspace(runId: string, cwd: string): Promise<{ ws: Workspace; cwd: string }> {
    const top = await gitText(cwd, ['rev-parse', '--show-toplevel']);
    const at = join(top, relative(top, realpath(cwd)));
    let ws = this.workspaces.get(top);
    if (!ws) {
      this.used.add(runId);
      const image = this.image();
      if (!image && !this.toldNoImage && !this.boxRuns.has(runId)) {
        this.toldNoImage = true;
        this.opts.notify?.(
          'Remote mode is on, but there is no box image yet: boxes start bare (no project toolchain or dependencies). Have the box agent make one with provision_box.',
        );
      }
      const settings = (): RemoteConfig => {
        const config = this.opts.config();
        if (!image?.managed) return config;
        const { clone: _, ...rest } = config;
        return image.clone ? { ...rest, clone: image.clone } : rest;
      };
      ws = this.opts
        .provider()
        .open(boxName(runId, top), ['legion', runLabel(runId)], image?.snapshot ?? null)
        .then(({ box, created }) => {
          this.log.info(`remote: ${created ? 'made' : 'reattached'} box ${box.id} for ${top}`);
          return new Workspace({
            path: top,
            box,
            created,
            image: created ? (image?.snapshot ?? null) : null,
            config: settings,
            log: this.log,
          });
        });
      ws.catch(() => this.workspaces.delete(top));
      this.workspaces.set(top, ws);
    }
    return { ws: await ws, cwd: at };
  }
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
