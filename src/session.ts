/**
 * One Legion session in one directory: the configuration, the account pool, the engines, the
 * workflow runs and the assistant. The TUI and the headless commands both sit on top of this.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Account, AccountPool, accountEnv, legionHomeDir, listAccounts } from './accounts/index.ts';
import { Assistant } from './assistant/assistant.ts';
import { type BoxTools, type McpHandle, startMcpServer } from './assistant/mcp.ts';
import { assistantSystemPrompt, leadSystemPrompt } from './assistant/prompt.ts';
import {
  type Config,
  type ConfigLayer,
  configLayers,
  type Effort,
  ensureProjectConfig,
  expandHome,
  loadConfig,
  mcpServers,
  type RealKind,
  resolveTier,
} from './config.ts';
import { ClaudeEngine } from './engine/claude/index.ts';
import { CodexEngine } from './engine/codex/index.ts';
import { FakeEngine } from './engine/fake/index.ts';
import type { AgentEngine, AgentEvent, EngineAccount, EngineKind } from './engine/types.ts';
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
  /** Where `accounts/` and the pool's state live. Default: `~/.legion` (scripted engines: a project-local dir). */
  legionHome?: string;
  /** Resume the last conversation in this directory (`--continue`). */
  continueLast?: boolean;
  /** Use scripted engines everywhere (demos, tests): `LEGION_FAKE_ENGINES=1`. */
  fake?: boolean;
  /** Remote mode for this session, over `[remote] enabled` (`--remote` / `--local`). */
  remote?: boolean;
}

interface SavedState {
  assistant?: { sessionId: string; account?: string /** before the account pool */; profile?: string; kind: RealKind };
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
  /** Which account each engine kind runs on, and when it is out of quota. */
  readonly accounts: AccountPool;
  readonly legionHome: string;
  /** The account the assistant's conversation is on (kept until it hits a limit). */
  private assistantAccount: string | null;
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
    accounts: AccountPool;
    legionHome: string;
    assistantAccount: string | null;
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
    this.accounts = init.accounts;
    this.legionHome = init.legionHome;
    this.assistantAccount = init.assistantAccount;
    this.fake = init.fake;
    this.remoteOverride = init.remote;
    this.mcp = init.mcp;
    this.runs = init.runs;
    this.team = init.team;
    this.assistant = new Assistant({
      cwd: this.repo,
      engine: () => this.assistantEngine(),
      onLimit: (engine, event) => this.limitReached(engine, event, 'the assistant'),
      systemPrompt: () => assistantSystemPrompt({ repo: this.repo }),
      mcp: { legion: { type: 'http', url: init.mcp.url, headers: { Authorization: `Bearer ${init.mcp.token}` } } },
      model: () => this.assistantModel().model,
      effort: () => this.assistantModel().effort,
      approvals: () => this.config.assistant.approvals,
      sessionId: init.resumeAssistant,
      sessionAccount: init.assistantAccount
        ? { kind: this.assistantModel().engine, name: init.assistantAccount }
        : null,
      log: this.log,
    });
    this.assistant.on('session', ({ id, account }) => {
      this.assistantAccount = account;
      this.save({ assistant: { sessionId: id, account, kind: this.assistantModel().engine as RealKind } });
    });
  }

  /** Prepares a session. */
  static async open(opts: SessionOptions): Promise<Session> {
    const isGitRepo = await isRepo(opts.cwd);
    const repo = isGitRepo ? await toplevel(opts.cwd) : opts.cwd;
    const config = loadConfig(repo, opts.cwd);
    const createdConfig = ensureProjectConfig(repo, opts.cwd, config);
    const log = fileLogger(join(repo, '.legion', 'session', 'legion.log'));
    ensureGitignore(repo);
    // Scripted engines need no accounts: keep demos and tests off the user's real pool.
    const legionHome = opts.legionHome ?? (opts.fake ? join(repo, '.legion', 'session', 'fake-home') : legionHomeDir());
    let resumeAssistant: string | null = null;
    let assistantAccount: string | null = null;
    if (opts.continueLast) {
      const saved = readState(repo).assistant;
      const kind = resolveTier(config.models, 'assistant', config.assistant).engine as RealKind;
      // Saved before the account pool, the account's name was the profile's.
      const account = saved?.account ?? saved?.profile ?? null;
      if (saved && saved.kind === kind && account) {
        resumeAssistant = saved.sessionId;
        assistantAccount = account;
      }
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
      accounts: (kind) => listAccounts(bound().config, kind, { legionHome }),
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
    const accounts = new AccountPool({
      file: join(legionHome, 'accounts', 'pool.json'),
      accounts: (kind) => listAccounts(bound().config, kind, { legionHome }),
    });
    const runs = new RunManager({
      repo,
      engine: (kind, account) => bound().engine(kind, account),
      accounts,
      cooldownMinutes: () => bound().config.accounts.cooldownMinutes,
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
      engine: (kind, req) => bound().acquireEngine(kind, req),
      onLimit: (engine, event) => bound().limitReached(engine, event, 'a lead'),
      mcp: () => mcpServers(bound().config),
      prompt: (lead, role) =>
        leadSystemPrompt({
          repo,
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
      accounts,
      legionHome,
      assistantAccount,
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
   * Re-reads the configuration (after `/config edit`). Engines are rebuilt when their accounts or command changed; runs started
   * from now on get the new workflow settings; the assistant starts over only if its engine, model or account
   * changed. Returns what changed, for the user.
   */
  async reloadConfig(): Promise<string[]> {
    const next = loadConfig(this.repo, this.cwd);
    const prev = this._config;
    const notes: string[] = [];
    const assistantOf = (c: Config) => {
      const r = resolveTier(c.models, 'assistant', c.assistant);
      return { ...c.assistant, ...r };
    };
    const prevAssistant = assistantOf(prev);
    for (const kind of ['claude', 'codex'] as const) {
      const shape = (c: Config) =>
        JSON.stringify([c[kind].command, c[kind].args, listAccounts(c, kind, { legionHome: this.legionHome })]);
      if (shape(next) !== shape(prev)) {
        for (const key of [...this.engines.keys()]) if (key.startsWith(`${kind}:`)) this.engines.delete(key);
      }
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

  /** The accounts of a kind, as configured and discovered right now. */
  listAccounts(kind: RealKind): Account[] {
    return listAccounts(this._config, kind, { legionHome: this.legionHome });
  }

  /** Free / total accounts per kind, e.g. `{ claude: '2/3' }`: a cooling account is not free. */
  accountSummary(): Record<RealKind, string> {
    const one = (kind: RealKind) => {
      const rows = this.accounts.status(kind).filter((r) => r.account.enabled);
      const now = Date.now();
      return `${rows.filter((r) => (r.cooldownUntil ?? 0) <= now).length}/${rows.length}`;
    };
    return { claude: one('claude'), codex: one('codex') };
  }

  /** The engine of a kind on one account of the pool. */
  engine(kind: EngineKind, account = 'default'): AgentEngine {
    if (kind === 'fake') return new FakeEngine();
    const key = `${kind}:${account}`;
    let engine = this.engines.get(key);
    if (!engine) {
      const found = this.listAccounts(kind).find((a) => a.name === account);
      if (!found) throw new Error(`no ${kind} account called "${account}"`);
      engine = this.fake
        ? new FakeEngine(kind, undefined, account)
        : kind === 'claude'
          ? new ClaudeEngine(this.engineAccount(found), { log: this.log })
          : new CodexEngine(this.engineAccount(found), { log: this.log });
      this.engines.set(key, engine);
    }
    return engine;
  }

  /** How to launch an account's CLI. The env is built at every spawn, so a token file is read then and only then. */
  engineAccount(account: Account): EngineAccount {
    const section = this._config[account.kind];
    // Cached engines outlive discovery: resolve the current definition (a token added by /login) at every spawn.
    const current = () => this.listAccounts(account.kind).find((a) => a.name === account.name) ?? account;
    return {
      name: account.name,
      kind: account.kind,
      command: expandHome(section.command ?? account.kind),
      args: section.args,
      get env() {
        return accountEnv(current());
      },
    };
  }

  /**
   * An engine on an account of the pool, for a caller that keeps its account (the assistant, a lead): `prefer`
   * while it is free. Throws when all accounts of the kind are at their limits.
   */
  acquireEngine(kind: RealKind, req: { what: string; prefer: string | null }): AgentEngine {
    const picked = this.accounts.acquire(kind, req);
    if ('exhausted' in picked) throw accountsExhausted(kind, picked.earliestReset);
    return this.engine(kind, picked.account.name);
  }

  private assistantEngine(): AgentEngine {
    const kind = this.assistantModel().engine as RealKind;
    const engine = this.acquireEngine(kind, { what: 'assistant', prefer: this.assistantAccount });
    this.assistantAccount = engine.account.name;
    return engine;
  }

  /** A conversation's account is out of quota: it rests until its reset, the conversation moves on. Returns what to tell. */
  limitReached(engine: AgentEngine, event: Extract<AgentEvent, { type: 'limit_reached' }>, who: string): string {
    const kind = engine.account.kind as RealKind;
    const name = engine.account.name;
    const what = event.kind === 'rate' ? 'rate limit' : 'usage limit';
    const until = event.resetsAt ?? Date.now() + this._config.accounts.cooldownMinutes * 60_000;
    this.accounts.cooldown(kind, name, until, what);
    if (who === 'the assistant' && this.assistantAccount === name) this.assistantAccount = null;
    const time = new Date(until).toTimeString().slice(0, 5);
    this.log.info(`${kind} account "${name}" hit its ${what} until ${time} (${who})`);
    return `${kind} account "${name}" hit its ${what} until ${time}; the next message starts a new conversation on another account.`;
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

function accountsExhausted(kind: string, earliestReset: number | null): Error {
  const when =
    earliestReset === null
      ? 'no reset time is known'
      : `the earliest resets at ${new Date(earliestReset).toTimeString().slice(0, 5)}`;
  return new Error(`all ${kind} accounts are at their limits; ${when}.`);
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
