/**
 * Finding skills on disk. A skill is a folder with a `SKILL.md` whose front matter has `name` and
 * `description`; the folder name stands in for a missing `name`. Used to offer skills in settings, to resolve
 * an allowlist into folders, and by the adapters to turn off the skills a session may not use.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillInfo {
  name: string;
  description: string;
  /** The skill's folder (what an adapter links into a session). */
  dir: string;
}

/** Where a user's own skills live (shared between projects). */
export function userSkillRoots(home: string): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
}

/** Skills a repository ships (read by the CLI from the working directory). */
export const CLAUDE_PROJECT_SKILLS = join('.claude', 'skills');
export const CODEX_PROJECT_SKILLS = join('.agents', 'skills');

/** `name` and `description` from a SKILL.md's front matter; null without front matter. */
export function parseSkillFrontMatter(text: string): { name: string | null; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return null;
  const field = (key: string): string | null => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1] ?? '');
    const value = line?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
    return value ? value : null;
  };
  return { name: field('name'), description: field('description') ?? '' };
}

/** Skills directly inside `root` (symlinked folders count); an unreadable or missing root has none. */
export async function skillsIn(root: string): Promise<SkillInfo[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const isDir = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) continue;
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
    if (text === null) continue;
    const meta = parseSkillFrontMatter(text);
    found.push({ name: meta?.name ?? entry.name, description: meta?.description ?? '', dir });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills of several roots; the first root wins a name. */
export async function skillsInAll(roots: readonly string[]): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const root of roots) {
    for (const skill of await skillsIn(root)) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
