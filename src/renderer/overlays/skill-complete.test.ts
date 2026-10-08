import type { AvailableSkill } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { applySkill, rankSkills, skillQuery, skillSigil } from './skill-complete';

const skill = (name: string): AvailableSkill => ({ name, description: '', scope: 'user' });

describe('skillSigil', () => {
  it('is a slash command for Claude and a $ mention for Codex', () => {
    expect(skillSigil('claude')).toBe('/');
    expect(skillSigil('codex')).toBe('$');
  });
});

describe('skillQuery', () => {
  it('finds a slash command only at the start of the message', () => {
    expect(skillQuery('/', 1, '/')).toEqual({ start: 0, end: 1, query: '' });
    expect(skillQuery('/td and more', 3, '/')).toEqual({ start: 0, end: 3, query: 'td' });
    expect(skillQuery('fix /td', 7, '/')).toBeNull();
    expect(skillQuery('src/foo', 7, '/')).toBeNull();
    expect(skillQuery('/tdd now', 8, '/')).toBeNull();
  });

  it('finds a $ mention wherever it starts a word', () => {
    expect(skillQuery('use $co', 7, '$')).toEqual({ start: 4, end: 7, query: 'co' });
    expect(skillQuery('$', 1, '$')).toEqual({ start: 0, end: 1, query: '' });
    expect(skillQuery('costs 5$x', 9, '$')).toBeNull();
    expect(skillQuery('use $co', 3, '$')).toBeNull();
  });

  it('spans the whole name when the caret is inside it', () => {
    expect(skillQuery('$code-review now', 3, '$')).toEqual({ start: 0, end: 12, query: 'co' });
  });
});

describe('rankSkills', () => {
  const skills = ['code-review', 'release-notes', 'tdd'].map(skill);

  it('lists everything for an empty query', () => {
    expect(rankSkills(skills, '').map((s) => s.name)).toEqual(['code-review', 'release-notes', 'tdd']);
  });

  it('keeps fuzzy matches, best first', () => {
    expect(rankSkills(skills, 're').map((s) => s.name)).toEqual(['release-notes', 'code-review']);
    expect(rankSkills(skills, 'tdd').map((s) => s.name)).toEqual(['tdd']);
    expect(rankSkills(skills, 'zzz')).toEqual([]);
  });
});

describe('applySkill', () => {
  it('replaces the reference and adds a space', () => {
    const at = skillQuery('/td', 3, '/');
    expect(at && applySkill('/td', at, 'tdd', '/')).toEqual({ text: '/tdd ', caret: 5 });
  });

  it('replaces a whole name and reuses the space after it', () => {
    const text = 'try $co-x please';
    const at = skillQuery(text, 7, '$');
    expect(at && applySkill(text, at, 'code-review', '$')).toEqual({ text: 'try $code-review please', caret: 17 });
  });
});
