/**
 * From settings to what one session gets: the project's MCP servers and skill allowlist for its role
 * (`settings.access`). Pure apart from the skill folders it reads. Coordinating roles never get any. A direct
 * session (⌘⇧N) is the human's own, so without an allowlist it gets their user skills on top of the CLI's set
 * (Codex runs in Legion's own home and would not find them; Claude loads the user's settings for it instead).
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

/** Roles that get the user's skills when no allowlist says otherwise. */
const USER_SKILLS_BY_DEFAULT: readonly Role[] = ['session'];

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
  if (!ACCESS_ROLES.includes(role)) return NONE;
  const grant = projectId ? settings.access[projectId]?.[role] : undefined;
  const defaultSkills = async (): Promise<SessionSkills | null> =>
    USER_SKILLS_BY_DEFAULT.includes(role)
      ? { allow: null, user: (await skillsInAll(userSkillRoots(home))).map(({ name, dir }) => ({ name, dir })) }
      : null;
  if (!grant) return { extraMcp: {}, skills: await defaultSkills() };

  const extraMcp: Record<string, McpServer> = {};
  for (const name of grant.mcp) {
    const server = settings.mcpServers[name];
    if (server) extraMcp[name] = server;
  }
  if (grant.skills === null) return { extraMcp, skills: await defaultSkills() };

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
 * Skills a direct session (role `session`) on `engine` can be asked for by name, and the repo's in that engine's
 * folder. User skills: without an allowlist, Claude runs with the user's own settings (`userSettings`) and finds
 * `~/.claude/skills` itself, while Codex is handed both user folders (`resolveAccess`); an allowlist exposes the
 * allowed ones from either folder to either engine.
 * @param codexHome Legion's own CODEX_HOME (its skills are found by Codex too)
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
      : [...userSkillRoots(home), join(codexHome, 'skills'), join(codexHome, 'skills', '.system')];
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
