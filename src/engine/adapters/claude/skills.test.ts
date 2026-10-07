import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSkills } from './skills';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legion-claude-skills-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(parent: string, folder: string, name: string): string {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  return dir;
}

describe('prepareSkills', () => {
  it('links allowed user skills into a plugin and lists the repo skills left out', async () => {
    const repo = join(root, 'repo');
    skill(join(repo, '.claude', 'skills'), 'keep', 'keep');
    skill(join(repo, '.claude', 'skills'), 'drop', 'drop');
    const zebra = skill(join(root, 'home'), 'zebra', 'zebra');
    const other = skill(join(root, 'home'), 'other', 'other');
    const temp = join(root, 'temp');
    mkdirSync(temp);

    const prepared = await prepareSkills(
      {
        allow: ['keep', 'zebra'],
        user: [
          { name: 'zebra', dir: zebra },
          { name: 'other', dir: other },
        ],
      },
      repo,
      temp,
    );
    expect(prepared.disabled).toEqual(['drop']);
    expect(prepared.pluginDir).toBe(join(temp, 'skills-plugin'));
    const manifest = JSON.parse(readFileSync(join(temp, 'skills-plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('legion-skills');
    expect(readlinkSync(join(temp, 'skills-plugin', 'skills', 'zebra'))).toBe(zebra);
    expect(existsSync(join(temp, 'skills-plugin', 'skills', 'other'))).toBe(false);
    expect(lstatSync(join(temp, 'skills-plugin', 'skills', 'zebra')).isSymbolicLink()).toBe(true);
  });

  it('builds no plugin when no user skill is allowed', async () => {
    const prepared = await prepareSkills({ allow: [], user: [] }, join(root, 'empty'), root);
    expect(prepared).toEqual({ pluginDir: null, disabled: [] });
  });
});
