/**
 * Configuration: `~/.config/legion/config.toml`, overlaid by the project's `.legion/config.toml` (and
 * `.legion/config.local.toml`, gitignored). Every key is optional.
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
 *
 * [workflows]
 * approvals = "ask"             # who answers agents' tool approvals: ask (you) | auto (the engine's auto mode)
 * maxAgents = 4                 # agent sessions alive at once per run
 * ```
 *
 * Without any profile for a kind, there is one called `default` that runs the plain binary (`claude`, `codex`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import type { EngineProfile } from './engine/types.ts';
import { configHome } from './workflow/loader.ts';

const ProfileSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  setup: z.string().optional(),
});

const KindSchema = z.object({
  default: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
});

export const ConfigSchema = z.object({
  claude: KindSchema.default({ profiles: {} }),
  codex: KindSchema.default({ profiles: {} }),
  assistant: z
    .object({
      engine: z.enum(['claude', 'codex']).default('claude'),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    })
    .default({ engine: 'claude' }),
  workflows: z
    .object({
      approvals: z.enum(['ask', 'auto']).default('ask'),
      maxAgents: z.number().int().min(1).max(32).default(4),
    })
    .default({ approvals: 'ask', maxAgents: 4 }),
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

function readToml(path: string): Record<string, unknown> {
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

export function loadConfig(repo: string): Config {
  const layers = [userConfigPath(), join(repo, '.legion', 'config.toml'), join(repo, '.legion', 'config.local.toml')];
  const merged = layers.reduce<Record<string, unknown>>((acc, path) => mergeLayers(acc, readToml(path)), {});
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
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
