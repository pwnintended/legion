/**
 * One Legion session in one directory: the configuration, the engine profile in use per kind, the engines, the
 * workflow runs and the assistant. The TUI and the headless commands both sit on top of this.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Assistant } from './assistant/assistant.ts';
import { type McpHandle, startMcpServer } from './assistant/mcp.ts';
import { assistantSystemPrompt } from './assistant/prompt.ts';
import {
  type Config,
  loadConfig,
  profileNames,
  type RealKind,
  type ResolvedProfile,
  resolveProfile,
} from './config.ts';
import { ClaudeEngine } from './engine/claude/index.ts';
import { CodexEngine } from './engine/codex/index.ts';
import { FakeEngine } from './engine/fake/index.ts';
import type { AgentEngine, EngineKind } from './engine/types.ts';
import { isRepo, toplevel } from './git/index.ts';
import { fileLogger, type Logger } from './util/log.ts';
import { createGitOps } from './workflow/git-ops.ts';
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
}

interface SavedState {
  assistant?: { sessionId: string; profile: string; kind: RealKind };
}

export class Session {
  readonly repo: string;
  readonly isGitRepo: boolean;
  readonly config: Config;
  readonly log: Logger;
  readonly runs: RunManager;
  readonly assistant: Assistant;
  private readonly profiles: Record<RealKind, ResolvedProfile>;
  private readonly engines = new Map<string, AgentEngine>();
  private readonly fake: boolean;
  private mcp: McpHandle | null = null;

  private constructor(init: {
    repo: string;
    isGitRepo: boolean;
    config: Config;
    log: Logger;
    profiles: Record<RealKind, ResolvedProfile>;
    runs: RunManager;
    mcp: McpHandle;
    resumeAssistant: string | null;
    fake: boolean;
  }) {
    this.repo = init.repo;
    this.isGitRepo = init.isGitRepo;
    this.config = init.config;
    this.log = init.log;
    this.profiles = init.profiles;
    this.fake = init.fake;
    this.mcp = init.mcp;
    this.runs = init.runs;
    this.assistant = new Assistant({
      cwd: this.repo,
      engine: () => this.engine(this.config.assistant.engine),
      systemPrompt: () => assistantSystemPrompt({ repo: this.repo, profiles: this.profileNames() }),
      mcp: { legion: { type: 'http', url: init.mcp.url, headers: { Authorization: `Bearer ${init.mcp.token}` } } },
      model: this.config.assistant.model ?? null,
      effort: this.config.assistant.effort ?? null,
      sessionId: init.resumeAssistant,
      log: this.log,
    });
    this.assistant.on('session', ({ id, profile }) =>
      this.save({ assistant: { sessionId: id, profile, kind: this.config.assistant.engine } }),
    );
  }

  /**
   * Prepares a session. Profile `setup` commands are not run here: the caller runs them first (`runSetup`)
   * while it still owns the terminal.
   */
  static async open(opts: SessionOptions): Promise<Session> {
    const isGitRepo = await isRepo(opts.cwd);
    const repo = isGitRepo ? await toplevel(opts.cwd) : opts.cwd;
    const config = loadConfig(repo);
    const log = fileLogger(join(repo, '.legion', 'session', 'legion.log'));
    const profiles = {
      claude: resolveProfile(config, 'claude', opts.profiles?.claude),
      codex: resolveProfile(config, 'codex', opts.profiles?.codex),
    };
    ensureGitignore(repo);
    let resumeAssistant: string | null = null;
    if (opts.continueLast) {
      const saved = readState(repo).assistant;
      const kind = config.assistant.engine;
      if (saved && saved.kind === kind && saved.profile === profiles[kind].name) resumeAssistant = saved.sessionId;
    }
    const git = isGitRepo ? await createGitOps({ repo }) : notAGitRepo(repo);
    // Runs ask the session for engines, and the session needs the runs' MCP server: bind late.
    const self: { session?: Session } = {};
    const bound = () => {
      if (!self.session) throw new Error('session not ready');
      return self.session;
    };
    const runs = new RunManager({
      repo,
      engine: (kind) => bound().engine(kind),
      profiles: () => bound().profileNames(),
      git,
      maxAgents: config.workflows.maxAgents,
      approvals: config.workflows.approvals,
      log,
    });
    const mcp = await startMcpServer({ repo, runs, log });
    self.session = new Session({
      repo,
      isGitRepo,
      config,
      log,
      profiles,
      runs,
      mcp,
      resumeAssistant,
      fake: opts.fake ?? false,
    });
    return self.session;
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
    if (this.config.assistant.engine === kind) await this.assistant.restart();
    return { setupOutput };
  }

  async close(): Promise<void> {
    await this.assistant.close();
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

/** Keeps run journals, session state and local config out of git without asking the user to set anything up. */
function ensureGitignore(repo: string): void {
  const file = join(repo, '.legion', '.gitignore');
  try {
    readFileSync(file);
  } catch {
    mkdirSync(join(repo, '.legion'), { recursive: true });
    writeFileSync(file, 'runs/\nsession/\n*.local.*\n');
  }
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
