import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmp } from '../git/test-helpers.ts';
import { allows, findRole, listRoles, parseRole, RoleError } from './roles.ts';

let dir: { path: string; cleanup: () => void };
beforeEach(() => {
  dir = tmp('legion-roles-');
});
afterEach(() => dir.cleanup());

describe('roles', () => {
  it('parses frontmatter with defaults and keeps the body as instructions', () => {
    const role = parseRole('/x/fauna.md', 'project', '---\nmodel: sonnet\nspawns: []\n---\n\nMake creatures.\n');
    expect(role).toMatchObject({
      name: 'fauna',
      engine: 'claude',
      model: 'sonnet',
      workflows: '*',
      spawns: [],
      approvals: 'auto',
      maxRuns: 4,
      instructions: 'Make creatures.',
    });
    expect(parseRole('/x/plain.md', 'user', 'Just text.').instructions).toBe('Just text.');
  });

  it('rejects bad frontmatter', () => {
    expect(() => parseRole('/x/a.md', 'project', '---\nengine: gemini\n---\n')).toThrow(RoleError);
    expect(() => parseRole('/x/a.md', 'project', '---\n: : :\n---\n')).toThrow(/not valid YAML/);
  });

  it('lets project roles override builtins and reports broken files', () => {
    const roles = join(dir.path, '.legion', 'roles');
    mkdirSync(roles, { recursive: true });
    writeFileSync(join(roles, 'art-director.md'), '---\ndescription: ours\n---\nOurs.');
    writeFileSync(join(roles, 'broken.md'), '---\nmaxRuns: 0\n---\n');
    writeFileSync(join(roles, '_partial.md'), 'ignored');
    const { roles: list, errors } = listRoles(dir.path);
    expect(list.find((r) => r.name === 'art-director')).toMatchObject({ source: 'project', description: 'ours' });
    expect(list.map((r) => r.name)).toEqual(
      expect.arrayContaining(['team-lead', 'engineering-lead', 'world-designer']),
    );
    expect(list.some((r) => r.name === '_partial')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(() => findRole(dir.path, 'broken')).toThrow(/maxRuns/);
    expect(() => findRole(dir.path, 'nope')).toThrow(/No role "nope"/);
  });

  it('builtin roles all parse', () => {
    const { errors, roles } = listRoles(dir.path);
    expect(errors).toEqual([]);
    expect(roles.every((r) => r.source === 'builtin' && r.instructions.length > 0)).toBe(true);
  });

  it('allows names from a list or everything', () => {
    expect(allows('*', 'x')).toBe(true);
    expect(allows(['a'], 'a')).toBe(true);
    expect(allows([], 'a')).toBe(false);
  });
});
