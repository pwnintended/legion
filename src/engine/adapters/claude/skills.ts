/**
 * A session's skill allowlist for the Claude CLI. The CLI has no "only these skills" flag, so the allowlist is
 * built from three parts (see `flagSettings` in args.ts): the user's allowed skills are exposed through a tiny
 * per-session plugin (`--plugin-dir`), the bundled skills are switched off, and repo skills that are not
 * allowed are turned off by name.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionSkills } from '@shared/engine';
import { linkDirectorySync } from '../../util/links';
import { CLAUDE_PROJECT_SKILLS, skillsIn } from '../../util/skills';
import { SKILLS_PLUGIN_NAME } from './args';

export interface PreparedSkills {
  /** Plugin folder to pass as `--plugin-dir`; null when no user skill is allowed. */
  pluginDir: string | null;
  /** Names of repo skills the allowlist excludes. */
  disabled: string[];
}

/** Folder-safe form of a skill name. */
const folderName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_');

/** Build the plugin under `tempDir` and list the repo skills of `cwd` to turn off (none without an allowlist). */
export async function prepareSkills(skills: SessionSkills, cwd: string, tempDir: string): Promise<PreparedSkills> {
  const { allow } = skills;
  const repoSkills = allow ? await skillsIn(join(cwd, CLAUDE_PROJECT_SKILLS)) : [];
  const disabled = repoSkills.map((skill) => skill.name).filter((name) => !allow?.includes(name));
  const allowedUser = skills.user.filter((skill) => !allow || allow.includes(skill.name));
  if (allowedUser.length === 0) return { pluginDir: null, disabled };

  const pluginDir = join(tempDir, 'skills-plugin');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'skills'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: SKILLS_PLUGIN_NAME, version: '0.0.0', description: 'Skills this Legion session may use' }),
  );
  for (const skill of allowedUser) linkDirectorySync(skill.dir, join(pluginDir, 'skills', folderName(skill.name)));
  return { pluginDir, disabled };
}
