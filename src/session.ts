/**
 * One Legion session in one directory: the configuration, the engine profile in use per kind, the engines, the
 * workflow runs and the assistant. The TUI and the headless commands both sit on top of this.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Assistant } from './assistant/assistant.ts';
import { type BoxTools, type McpHandle, startMcpServer } from './assistant/mcp.ts';
import { assistantSystemPrompt, leadSystemPrompt } from './assistant/prompt.ts';
import {
  type Config,
  type ConfigLayer,
  configLayers,
  type Effort,
  ensureProjectConfig,
  loadConfig,
  mcpServers,
  profileNames,
  type RealKind,
  type ResolvedProfile,
  resolveProfile,
  resolveTier,
} from './config.ts';
import { ClaudeEngine } from './engine/claude/index.ts';
import { CodexEngine } from './engine/codex/index.ts';
import { FakeEngine } from './engine/fake/index.ts';
import type { AgentEngine, EngineKind } from './engine/types.ts';
import { isRepo, toplevel } from './git/index.ts';
import { UpstashBoxes } from './remote/box.ts';
import { BOX_WORKFLOW, Remote } from './remote/remote.ts';
import { TeamManager } from './team/team.ts';
import { createWorkspaces } from './team/workspace.ts';
import { fileLogger, type Logger } from './util/log.ts';
import { createGitOps, worktreeRoot } from './workflow/git-ops.ts';
import type { GitOps } from './workflow/host.ts';
import { RunManager } from './workflow/manager.ts';

export interface SessionOptions {
  cwd: string;
  /** Profile overrides for this session (`--claude claude-2`). */
  profiles?: Partial<Record<RealKind, string>>;
  /** Resume the last conversation in this directory (`--continue`). */
  continueLast?: boolean;
  /** Use scripted engines everywhere (demos, tests): `LEGION_FAKE_ENGINES=1`. */
  fake?: boolean;
  /** Remote mode for this session, over `[remote] enabled` (`--remote` / `--local`). */
  remote?: boolean;
}

interface SavedState {
  assistant?: { sessionId: string; profile: string; kind: RealKind };
}

export class Session {
  readonly repo: string;
  /** Where the session was started (inside `repo`, or `repo` itself). */
  readonly cwd: string;
  readonly isGitRepo: boolean;
  /** The project config file this session created because there was none, if it did. */
  readonly createdConfig: string | null;
  private _config: Config;
  readonly log: Logger;
  readonly runs: RunManager;
  readonly assistant: Assistant;
  /** The leads under the assistant (the orchestrator). */
  readonly team: TeamManager;
  private readonly profiles: Record<RealKind, ResolvedProfile>;
  private readonly engines = new Map<string, AgentEngine>();
  private readonly fake: boolean;
  private mcp: McpHandle | null = null;
  /** `/remote on|off` or `--remote` / `--local`; null: `[remote] enabled` decides. */
  private remoteOverride: boolean | null;

  private constructor(init: {
    repo: string;
    cwd: string;
    isGitRepo: boolean;
    createdConfig: string | null;
    config: Config;
    log: Logger;
    profiles: Record<RealKind, ResolvedProfile>;
    runs: RunManager;
    team: TeamManager;
    mcp: McpHandle;
    resumeAssistant: string | null;
    fake: boolean;
    remote: boolean | null;
  }) {
    this.repo = init.repo;
    this.cwd = init.cwd;
    this.isGitRepo = init.isGitRepo;
    this.createdConfig = init.createdConfig;
    this._config = init.config;
    this.log = init.log;
    this.profiles = init.profiles;
    this.fake = init.fake;
    this.remoteOverride = init.remote;
    this.mcp = init.mcp;
    this.runs = init.runs;
    this.team = init.team;
    this.assistant = new Assistant({
      cwd: this.repo,
      engine: () => this.engine(this.assistantModel().engine as RealKind),
      systemPrompt: () => assistantSystemPrompt({ repo: this.repo, profiles: this.profileNames() }),
      mcp: { legion: { type: 'http', url: init.mcp.url, headers: { Authorization: `Bearer ${init.mcp.token}` } } },
      model: () => this.assistantModel().model,
      effort: () => this.assistantModel().effort,
      approvals: () => this.config.assistant.approvals,
      sessionId: init.resumeAssistant,
      log: this.log,
    });
    this.assistant.on('session', ({ id, profile }) =>
      this.save({ assistant: { sessionId: id, profile, kind: this.assistantModel().engine as RealKind } }),
    );
  }

  /**
   * Prepares a session. Profile `setup` commands are not run here: the caller runs them first (`runSetup`)
   * while it still owns the terminal.
   */
  static async open(opts: SessionOptions): Promise<Session> {
    const isGitRepo = await isRepo(opts.cwd);
    const repo = isGitRepo ? await toplevel(opts.cwd) : opts.cwd;
    const config = loadConfig(repo, opts.cwd);
    const createdConfig = ensureProjectConfig(repo, opts.cwd, config);
    const log = fileLogger(join(repo, '.legion', 'session', 'legion.log'));
    const profiles = {
      claude: resolveProfile(config, 'claude', opts.profiles?.claude),
      codex: resolveProfile(config, 'codex', opts.profiles?.codex),
    };
    ensureGitignore(repo);
    let resumeAssistant: string | null = null;
    if (opts.continueLast) {
      const saved = readState(repo).assistant;
      const kind = resolveTier(config.models, 'assistant', config.assistant).engine as RealKind;
      if (saved && saved.kind === kind && saved.profile === profiles[kind].name) resumeAssistant = saved.sessionId;
    }
    // Runs ask the session for engines, and the session needs the runs' MCP server: bind late.
    const self: { session?: Session } = {};
    const warm = () => self.session?.config.worktrees ?? config.worktrees;
    const git = isGitRepo ? await createGitOps({ repo, warm, log }) : notAGitRepo(repo);
    const bound = () => {
      if (!self.session) throw new Error('session not ready');
      return self.session;
    };
    let boxes: { key: string; provider: UpstashBoxes } | null = null;
    const remote = new Remote({
      repo,
      worktreeRoot: worktreeRoot(repo),
      config: () => bound().config.remote,
      enabled: () => bound().remoteEnabled,
      provider: () => {
        const key = process.env.UPSTASH_BOX_API_KEY || bound().config.remote.apiKey;
        if (!key) {
          throw new Error(
            'remote mode needs an Upstash Box API key: set [remote] apiKey in ~/.config/legion/config.toml or .legion/config.local.toml (or UPSTASH_BOX_API_KEY)',
          );
        }
        if (boxes?.key !== key) boxes = { key, provider: new UpstashBoxes(() => bound().config.remote, key) };
        return boxes.provider;
      },
      onNeed: (need) => {
        const run = bound().runs.run(need.runId);
        bound().team.notifyOrchestrator(
          `Agent ${need.step ?? '(a step)'} of run ${need.runId}${run ? ` (${run.workflow})` : ''} needs in its box: ${need.what}${need.why ? `. Why: ${need.why}` : ''}. Decide whether the box image should get it: provision_box has the box agent add it (gather what more agents asked for first, box_status lists them). Once it is in, unblock the agent: message_agent while it still runs, else retry_run.`,
        );
      },
      notify: (text) => bound().team.notifyOrchestrator(text),
      log,
    });
    const runs = new RunManager({
      repo,
      engine: (kind) => bound().engine(kind),
      profiles: () => bound().profileNames(),
      git,
      maxAgents: config.workflows.maxAgents,
      maxAgentsTotal: config.workflows.maxAgentsTotal,
      approvals: config.workflows.approvals,
      agentModels: () => bound().config,
      mcp: () => mcpServers(bound().config),
      wrapHost: (host, run) => remote.host(host, run),
      onRunEnded: (runId) => remote.release(runId),
      log,
    });
    const team = new TeamManager({
      repo,
      runs,
      config: () => bound().config,
      engine: (kind) => bound().engine(kind),
      mcp: () => mcpServers(bound().config),
      prompt: (lead, role) =>
        leadSystemPrompt({
          repo,
          profiles: bound().profileNames(),
          name: lead.name,
          role,
          gates: role.gates,
          parent: lead.parent,
          depth: lead.depth,
          maxDepth: bound().config.team.maxDepth,
          workspace: lead.workspace ?? null,
        }),
      workspaces: isGitRepo ? createWorkspaces(repo, { warm, log }) : null,
      log,
    });
    const mcp = await startMcpServer({
      repo,
      runs,
      team,
      boxes: isGitRepo ? boxTools(remote, runs, () => bound()) : null,
      log,
    });
    self.session = new Session({
      repo,
      cwd: opts.cwd,
      isGitRepo,
      createdConfig,
      config,
      log,
      profiles,
      runs,
      team,
      mcp,
      resumeAssistant,
      fake: opts.fake ?? false,
      remote: opts.remote ?? null,
    });
    team.bind(self.session.assistant, mcp.url);
    return self.session;
  }

  get config(): Config {
    return this._config;
  }

  /** The assistant's engine, model and effort: `[assistant]` on the `assistant` tier of the provider. */
  assistantModel(): { engine: string; model: string | null; effort: Effort | null } {
    return resolveTier(this._config.models, 'assistant', this._config.assistant);
  }

  /** Runs the last session left unfinished (its exit, or a crash), continued unless `[workflows] resumeOnStart = false`. */
  async resumeInterruptedRuns(): Promise<string[]> {
    if (!this._config.workflows.resumeOnStart || !this.isGitRepo) return [];
    return this.runs.resumeInterrupted();
  }

  /** The Legion MCP endpoint (each caller authenticates with its own token: `team.tokens()`). */
  get mcpUrl(): string | null {
    return this.mcp?.url ?? null;
  }

  /** The config files in the order they apply, including absent ones. */
  configLayers(): ConfigLayer[] {
    return configLayers(this.repo, this.cwd);
  }

  /**
   * Re-reads the configuration (after `/config edit`). Profiles keep their name when it still exists; runs started
   * from now on get the new workflow settings; the assistant starts over only if its engine, model or profile
   * changed. Returns what changed, for the user.
   */
  async reloadConfig(): Promise<string[]> {
    const next = loadConfig(this.repo, this.cwd);
    const prev = this._config;
    const notes: string[] = [];
    const assistantOf = (c: Config) => {
      const r = resolveTier(c.models, 'assistant', c.assistant);
      return { ...c.assistant, ...r, profile: this.profiles[r.engine as RealKind].name };
    };
    const prevAssistant = assistantOf(prev);
    for (const kind of ['claude', 'codex'] as const) {
      const keep = this.profiles[kind].name;
      const names = profileNames(next, kind);
      const profile = resolveProfile(next, kind, names.includes(keep) ? keep : undefined);
      if (profile.name !== keep) notes.push(`${kind} now uses profile "${profile.name}" ("${keep}" is gone)`);
      if (JSON.stringify(profile) !== JSON.stringify(this.profiles[kind])) {
        for (const key of [...this.engines.keys()]) if (key.startsWith(`${kind}:`)) this.engines.delete(key);
      }
      this.profiles[kind] = profile;
    }
    this._config = next;
    if (next.remote.enabled !== prev.remote.enabled) {
      // A changed setting wins over an earlier `/remote` for this session.
      this.remoteOverride = null;
      notes.push(`remote mode ${next.remote.enabled ? 'on' : 'off'} from the next step`);
    }
    this.runs.configure({
      maxAgents: next.workflows.maxAgents,
      maxAgentsTotal: next.workflows.maxAgentsTotal,
      approvals: next.workflows.approvals,
    });
    const nextAssistant = assistantOf(next);
    if (JSON.stringify(prevAssistant) !== JSON.stringify(nextAssistant)) {
      await this.assistant.restart();
      notes.push('the assistant starts a new conversation with the new settings');
    }
    return notes;
  }

  /** Workflow steps in run worktrees go to Upstash Boxes (`remote/`). */
  get remoteEnabled(): boolean {
    return this.remoteOverride ?? this._config.remote.enabled;
  }

  /** Turns remote mode on or off for this session (null: back to `[remote] enabled`). Applies from the next step. */
  setRemote(on: boolean | null): void {
    this.remoteOverride = on;
  }

  /** Why remote mode cannot work right now, or null. */
  remoteProblem(): string | null {
    if (!process.env.UPSTASH_BOX_API_KEY && !this._config.remote.apiKey) {
      return 'no Upstash Box API key: set [remote] apiKey in ~/.config/legion/config.toml or .legion/config.local.toml';
    }
    return this.isGitRepo ? null : 'not a git repository';
  }

  profile(kind: RealKind): ResolvedProfile {
    return this.profiles[kind];
  }

  profileNames(): Record<RealKind, string> {
    return { claude: this.profiles.claude.name, codex: this.profiles.codex.name };
  }

  availableProfiles(kind: RealKind): string[] {
    return profileNames(this.config, kind);
  }

  /** The engine for a kind on the session's current profile. */
  engine(kind: EngineKind): AgentEngine {
    if (kind === 'fake') return new FakeEngine();
    const profile = this.profiles[kind];
    const key = `${kind}:${profile.name}`;
    let engine = this.engines.get(key);
    if (!engine) {
      engine = this.fake
        ? new FakeEngine(kind, undefined, profile.name)
        : kind === 'claude'
          ? new ClaudeEngine(profile, { log: this.log })
          : new CodexEngine(profile, { log: this.log });
      this.engines.set(key, engine);
    }
    return engine;
  }

  /**
   * Switches a kind to another profile for new agents (running ones finish on the old one). Runs the profile's
   * setup with piped output, since the UI owns the terminal by now.
   */
  async switchProfile(kind: RealKind, name: string): Promise<{ setupOutput: string | null }> {
    const profile = resolveProfile(this.config, kind, name);
    let setupOutput: string | null = null;
    if (profile.setup) {
      const result = spawnSync(process.env.SHELL || '/bin/sh', ['-lc', profile.setup], {
        env: { ...process.env, ...profile.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      setupOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || null;
      if (result.status !== 0)
        throw new Error(`setup for ${kind} profile "${name}" failed (${result.status}): ${setupOutput ?? ''}`);
    }
    this.profiles[kind] = profile;
    if (this.assistantModel().engine === kind) await this.assistant.restart();
    return { setupOutput };
  }

  async close(): Promise<void> {
    await this.assistant.close();
    await this.team.close();
    await this.runs.shutdown();
    await this.mcp?.close();
    this.mcp = null;
  }

  private save(state: SavedState): void {
    try {
      const dir = join(this.repo, '.legion', 'session');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'state.json'), `${JSON.stringify({ ...readState(this.repo), ...state }, null, 2)}\n`);
    } catch (err) {
      this.log.warn('could not save session state', err);
    }
  }
}

function readState(repo: string): SavedState {
  try {
    return JSON.parse(readFileSync(join(repo, '.legion', 'session', 'state.json'), 'utf8')) as SavedState;
  } catch {
    return {};
  }
}

/** Keeps run journals, session and team state and local config out of git without asking the user to set anything up. */
function ensureGitignore(repo: string): void {
  const file = join(repo, '.legion', '.gitignore');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    mkdirSync(join(repo, '.legion'), { recursive: true });
    writeFileSync(file, 'runs/\nsession/\nteam/\n*.local.*\n');
    return;
  }
  // Projects from before teams.
  if (!/^team\/$/m.test(text)) writeFileSync(file, `${text.replace(/\n?$/, '\n')}team/\n`);
}

/** `box_status` and `provision_box`: the box agent is the builtin `box` workflow. */
function boxTools(remote: Remote, runs: RunManager, session: () => Session): BoxTools {
  const active = () => runs.activeRuns().find((r) => r.workflow === BOX_WORKFLOW) ?? null;
  return {
    status() {
      const s = session();
      const image = remote.image();
      return {
        remote: s.remoteEnabled ? 'on' : 'off',
        ...(s.remoteProblem() ? { problem: s.remoteProblem() } : {}),
        image: image
          ? {
              snapshot: image.snapshot,
              ...(image.managed
                ? {
                    madeBy: `run ${image.managed.runId}`,
                    at: new Date(image.managed.builtAt).toISOString(),
                    requests: image.managed.requests,
                    summary: image.managed.summary,
                  }
                : { from: '[remote] snapshot in the config' }),
            }
          : 'none yet: boxes start bare',
        waitingRequests: remote.pendingNeeds().map((n) => ({
          what: n.what,
          why: n.why,
          run: n.runId,
          step: n.step,
        })),
        boxAgentRun: active()?.id ?? null,
      };
    },
    async provision(requests, verify) {
      const running = active();
      if (running) return { runId: running.id, started: false, requests: [] };
      const all = [
        ...new Set([...requests, ...remote.pendingNeeds().map((n) => (n.why ? `${n.what} (${n.why})` : n.what))]),
      ];
      const runId = await runs.start(BOX_WORKFLOW, { requests: all, verify });
      remote.clearNeeds();
      return { runId, started: true, requests: all };
    },
  };
}

function notAGitRepo(dir: string): GitOps {
  const fail = async (): Promise<never> => {
    throw new Error(`${dir} is not a git repository: workflows that use git need one`);
  };
  return {
    integration: fail,
    worktree: fail,
    commit: fail,
    squashMerge: fail,
    mergeInto: fail,
    finishMerge: fail,
    diff: fail,
    changedFiles: fail,
    draftPr: fail,
    mergeToBase: fail,
    remove: fail,
    restore: fail,
  };
}
