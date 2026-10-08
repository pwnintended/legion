import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareCodexSkills } from './skills';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legion-codex-skills-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(parent: string, folder: string, name: string): string {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  return dir;
}

describe('prepareCodexSkills', () => {
  it('disables repo, user and system skills that are not allowed and links the allowed user skills', async () => {
    const repo = join(root, 'repo');
    skill(join(repo, '.agents', 'skills'), 'keep', 'keep');
    skill(join(repo, '.agents', 'skills'), 'drop', 'drop');
    const home = join(root, 'codex-home');
    skill(join(home, 'skills', '.system'), 'imagegen', 'imagegen');
    const zebra = skill(join(root, 'mine'), 'zebra', 'zebra');
    const temp = join(root, 'temp');
    mkdirSync(temp);

    const prepared = await prepareCodexSkills(
      { allow: ['keep', 'zebra'], user: [{ name: 'zebra', dir: zebra }] },
      repo,
      home,
      temp,
    );
    expect(prepared.disabled.sort()).toEqual(['drop', 'imagegen']);
    expect(prepared.extraRoot).toBe(join(temp, 'skills'));
    expect(readlinkSync(join(temp, 'skills', 'zebra'))).toBe(zebra);
  });

  it('without an allowlist, links every user skill and disables nothing', async () => {
    const repo = join(root, 'repo');
    skill(join(repo, '.agents', 'skills'), 'keep', 'keep');
    const zebra = skill(join(root, 'mine'), 'zebra', 'zebra');
    const temp = join(root, 'temp');
    mkdirSync(temp);
    const prepared = await prepareCodexSkills(
      { allow: null, user: [{ name: 'zebra', dir: zebra }] },
      repo,
      join(root, 'h'),
      temp,
    );
    expect(prepared).toEqual({ extraRoot: join(temp, 'skills'), disabled: [] });
    expect(readlinkSync(join(temp, 'skills', 'zebra'))).toBe(zebra);
  });

  it('has no extra root when no user skill is allowed', async () => {
    const prepared = await prepareCodexSkills({ allow: [], user: [] }, join(root, 'r'), join(root, 'h'), root);
    expect(prepared).toEqual({ extraRoot: null, disabled: [] });
  });
});
