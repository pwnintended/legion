/**
 * Skill autocomplete for the session composer (⌘⇧N): typing the engine's sigil offers the skills the session can
 * use. Claude runs a skill as a slash command, so `/name` only counts at the very start of the message; Codex
 * picks up a `$name` mention anywhere it starts a word. Pure: the composer owns the textarea and the list.
 */
import type { EngineKind } from '@shared/domain';
import { fuzzyMatch } from '@shared/fuzzy';
import type { AvailableSkill } from '@shared/rpc';

export type SkillSigil = '/' | '$';

export function skillSigil(engine: EngineKind): SkillSigil {
  return engine === 'codex' ? '$' : '/';
}

/** The skill reference being typed: `text.slice(start, end)` is the sigil and the name so far. */
export interface SkillQuery {
  start: number;
  end: number;
  query: string;
}

const NAME_CHAR = /[\w.:-]/;

/** The skill reference the caret is in, if any (a collapsed selection only). */
export function skillQuery(text: string, caret: number, sigil: SkillSigil): SkillQuery | null {
  let start = caret;
  while (start > 0 && NAME_CHAR.test(text[start - 1] as string)) start -= 1;
  start -= 1;
  if (start < 0 || text[start] !== sigil) return null;
  if (sigil === '/' ? start !== 0 : start > 0 && !/\s/.test(text[start - 1] as string)) return null;
  let end = caret;
  while (end < text.length && NAME_CHAR.test(text[end] as string)) end += 1;
  return { start, end, query: text.slice(start + 1, caret) };
}

/** Skills matching `query`, best first (all of them, by name, for an empty query). */
export function rankSkills(skills: readonly AvailableSkill[], query: string, limit = 50): AvailableSkill[] {
  if (!query) return skills.slice(0, limit);
  return skills
    .map((skill) => ({ skill, match: fuzzyMatch(query, skill.name) }))
    .filter((entry): entry is { skill: AvailableSkill; match: NonNullable<typeof entry.match> } => !!entry.match)
    .sort((a, b) => b.match.score - a.match.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => entry.skill);
}

/** Replace the reference with the chosen skill and a space; the caret goes after the space. */
export function applySkill(
  text: string,
  at: SkillQuery,
  name: string,
  sigil: SkillSigil,
): { text: string; caret: number } {
  const rest = text.slice(at.end);
  const insert = `${sigil}${name}${rest.startsWith(' ') ? '' : ' '}`;
  return {
    text: text.slice(0, at.start) + insert + rest,
    caret: at.start + insert.length + (rest.startsWith(' ') ? 1 : 0),
  };
}
