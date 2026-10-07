import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSkillFrontMatter, skillsIn, skillsInAll } from './skills';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legion-skills-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(parent: string, folder: string, body: string): string {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}

describe('parseSkillFrontMatter', () => {
  it('reads name and description, with or without quotes', () => {
    expect(parseSkillFrontMatter('---\nname: zebra\ndescription: "Use for zebras."\n---\nbody')).toEqual({
      name: 'zebra',
      description: 'Use for zebras.',
    });
  });
  it('is null without front matter', () => {
    expect(parseSkillFrontMatter('# just text')).toBeNull();
  });
});

describe('skillsIn', () => {
  it('lists skill folders by front matter name, falling back to the folder name', async () => {
    skill(root, 'a-folder', '---\nname: alpha\ndescription: first\n---\n');
    skill(root, 'beta', 'no front matter');
    mkdirSync(join(root, 'not-a-skill'));
    skill(root, '.hidden', '---\nname: hidden\n---\n');
    expect(await skillsIn(root)).toEqual([
      { name: 'alpha', description: 'first', dir: join(root, 'a-folder') },
      { name: 'beta', description: '', dir: join(root, 'beta') },
    ]);
  });

  it('follows a symlinked skill folder and tolerates a missing root', async () => {
    const real = skill(join(root, 'elsewhere'), 'gamma', '---\nname: gamma\n---\n');
    mkdirSync(join(root, 'skills'));
    symlinkSync(real, join(root, 'skills', 'gamma'));
    expect((await skillsIn(join(root, 'skills'))).map((s) => s.name)).toEqual(['gamma']);
    expect(await skillsIn(join(root, 'missing'))).toEqual([]);
  });

  it('lets the first root win a name', async () => {
    skill(join(root, 'one'), 'x', '---\nname: dup\ndescription: from one\n---\n');
    skill(join(root, 'two'), 'x', '---\nname: dup\ndescription: from two\n---\n');
    const all = await skillsInAll([join(root, 'one'), join(root, 'two')]);
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toBe('from one');
  });
});
