/**
 * Roles: what kind of lead an agent is. A role is a Markdown file whose YAML frontmatter says how the lead runs
 * (engine, model, which workflows it may run, which roles it may spawn) and whose body is its standing
 * instructions. Resolution, first match by name wins: `.legion/roles/`, `~/.config/legion/roles/`, builtin.
 *
 * ```markdown
 * ---
 * description: Leads asset production for a planet
 * engine: claude                              # in mixed mode; a single provider ([models]) wins
 * tier: lead                                  # its model and effort: [models.<engine>.<tier>]
 * workflows: [asset-critique, concept-sheet]   # or "*"
 * spawns: [fauna-lead, vegetation-lead]        # or "*", or []
 * gates: decide                                # decide | tell | ask: who answers its runs' gates
 * workspace: branch                            # branch (its own worktree and branch) | shared (the user's checkout)
 * ---
 * You lead asset production…
 * ```
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { configHome, PACKAGE_ROOT } from '../workflow/loader.ts';

export type RoleSource = 'project' | 'user' | 'builtin';

const Names = z.union([z.literal('*'), z.array(z.string().min(1))]);

const FrontmatterSchema = z.object({
  description: z.string().default(''),
  engine: z.enum(['claude', 'codex']).default('claude'),
  /** Which tier's model and effort it uses (`[models.<engine>.<tier>]`). */
  tier: z.enum(['assistant', 'lead', 'hard', 'medium', 'easy']).default('lead'),
  /** A specific model (and effort) over the tier's, on its own engine. */
  model: z.string().min(1).nullable().default(null),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  /** Workflows the lead may run. */
  workflows: Names.default('*'),
  /** Roles the lead may spawn as its own sub-leads. */
  spawns: Names.default('*'),
  /** Who answers the lead's own tool approvals: the engine's auto mode, or the human. */
  approvals: z.enum(['ask', 'auto']).default('auto'),
  /**
   * Who answers the gates, questions and tool approvals of the lead's runs: the lead (`decide`), the lead with
   * every answer reported to its parent (`tell`), or the user (`ask`).
   */
  gates: z.enum(['decide', 'tell', 'ask']).default('decide'),
  /** Workflow runs the lead may have active at once. */
  maxRuns: z.number().int().min(1).max(64).default(4),
  /**
   * Where the lead works: `branch` = its own worktree on its own branch (its runs start from and merge into it; its
   * parent merges it up), `shared` = the user's checkout (for leads that only coordinate or read).
   */
  workspace: z.enum(['branch', 'shared']).default('branch'),
});

export interface Role extends z.infer<typeof FrontmatterSchema> {
  name: string;
  source: RoleSource;
  file: string;
  /** The Markdown body: the lead's standing instructions. */
  instructions: string;
}

export function projectRoleDir(repo: string): string {
  return join(repo, '.legion', 'roles');
}

export function userRoleDir(): string {
  return join(configHome(), 'roles');
}

export function builtinRoleDir(): string {
  return join(PACKAGE_ROOT, 'builtin', 'roles');
}

export class RoleError extends Error {}

export function parseRole(file: string, source: RoleSource, text = readFileSync(file, 'utf8')): Role {
  const name = basename(file, extname(file));
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let front: unknown = {};
  let body = text;
  if (m) {
    try {
      front = parse(m[1] ?? '') ?? {};
    } catch (err) {
      throw new RoleError(`${file}: frontmatter is not valid YAML: ${err instanceof Error ? err.message : err}`);
    }
    body = m[2] ?? '';
  }
  const parsed = FrontmatterSchema.safeParse(front);
  if (!parsed.success) {
    throw new RoleError(
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'frontmatter'}: ${i.message}`).join('; ')}`,
    );
  }
  return { ...parsed.data, name, source, file, instructions: body.trim() };
}

/** Every role visible from `repo`, by name, the winning file only. Broken files are reported, not thrown. */
export function listRoles(repo: string): { roles: Role[]; errors: string[] } {
  const layers: [RoleSource, string][] = [
    ['project', projectRoleDir(repo)],
    ['user', userRoleDir()],
    ['builtin', builtinRoleDir()],
  ];
  const byName = new Map<string, Role>();
  const errors: string[] = [];
  for (const [source, dir] of layers) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.md') || entry.startsWith('_')) continue;
      const name = basename(entry, '.md');
      if (byName.has(name)) continue;
      try {
        byName.set(name, parseRole(join(dir, entry), source));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { roles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function findRole(repo: string, name: string): Role {
  const { roles, errors } = listRoles(repo);
  const role = roles.find((r) => r.name === name);
  if (role) return role;
  const broken = errors.find((e) => e.includes(`/${name}.md:`));
  throw new RoleError(broken ?? `No role "${name}". Roles: ${roles.map((r) => r.name).join(', ') || 'none'}`);
}

/** Whether a names list (`'*'` or a list) allows `name`. */
export function allows(list: '*' | readonly string[], name: string): boolean {
  return list === '*' || list.includes(name);
}
