/**
 * A session's skill allowlist for Codex. Codex has no "only these skills" switch either, so the session
 * (its own app-server process) disables, by name, every skill it would find that is not allowed, and exposes
 * the allowed user skills through an extra skills root of symlinks (`skills/extraRoots/set`).
 *
 * Found skills: the repo's `.agents/skills`, and `<CODEX_HOME>/skills` (user skills; the `.system` folder holds
 * the ones Codex ships).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionSkills } from '@shared/engine';
import { linkDirectorySync } from '../../util/links';
import { CODEX_PROJECT_SKILLS, skillsIn } from '../../util/skills';

export interface PreparedCodexSkills {
  /** Folder of symlinks to the allowed user skills; null when none is allowed. */
  extraRoot: string | null;
  /** Skills to turn off. */
  disabled: string[];
}

const folderName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_');

export async function prepareCodexSkills(
  skills: SessionSkills,
  cwd: string,
  codexHome: string,
  tempDir: string,
): Promise<PreparedCodexSkills> {
  const { allow } = skills;
  // Without an allowlist nothing is turned off: the user skills are only added.
  const present = allow
    ? [
        ...(await skillsIn(join(cwd, CODEX_PROJECT_SKILLS))),
        ...(await skillsIn(join(codexHome, 'skills'))),
        ...(await skillsIn(join(codexHome, 'skills', '.system'))),
      ]
    : [];
  const disabled = [...new Set(present.map((skill) => skill.name))].filter((name) => !allow?.includes(name));
  const allowedUser = skills.user.filter((skill) => !allow || allow.includes(skill.name));
  if (allowedUser.length === 0) return { extraRoot: null, disabled };
  const extraRoot = join(tempDir, 'skills');
  mkdirSync(extraRoot, { recursive: true });
  for (const skill of allowedUser) linkDirectorySync(skill.dir, join(extraRoot, folderName(skill.name)));
  return { extraRoot, disabled };
}
