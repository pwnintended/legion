/**
 * From settings to what one session gets: the project's MCP servers and skill allowlist for its role
 * (`settings.access`). Pure apart from the skill folders it reads. Coordinating roles never get any.
 */
import { join } from 'node:path';
import type { EngineKind, McpServer, Role, Settings } from '@shared/domain';
import { ACCESS_ROLES, type SessionSkills } from '@shared/engine';
import type { AvailableSkill } from '@shared/rpc';
import { CLAUDE_PROJECT_SKILLS, CODEX_PROJECT_SKILLS, skillsIn, skillsInAll, userSkillRoots } from '../util/skills';

export type { AvailableSkill };

export interface ResolvedAccess {
  extraMcp: Record<string, McpServer>;
  skills: SessionSkills | null;
}

const NONE: ResolvedAccess = { extraMcp: {}, skills: null };

/**
 * @param projectId the run's project (null: a run without one has no grants)
 * @param home      the user's home, where their skills live
 */
export async function resolveAccess(
  settings: Pick<Settings, 'mcpServers' | 'access'>,
  projectId: string | null,
  role: Role,
  home: string,
): Promise<ResolvedAccess> {
  if (!projectId || !ACCESS_ROLES.includes(role)) return NONE;
  const grant = settings.access[projectId]?.[role];
  if (!grant) return NONE;

  const extraMcp: Record<string, McpServer> = {};
  for (const name of grant.mcp) {
    const server = settings.mcpServers[name];
    if (server) extraMcp[name] = server;
  }
  if (grant.skills === null) return { extraMcp, skills: null };

  // Only user skills need exposing; a repo skill is found by the CLI itself and is merely allowed or not.
  const user = await skillsInAll(userSkillRoots(home));
  return {
    extraMcp,
    skills: {
      allow: grant.skills,
      user: user.filter((skill) => grant.skills?.includes(skill.name)).map(({ name, dir }) => ({ name, dir })),
    },
  };
}

/** Skills that could go on an allowlist: the user's, then the repo's (a repo skill hides a user skill's name). */
export async function availableSkills(home: string, repoPath: string | null): Promise<AvailableSkill[]> {
  const out = new Map<string, AvailableSkill>();
  for (const skill of await skillsInAll(userSkillRoots(home))) {
    out.set(skill.name, { name: skill.name, description: skill.description, scope: 'user' });
  }
  if (repoPath) {
    const project = [
      ...(await skillsIn(join(repoPath, CLAUDE_PROJECT_SKILLS))),
      ...(await skillsIn(join(repoPath, CODEX_PROJECT_SKILLS))),
    ];
    for (const skill of project)
      out.set(skill.name, { name: skill.name, description: skill.description, scope: 'project' });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills a direct session (role `session`) on `engine` can be asked for by name: what that CLI finds by itself
 * (its own user folder and the repo's), or, under an allowlist, the allowed ones it can reach (allowed user
 * skills are exposed to either engine; a repo skill is only found in its engine's folder).
 * @param codexHome Legion's own CODEX_HOME: Codex sessions don't see the user's `~/.codex`
 */
export async function invocableSkills(
  settings: Pick<Settings, 'access'>,
  projectId: string | null,
  engine: EngineKind,
  home: string,
  codexHome: string,
  repoPath: string,
): Promise<AvailableSkill[]> {
  const allow = (projectId && settings.access[projectId]?.session?.skills) || null;
  const userRoots = allow
    ? userSkillRoots(home)
    : engine === 'claude'
      ? [join(home, '.claude', 'skills')]
      : [join(codexHome, 'skills'), join(codexHome, 'skills', '.system')];
  const out = new Map<string, AvailableSkill>();
  for (const skill of await skillsInAll(userRoots)) {
    out.set(skill.name, { name: skill.name, description: skill.description, scope: 'user' });
  }
  const repoRoot = join(repoPath, engine === 'claude' ? CLAUDE_PROJECT_SKILLS : CODEX_PROJECT_SKILLS);
  for (const skill of await skillsIn(repoRoot)) {
    out.set(skill.name, { name: skill.name, description: skill.description, scope: 'project' });
  }
  return [...out.values()]
    .filter((skill) => !allow || allow.includes(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
