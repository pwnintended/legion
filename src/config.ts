/**
 * Configuration layers, later ones win: `~/.config/legion/config.toml`, then every `.legion/config.toml` from the
 * outermost parent directory down to the working directory (so a parent folder can hold settings for all the
 * repositories under it), then the project's `.legion/config.local.toml` (gitignored). Every key is optional.
 *
 * ```toml
 * [claude]
 * default = "claude-1"          # profile used when the session starts (override: legion --claude claude-2)
 *
 * [claude.profiles.claude-1]
 * setup   = "claude-share check" # runs once, through your shell, when the session starts
 * command = "claude"
 * env     = { CLAUDE_CONFIG_DIR = "~/.claude-1" }
 *
 * [codex.profiles.default]
 * command = "codex"
 *
 * [assistant]
 * engine = "claude"             # the engine you talk to
 * model  = "opus"
 * approvals = "auto"            # its tool approvals: auto (allowed) | ask (you)
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
 * Without any profile for a kind, there is one called `default` that runs the plain binary (`claude`, `codex`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import type { EngineProfile, McpServer } from './engine/types.ts';
import { configHome } from './workflow/loader.ts';

const ProfileSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  setup: z.string().optional(),
});

const KindSchema = z.object({
  default: z.string().optional(),
  /** Extra model names for the pickers (Codex lists its own; Claude's list is built in). */
  models: z.array(z.string().min(1)).default([]),
  profiles: z.record(z.string(), ProfileSchema).default({}),
});

const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

const ModelSchema = z.object({ model: z.string().min(1).optional(), effort: EffortSchema.optional() });
export type ModelSetting = z.infer<typeof ModelSchema>;

/** `[workflow.<name>]`: models for one workflow's agents (`"*"`: every workflow). */
const WorkflowModelsSchema = z.object({
  claude: ModelSchema.optional(),
  codex: ModelSchema.optional(),
  /** By agent key (the first argument of `agent()`); `engine` moves the step to the other engine. */
  agent: z.record(z.string(), ModelSchema.extend({ engine: z.enum(['claude', 'codex']).optional() })).default({}),
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

export const ConfigSchema = z.object({
  claude: KindSchema.default({ profiles: {}, models: [] }),
  codex: KindSchema.default({ profiles: {}, models: [] }),
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
});

export type Config = z.infer<typeof ConfigSchema>;
export type RealKind = 'claude' | 'codex';

export interface ResolvedProfile extends EngineProfile {
  setup: string | null;
}

export class ConfigError extends Error {}

export function userConfigPath(): string {
  return join(configHome(), 'config.toml');
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
  const merged = configLayers(repo, cwd).reduce<Record<string, unknown>>(
    (acc, layer) => (layer.exists ? mergeLayers(acc, readToml(layer.path)) : acc),
    {},
  );
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
    line('model', assistant.model ?? 'opus', "the assistant's model (default: the CLI's)", !!assistant.model),
    line('effort', assistant.effort ?? 'high', 'low | medium | high | xhigh | max', !!assistant.effort),
    line('approvals', assistant.approvals, 'its tool approvals: auto (allowed) | ask (you)'),
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
    "# MCP servers for workflow agents and leads (they do not load your own CLI's), e.g.:",
    '#',
    '# [mcp.servers.blender]',
    '# command = "uvx"',
    '# args    = ["blender-mcp"]',
    '',
    '# Engine profiles say which account or binary "claude" and "codex" mean. They are per machine, so they',
    '# usually live in the user config; pick one per session with /claude <profile> or legion --claude <profile>.',
    '#',
    '# [claude]',
    '# default = "claude-1"',
    '#',
    '# [claude.profiles.claude-1]',
    '# setup   = "claude-share check"     # runs once per session, through your shell',
    '# command = "claude"',
    '# env     = { CLAUDE_CONFIG_DIR = "~/.claude-1" }',
    '#',
    '# [codex.profiles.default]',
    '# command = "codex"                  # env = { CODEX_HOME = "..." } for another account',
    '',
  ].join('\n');
}

export type ModelOrigin = 'agent' | 'code' | 'workflow' | 'all' | 'default';

/**
 * The engine, model and effort an agent step runs with.
 * Engine: the step setting (`[workflow.<name>.agent.<key>] engine`, then the `"*"` one), else the code's.
 * Model and effort, each on its own, first match wins:
 * 1. the step setting: the user picked this step's model;
 * 2. the workflow's code (`agent(key, { model })`): its author chose deliberately (a cheap model for a small step).
 *    A code model is for the code's engine, so it is dropped when the step setting moved the step to the other;
 * 3. `[workflow.<name>.<engine>]`, then `[workflow."*".<engine>]`: defaults for that engine's agents;
 * 4. nothing: the CLI's own default.
 */
export function resolveAgentModel(
  settings: Config['workflow'],
  req: { workflow: string; key: string; engine: string; model: string | null; effort: Effort | null },
): {
  engine: string;
  model: string | null;
  effort: Effort | null;
  origin: { engine: 'agent' | 'code'; model: ModelOrigin; effort: ModelOrigin };
} {
  const own = settings[req.workflow];
  const all = settings['*'];
  const step = { ...all?.agent[req.key], ...own?.agent[req.key] };
  const moved = step.engine !== undefined && step.engine !== req.engine;
  const engineName = step.engine ?? req.engine;
  const engine = engineName === 'claude' || engineName === 'codex' ? engineName : null;
  const pick = <K extends 'model' | 'effort'>(field: K, code: ModelSetting[K] | null) => {
    const candidates: [ModelSetting[K] | null | undefined, ModelOrigin][] = [
      [own?.agent[req.key]?.[field], 'agent'],
      [all?.agent[req.key]?.[field], 'agent'],
      [code, 'code'],
      [engine ? own?.[engine]?.[field] : undefined, 'workflow'],
      [engine ? all?.[engine]?.[field] : undefined, 'all'],
    ];
    const hit = candidates.find(([v]) => v !== undefined && v !== null);
    return hit ? ([hit[0] as ModelSetting[K], hit[1]] as const) : ([null, 'default'] as const);
  };
  const [model, modelOrigin] = pick('model', moved ? null : req.model);
  const [effort, effortOrigin] = pick('effort', req.effort);
  return {
    engine: engineName,
    model: model ?? null,
    effort: effort ?? null,
    origin: { engine: step.engine !== undefined ? 'agent' : 'code', model: modelOrigin, effort: effortOrigin },
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

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

export function profileNames(config: Config, kind: RealKind): string[] {
  const names = Object.keys(config[kind].profiles);
  return names.length > 0 ? names : ['default'];
}

export function resolveProfile(config: Config, kind: RealKind, name?: string): ResolvedProfile {
  const section = config[kind];
  const names = profileNames(config, kind);
  const chosen = name ?? section.default ?? names[0] ?? 'default';
  const raw = section.profiles[chosen];
  if (!raw && !(chosen === 'default' && Object.keys(section.profiles).length === 0)) {
    throw new ConfigError(`No ${kind} profile "${chosen}" (configured: ${names.join(', ')})`);
  }
  const env = Object.fromEntries(Object.entries(raw?.env ?? {}).map(([k, v]) => [k, expandHome(v)]));
  return {
    name: chosen,
    kind,
    command: expandHome(raw?.command ?? kind),
    args: raw?.args ?? [],
    env,
    setup: raw?.setup ?? null,
  };
}

/**
 * Runs a profile's `setup` command through the user's login shell, with the terminal attached (it may print or
 * prompt). Called once per session per profile, before the UI takes over the terminal.
 */
export function runSetup(profile: ResolvedProfile): { ok: boolean; code: number | null } {
  if (!profile.setup) return { ok: true, code: 0 };
  const shell = process.env.SHELL || '/bin/sh';
  const result = spawnSync(shell, ['-lc', profile.setup], {
    stdio: 'inherit',
    env: { ...process.env, ...profile.env },
  });
  return { ok: result.status === 0, code: result.status };
}
