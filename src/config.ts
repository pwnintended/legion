/**
 * Configuration layers, later ones win: `~/.config/legion/config.toml`, then every `.legion/config.toml` from the
 * outermost parent directory down to the working directory (so a parent folder can hold settings for all the
 * repositories under it), then the project's `.legion/config.local.toml` (gitignored). Every key is optional.
 *
 * ```toml
 * [claude]
 * command = "claude"            # the binary and extra arguments of every account
 * args    = []
 *
 * [accounts]
 * cooldownMinutes = 60          # cooldown after a limit when the CLI gave no reset time
 *
 * [accounts.claude.work]        # also found: every directory ~/.legion/accounts/<kind>/<name>
 * dir      = "~/.claude-work"   # CLAUDE_CONFIG_DIR; omitted: the CLI's own login
 * tokenEnv = "CLAUDE_WORK_TOKEN" # a `claude setup-token` token (tokenFile = "…" reads a file instead)
 *
 * [accounts.codex.personal]
 * dir = "~/.codex-personal"     # CODEX_HOME holding auth.json
 *
 * [assistant]
 * engine = "claude"             # the engine you talk to (in mixed mode)
 * approvals = "auto"            # its tool approvals: auto (allowed) | ask (you)
 *
 * [models]
 * provider = "mixed"            # claude | codex: everything runs there | mixed: as settings and code say
 *
 * [models.claude.medium]        # tiers: assistant, lead, hard, medium, easy
 * model = "sonnet"
 *
 * [workflows]
 * approvals = "auto"            # agents' tool approvals: auto (Claude auto mode, Codex bypass) | ask (you)
 * maxAgents = 4                 # agent sessions alive at once per run
 * maxAgentsTotal = 6            # across all runs
 *
 * [worktrees]
 * clone = ["target", "game/.godot"]   # build caches cloned into new worktrees (default: found automatically)
 * ```
 *
 * Without any account for a kind, there is one called `default` that runs the plain binary (`claude`, `codex`)
 * with the user's own login. Legion picks an account for each agent session from the pool (`accounts/`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import type { McpServer } from './engine/types.ts';
import { configHome } from './workflow/loader.ts';

/** Env an account must not set: they would route the CLI around its own login (proxy, or a token Legion manages). */
export const FORBIDDEN_ACCOUNT_ENV = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/** One `[accounts.<kind>.<name>]` table. Every field is optional: it overrides a discovered account field by field. */
const AccountSchema = z.object({
  /** CLAUDE_CONFIG_DIR / CODEX_HOME. Omitted: the CLI's default login. */
  dir: z.string().min(1).optional(),
  /** Env var holding a `claude setup-token` token (becomes CLAUDE_CODE_OAUTH_TOKEN for that account's CLI). */
  tokenEnv: z.string().min(1).optional(),
  /** File whose first line is such a token: the alternative to `tokenEnv`. */
  tokenFile: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  /** Usable in boxes. Default: claude when it has a token, codex never. */
  remote: z.boolean().optional(),
  env: z
    .record(z.string(), z.string())
    .default({})
    .superRefine((env, ctx) => {
      for (const key of FORBIDDEN_ACCOUNT_ENV) {
        if (key in env) ctx.addIssue({ code: 'custom', message: `${key} may not be set here` });
      }
    }),
});
export type AccountConfig = z.infer<typeof AccountSchema>;

const AccountsSchema = z.object({
  /** How long an account rests after hitting a limit when the CLI named no reset time. */
  cooldownMinutes: z.number().min(1).default(60),
  claude: z.record(z.string(), AccountSchema).default({}),
  codex: z.record(z.string(), AccountSchema).default({}),
});

const KindSchema = z.object({
  /** The binary of every account of this kind (default: the kind's name). */
  command: z.string().min(1).optional(),
  /** Extra arguments for every account's CLI. */
  args: z.array(z.string()).default([]),
  /** Extra model names for the pickers (Codex lists its own; Claude's list is built in). */
  models: z.array(z.string().min(1)).default([]),
});

const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

const ModelSchema = z.object({ model: z.string().min(1).optional(), effort: EffortSchema.optional() });
export type ModelSetting = z.infer<typeof ModelSchema>;

/**
 * What a model is for. `assistant` is the orchestrator you talk to, `lead` every team lead; workflow agent steps are
 * `hard`, `medium` (the default) or `easy`. Each provider says which model and effort a tier means (`[models]`).
 */
export const TIERS = ['assistant', 'lead', 'hard', 'medium', 'easy'] as const;
export const StepTierSchema = z.enum(['hard', 'medium', 'easy']);
export type Tier = (typeof TIERS)[number];
export type StepTier = z.infer<typeof StepTierSchema>;

/** A provider's tiers. A tier's table overrides its defaults field by field (`model` alone keeps the effort). */
const ProviderTiersSchema = (defaults: Record<Tier, ModelSetting>) =>
  z.object(
    Object.fromEntries(
      TIERS.map((t) => [
        t,
        z.preprocess(
          (v) => (v === undefined ? defaults[t] : isPlainObject(v) ? { ...defaults[t], ...v } : v),
          ModelSchema,
        ),
      ]),
    ) as unknown as Record<Tier, z.ZodType<ModelSetting>>,
  );

/** Claude's aliases follow the newest model of each family. Codex picks its own model unless one is set. */
const CLAUDE_TIERS: Record<Tier, ModelSetting> = {
  assistant: { model: 'opus' },
  lead: { model: 'opus' },
  hard: { model: 'opus', effort: 'high' },
  medium: { model: 'sonnet' },
  easy: { model: 'haiku' },
};
const CODEX_TIERS: Record<Tier, ModelSetting> = {
  assistant: { effort: 'high' },
  lead: { effort: 'high' },
  hard: { effort: 'high' },
  medium: { effort: 'medium' },
  easy: { effort: 'low' },
};

export const PROVIDERS = ['claude', 'codex', 'mixed'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * `[models]`: the provider everything runs on, and what each tier means on each. `claude` or `codex` moves every
 * agent, lead and the assistant onto that engine (when one runs out of limits); `mixed` keeps the engines that the
 * settings and the workflows' code choose.
 */
const ModelsSchema = z.object({
  provider: z.enum(PROVIDERS).default('mixed'),
  claude: ProviderTiersSchema(CLAUDE_TIERS).prefault(CLAUDE_TIERS),
  codex: ProviderTiersSchema(CODEX_TIERS).prefault(CODEX_TIERS),
});
export type ModelsConfig = z.infer<typeof ModelsSchema>;
export const DEFAULT_MODELS: ModelsConfig = ModelsSchema.parse({});

/** `[workflow.<name>]`: the tiers of one workflow's agents (`"*"`: every workflow). */
const WorkflowModelsSchema = z.object({
  /** The tier of the workflow's agent steps whose code and step setting name none. */
  tier: StepTierSchema.optional(),
  /**
   * By agent key (the first argument of `agent()`): its tier, and (rarely needed) an engine, model or effort over
   * the tier's. `engine` moves the step to the other engine in `mixed` mode.
   */
  agent: z
    .record(
      z.string(),
      ModelSchema.extend({ engine: z.enum(['claude', 'codex']).optional(), tier: StepTierSchema.optional() }),
    )
    .default({}),
});
export type WorkflowModels = z.infer<typeof WorkflowModelsSchema>;

/** An MCP server every lead and workflow agent gets: a command (stdio) or a URL (http). */
const McpServerSchema = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).default({}) }),
]);

/** `[remote]`: run workflow agents and `sh` steps on Upstash Boxes (`remote/`). */
const RemoteSchema = z.object({
  /** Off by default; `legion --remote` / `--local` and `/remote on|off` override it for a session. */
  enabled: z.boolean().default(false),
  /**
   * The Upstash Box API key. Only in the user config or `.legion/config.local.toml`, never a committed file;
   * `UPSTASH_BOX_API_KEY` wins over it.
   */
  apiKey: z.string().min(1).optional(),
  /** Snapshot id new boxes start from (CLIs, toolchain and a warm clone already in place). Unset: a fresh box. */
  snapshot: z.string().min(1).optional(),
  /** Where the snapshot's warm clone of this repository is: it becomes the box's worktree, build caches included. */
  clone: z.string().min(1).optional(),
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  /**
   * Hours until Upstash deletes a box by itself (at most 72), so boxes are never left behind: by a run that was
   * interrupted and never resumed, or a crash. Legion deletes a run's boxes when it ends, well before that.
   */
  ttlHours: z.number().int().min(1).max(72).default(24),
  /** Runtime of a fresh box (no snapshot). */
  runtime: z
    .enum(['node', 'python', 'golang', 'ruby', 'rust', 'node-alpine', 'python-alpine', 'golang-alpine', 'ruby-alpine'])
    .default('node'),
  /**
   * Shell code run (in the worktree root) before every command in a box, e.g. `source tools/box/env.sh` for the
   * toolchain's PATH. Its output goes to stderr.
   */
  prelude: z.string().min(1).optional(),
  /** Shell commands run once in each new box, in its worktree, after the first sync (e.g. `pnpm install`). */
  setup: z.array(z.string().min(1)).default([]),
});
export type RemoteConfig = z.infer<typeof RemoteSchema>;

export const ConfigSchema = z.object({
  claude: KindSchema.prefault({}),
  codex: KindSchema.prefault({}),
  accounts: AccountsSchema.prefault({}),
  assistant: z
    .object({
      engine: z.enum(['claude', 'codex']).default('claude'),
      model: z.string().optional(),
      effort: EffortSchema.optional(),
      /** Its own tool approvals: allowed (Claude's auto mode, Codex without sandbox or approvals), or asked. */
      approvals: z.enum(['ask', 'auto']).default('auto'),
    })
    .default({ engine: 'claude', approvals: 'auto' }),
  workflows: z
    .object({
      /** Agents' tool approvals: allowed (Claude's auto mode, Codex without sandbox or approvals), or asked. */
      approvals: z.enum(['ask', 'auto']).default('auto'),
      maxAgents: z.number().int().min(1).max(32).default(4),
      /** Agent sessions alive at once across all runs (leads' included); more wait for a free slot. */
      maxAgentsTotal: z.number().int().min(1).max(128).default(6),
      /** Runs that Legion's exit (or a crash) interrupted continue when the next session starts. */
      resumeOnStart: z.boolean().default(true),
    })
    .default({ approvals: 'auto', maxAgents: 4, maxAgentsTotal: 6, resumeOnStart: true }),
  worktrees: z
    .object({
      /**
       * Untracked build caches copied into every new worktree from the user's checkout, as copy-on-write clones
       * (instant, no extra disk until changed): e.g. `["target", "game/.godot", "node_modules"]`. Unset: found
       * automatically (`target`, `node_modules`, `.venv` and `.godot` directories git ignores, two levels deep).
       */
      clone: z.array(z.string().min(1)).nullable().default(null),
      /** Shell commands run in every new worktree after cloning (through bash, in the worktree). */
      setup: z.array(z.string().min(1)).default([]),
      /** Below this much free disk (GB), no new worktree is created: the step fails with a clear message. */
      minFreeGb: z.number().min(0).default(10),
    })
    .default({ clone: null, setup: [], minFreeGb: 10 }),
  models: ModelsSchema.prefault({}),
  workflow: z.record(z.string(), WorkflowModelsSchema).default({}),
  /** `[mcp.servers.<name>]`: given to every lead and every workflow agent, on both engines. */
  mcp: z.object({ servers: z.record(z.string(), McpServerSchema).default({}) }).default({ servers: {} }),
  team: z
    .object({
      /** Levels of leads under the orchestrator. */
      maxDepth: z.number().int().min(1).max(6).default(3),
      /**
       * Who answers the gates, questions and tool approvals of the orchestrator's own runs: the user (`ask`), or
       * the orchestrator (`decide`), which escalates only what it cannot settle.
       */
      gates: z.enum(['ask', 'decide']).default('ask'),
      /** Leads alive (with a session) at once, across the team. */
      maxLeads: z.number().int().min(1).max(64).default(12),
    })
    .default({ maxDepth: 3, maxLeads: 12, gates: 'ask' }),
  remote: RemoteSchema.default({ enabled: false, size: 'medium', ttlHours: 24, runtime: 'node', setup: [] }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RealKind = 'claude' | 'codex';

export class ConfigError extends Error {}

export function userConfigPath(): string {
  return join(configHome(), 'config.toml');
}

/**
 * Engine profiles were replaced by the account pool. Converts a parsed config document: each `[<kind>.profiles.<name>]`
 * becomes `[accounts.<kind>.<name>]` (same name, so old run journals map onto it) with `dir` from its env
 * CLAUDE_CONFIG_DIR / CODEX_HOME and the other env kept; `command` and `args` move to `[<kind>]`; `default` and
 * `setup` are dropped. `notes` is empty when the document has no profiles (nothing changed).
 */
export function migrateProfiles(doc: Record<string, unknown>): { doc: Record<string, unknown>; notes: string[] } {
  const out = structuredClone(doc);
  const notes: string[] = [];
  const accounts: Record<string, unknown> = isPlainObject(out.accounts) ? out.accounts : {};
  for (const kind of ['claude', 'codex'] as const) {
    const section = out[kind];
    if (!isPlainObject(section) || !('profiles' in section || 'default' in section)) continue;
    const before = notes.length;
    const { profiles, default: chosen, ...rest } = section;
    const dirVar = kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const table: Record<string, unknown> = isPlainObject(accounts[kind]) ? accounts[kind] : {};
    let command: unknown;
    let args: unknown;
    for (const [name, raw] of Object.entries(isPlainObject(profiles) ? profiles : {})) {
      const profile = isPlainObject(raw) ? raw : {};
      const { [dirVar]: dir, ...allEnv } = isPlainObject(profile.env) ? profile.env : {};
      // These keys are refused in an account's env; their values (a token, say) are never copied or shown.
      const env = Object.fromEntries(
        Object.entries(allEnv).filter(([k]) => !FORBIDDEN_ACCOUNT_ENV.some((f) => f === k)),
      );
      for (const key of FORBIDDEN_ACCOUNT_ENV.filter((f) => f in allEnv)) {
        notes.push(
          key === 'CLAUDE_CODE_OAUTH_TOKEN'
            ? `${kind} profile "${name}": its ${key} was dropped; keep the token in an environment variable or a file (mode 600) and set tokenEnv or tokenFile on the account`
            : `${kind} profile "${name}": its ${key} was dropped (accounts may not redirect the CLI)`,
        );
      }
      table[name] = {
        ...(typeof dir === 'string' ? { dir } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
      notes.push(`${kind} profile "${name}" → [accounts.${kind}.${name}]`);
      if (profile.command !== undefined || (Array.isArray(profile.args) && profile.args.length > 0)) {
        if (command === undefined && args === undefined) {
          command = profile.command;
          args = profile.args;
          notes.push(`${kind} profile "${name}": command and args → [${kind}] (shared by all ${kind} accounts)`);
        } else {
          notes.push(`${kind} profile "${name}": its command/args differ from another profile's and were dropped`);
        }
      }
      if (profile.setup !== undefined) {
        notes.push(`${kind} profile "${name}": setup was dropped (accounts have no setup command)`);
      }
    }
    if (chosen !== undefined) {
      notes.push(`${kind} default "${String(chosen)}" was dropped (Legion picks an account for every session)`);
    }
    if (Object.keys(table).length > 0) accounts[kind] = table;
    out[kind] = {
      ...rest,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
    };
    if (notes.length === before) notes.push(`${kind}: removed an empty profile setting`);
  }
  if (notes.length > 0) out.accounts = accounts;
  return { doc: out, notes };
}

/** Env values may be secrets: the message shows their names only. */
function redactEnv(accounts: unknown): unknown {
  if (!isPlainObject(accounts)) return accounts;
  return Object.fromEntries(
    Object.entries(accounts).map(([kind, table]) => [
      kind,
      isPlainObject(table)
        ? Object.fromEntries(
            Object.entries(table).map(([name, a]) => [
              name,
              isPlainObject(a) && isPlainObject(a.env)
                ? { ...a, env: Object.fromEntries(Object.keys(a.env).map((k) => [k, '<kept>'])) }
                : a,
            ]),
          )
        : table,
    ]),
  );
}

function profilesRemovedMessage(path: string, migrated: Record<string, unknown>, notes: string[]): string {
  const shown: Record<string, unknown> = { accounts: redactEnv(migrated.accounts) };
  for (const kind of ['claude', 'codex']) {
    const section = migrated[kind];
    if (isPlainObject(section) && ('command' in section || 'args' in section)) {
      shown[kind] = { command: section.command, args: section.args };
    }
  }
  return [
    `${path}: engine profiles ([claude.profiles.*], [codex.profiles.*], default, setup) are gone: Legion keeps a pool of accounts and picks one for every agent.`,
    ...notes.map((n) => `  - ${n}`),
    'The equivalent configuration:',
    '',
    stringify(JSON.parse(JSON.stringify(shown))).trimEnd(),
    '',
    '`legion accounts migrate` rewrites your user config this way (keeping a .bak).',
  ].join('\n');
}

export function readToml(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for config layers: objects merge, everything else is replaced. */
export function mergeLayers(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeLayers(prev, v) : v;
  }
  return out;
}

export interface ConfigLayer {
  path: string;
  scope: 'user' | 'project' | 'parent' | 'local';
  exists: boolean;
}

/**
 * Every `.legion/config.toml` from the filesystem root down to `cwd`, outermost first. `~/.legion` is Legion's
 * own state directory, not a project, so the home directory is skipped.
 */
export function projectConfigFiles(cwd: string): string[] {
  const found: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, '.legion', 'config.toml');
    if (dir !== homedir() && existsSync(file)) found.unshift(file);
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** The files `loadConfig` reads, in order, including the ones that do not exist (yet). */
export function configLayers(repo: string, cwd: string = repo): ConfigLayer[] {
  const own = join(repo, '.legion', 'config.toml');
  const found = projectConfigFiles(cwd);
  const project = found.includes(own) ? found : [...found, own];
  const local = join(repo, '.legion', 'config.local.toml');
  return [
    { path: userConfigPath(), scope: 'user' as const, exists: existsSync(userConfigPath()) },
    ...project.map((path) => ({
      path,
      scope: path === own ? ('project' as const) : ('parent' as const),
      exists: existsSync(path),
    })),
    { path: local, scope: 'local' as const, exists: existsSync(local) },
  ];
}

export function loadConfig(repo: string, cwd: string = repo): Config {
  const layers = configLayers(repo, cwd).filter((layer) => layer.exists);
  const docs = layers.map((layer) => ({ layer, doc: readToml(layer.path) }));
  // A secret in a file that is (or may be) committed would be pushed with it.
  for (const { layer, doc } of docs) {
    const remote = doc.remote;
    if ((layer.scope === 'project' || layer.scope === 'parent') && isPlainObject(remote) && 'apiKey' in remote) {
      throw new ConfigError(
        `${layer.path} sets [remote] apiKey: move it to ${userConfigPath()} or .legion/config.local.toml (not committed)`,
      );
    }
  }
  for (const { layer, doc } of docs) {
    const { notes, doc: migrated } = migrateProfiles(doc);
    if (notes.length > 0) throw new ConfigError(profilesRemovedMessage(layer.path, migrated, notes));
  }
  const merged = docs.reduce<Record<string, unknown>>((acc, { doc }) => mergeLayers(acc, doc), {});
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Writes a commented `.legion/config.toml` at the project root when no project config exists in `cwd` or any
 * directory above it. The active values are the ones in effect now (from the user config or the defaults), so
 * creating the file changes nothing; profiles stay in the user config, since they are per machine.
 * Returns the path written, or null.
 */
export function ensureProjectConfig(repo: string, cwd: string, config: Config): string | null {
  if (projectConfigFiles(cwd).length > 0) return null;
  const file = join(repo, '.legion', 'config.toml');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, defaultProjectConfig(config), { flag: 'wx' });
    return file;
  } catch {
    return null;
  }
}

export function defaultProjectConfig(config: Config): string {
  const { assistant, workflows, team } = config;
  const line = (key: string, value: string | number, comment: string, on = true) =>
    `${on ? '' : '# '}${`${key.padEnd(9)} = ${typeof value === 'string' ? JSON.stringify(value) : value}`.padEnd(on ? 30 : 28)} # ${comment}`;
  return [
    `# Legion project configuration. It overlays ${userConfigPath().replace(homedir(), '~')}`,
    '# and is overlaid by .legion/config.local.toml (gitignored: put machine-specific settings there).',
    '# Every key is optional. In a session, /config shows what is in effect and /config edit opens this file.',
    '',
    '[assistant]',
    line('engine', assistant.engine, 'the engine you talk to: claude | codex'),
    line(
      'model',
      assistant.model ?? 'opus',
      "pins the assistant's model (default: the assistant tier's)",
      !!assistant.model,
    ),
    line('effort', assistant.effort ?? 'high', 'low | medium | high | xhigh | max', !!assistant.effort),
    line('approvals', assistant.approvals, 'its tool approvals: auto (allowed) | ask (you)'),
    '',
    '# Models come from tiers: the assistant, leads, and hard / medium / easy workflow steps. Each provider says',
    '# what a tier means; /provider claude|openai|mixed moves everything onto one (saved in config.local.toml).',
    '# The defaults, which a table here overrides field by field:',
    '#',
    '# [models.claude.assistant]   model = "opus"',
    '# [models.claude.lead]        model = "opus"',
    '# [models.claude.hard]        model = "opus", effort = "high"',
    '# [models.claude.medium]      model = "sonnet"',
    '# [models.claude.easy]        model = "haiku"',
    "# [models.codex.<tier>]       the CLI's model; effort high, high, high, medium, low",
    '#',
    "# A workflow step's tier: agent(key, { tier }) in its code, or set it from the /workflows menu.",
    '',
    '[workflows]',
    line('approvals', workflows.approvals, "agents' tool approvals: auto (allowed) | ask (you)"),
    line('maxAgents', workflows.maxAgents, 'agent sessions alive at once per run'),
    line('maxAgentsTotal', workflows.maxAgentsTotal, 'agent sessions alive at once across all runs'),
    '',
    '# New worktrees get copy-on-write clones of build caches from your checkout (found automatically:',
    '# target, node_modules, .venv, .godot). List them to choose, and add setup commands if needed:',
    '#',
    '# [worktrees]',
    '# clone     = ["target", "game/.godot"]',
    '# setup     = ["just ext"]',
    '# minFreeGb = 10',
    '',
    '[team]',
    line('gates', team.gates, "your runs' gates: ask (you) | decide (the assistant, escalating what it can't)"),
    line('maxDepth', team.maxDepth, 'levels of team leads under the assistant'),
    line('maxLeads', team.maxLeads, 'lead sessions alive at once (idle ones close, and resume later)'),
    '',
    '# Remote mode: workflow steps in run worktrees run on Upstash Boxes, one box per worktree (legion --remote,',
    '# /remote on). The API key goes in the user config or config.local.toml, never here:',
    '#',
    '# [remote]',
    '# enabled  = true',
    '# snapshot = "snap_…"                  # boxes start from it: CLIs, toolchain, a warm clone',
    '# clone    = "/workspace/home/repo"    # where that warm clone is in the snapshot',
    '# prelude  = "source tools/box/env.sh" # before every command in a box (PATH and the like)',
    '# size     = "medium"                  # small | medium | large: 2, 4 or 8 CPUs',
    '# ttlHours = 24                        # Upstash deletes a box after this, even one Legion left behind (max 72)',
    '',
    "# MCP servers for workflow agents and leads (they do not load your own CLI's), e.g.:",
    '#',
    '# [mcp.servers.blender]',
    '# command = "uvx"',
    '# args    = ["blender-mcp"]',
    '',
    '# Accounts: Legion picks one from a pool for every agent session and moves on when one hits its limit.',
    '# Log in with `legion login claude|codex [name]` (or /login): that creates ~/.legion/accounts/<kind>/<name>.',
    '# Accounts of your own (per machine, so usually in the user config):',
    '#',
    '# [accounts.claude.work]',
    '# dir      = "~/.claude-work"          # CLAUDE_CONFIG_DIR',
    '# tokenEnv = "CLAUDE_WORK_TOKEN"       # optional: a `claude setup-token` token, for boxes',
    '#',
    '# [accounts.codex.personal]',
    '# dir = "~/.codex-personal"            # CODEX_HOME holding auth.json',
    '',
  ].join('\n');
}

/** The engine something runs on: the provider's when one is chosen, else its own (`mixed`). */
export function providerEngine(models: ModelsConfig, own: string): string {
  return models.provider === 'mixed' || (own !== 'claude' && own !== 'codex') ? own : models.provider;
}

/**
 * The engine, model and effort of something on a tier (the assistant, a lead) that names its own engine and
 * maybe a model: the provider decides the engine; its own model and effort apply only on its own engine (they are
 * that engine's names), else the tier's.
 */
export function resolveTier(
  models: ModelsConfig,
  tier: Tier,
  own: { engine: string; model?: string | null; effort?: Effort | null },
): { engine: string; model: string | null; effort: Effort | null } {
  const engine = providerEngine(models, own.engine);
  const mine = engine === own.engine;
  const setting = engine === 'claude' || engine === 'codex' ? models[engine][tier] : undefined;
  return {
    engine,
    model: (mine ? own.model : null) ?? setting?.model ?? null,
    effort: (mine ? own.effort : null) ?? setting?.effort ?? null,
  };
}

export type ModelOrigin = 'agent' | 'code' | 'tier' | 'default';
export type TierOrigin = 'agent' | 'code' | 'workflow' | 'all' | 'default';

/**
 * The engine, tier, model and effort an agent step runs with.
 * Tier: the step setting (`[workflow.<name>.agent.<key>] tier`, then the `"*"` one), the code's
 * (`agent(key, { tier })`), the workflow's (`[workflow.<name>] tier`, then `"*"`), else `medium`.
 * Engine: the provider's (`[models] provider`), or in `mixed` the step setting's, else the code's.
 * Model and effort, each on its own, first match wins:
 * 1. the step setting: the user picked this step's model;
 * 2. the workflow's code (`agent(key, { model })`): its author chose deliberately;
 * 3. the tier's on the engine (`[models.<engine>.<tier>]`);
 * 4. nothing: the CLI's own default.
 * A model belongs to one engine, so 1 and 2 apply only when the step runs on the engine they were meant for.
 */
export function resolveAgentModel(
  config: Pick<Config, 'workflow' | 'models'>,
  req: {
    workflow: string;
    key: string;
    engine: string;
    tier?: StepTier | null;
    model: string | null;
    effort: Effort | null;
  },
): {
  engine: string;
  tier: StepTier;
  model: string | null;
  effort: Effort | null;
  origin: { engine: 'agent' | 'code' | 'provider'; tier: TierOrigin; model: ModelOrigin; effort: ModelOrigin };
} {
  const settings = config.workflow;
  const own = settings[req.workflow];
  const all = settings['*'];
  const step = { ...all?.agent[req.key], ...own?.agent[req.key] };
  const tiers: [StepTier | null | undefined, TierOrigin][] = [
    [step.tier, 'agent'],
    [req.tier, 'code'],
    [own?.tier, 'workflow'],
    [all?.tier, 'all'],
  ];
  const [tier, tierOrigin] = tiers.find(([t]) => t) ?? ['medium', 'default'];
  const wanted = step.engine ?? req.engine;
  const engine = providerEngine(config.models, wanted);
  const setting = engine === 'claude' || engine === 'codex' ? config.models[engine][tier as StepTier] : undefined;
  const pick = <K extends 'model' | 'effort'>(field: K, code: ModelSetting[K] | null) => {
    const candidates: [ModelSetting[K] | null | undefined, ModelOrigin][] = [
      [engine === wanted ? step[field] : undefined, 'agent'],
      [engine === req.engine ? code : undefined, 'code'],
      [setting?.[field], 'tier'],
    ];
    const hit = candidates.find(([v]) => v !== undefined && v !== null);
    return hit ? ([hit[0] as ModelSetting[K], hit[1]] as const) : ([null, 'default'] as const);
  };
  const [model, modelOrigin] = pick('model', req.model);
  const [effort, effortOrigin] = pick('effort', req.effort);
  return {
    engine,
    tier: tier as StepTier,
    model: model ?? null,
    effort: effort ?? null,
    origin: {
      engine: engine !== wanted ? 'provider' : step.engine !== undefined ? 'agent' : 'code',
      tier: tierOrigin,
      model: modelOrigin,
      effort: effortOrigin,
    },
  };
}

/** The configured MCP servers in the engines' shape, `~` expanded. Names starting with `legion` are reserved. */
export function mcpServers(config: Config): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  for (const [name, s] of Object.entries(config.mcp.servers)) {
    if (name.startsWith('legion')) continue;
    out[name] =
      'url' in s
        ? { type: 'http', url: s.url, headers: s.headers }
        : {
            type: 'stdio',
            command: expandHome(s.command),
            args: s.args.map(expandHome),
            env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expandHome(v)])),
          };
  }
  return out;
}

export function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}
