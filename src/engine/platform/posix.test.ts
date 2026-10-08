import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixPlatform } from './posix';

const platform = posixPlatform('linux');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-platform-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bin(name: string, mode: number): string {
  const folder = join(dir, 'bin');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), '#!/bin/sh\n');
  chmodSync(join(folder, name), mode);
  return folder;
}

describe('posix findExecutable', () => {
  it('returns the first executable match on PATH, skipping missing and relative entries', () => {
    const folder = bin('tool', 0o755);
    expect(platform.findExecutable('tool', { PATH: `/nonexistent:relative:${folder}` })).toBe(join(folder, 'tool'));
  });

  it('ignores files without an execute bit, directories and an empty PATH', () => {
    const folder = bin('plain', 0o644);
    mkdirSync(join(folder, 'dir'));
    expect(platform.findExecutable('plain', { PATH: folder })).toBeNull();
    expect(platform.findExecutable('dir', { PATH: folder })).toBeNull();
    expect(platform.findExecutable('tool', { PATH: '' })).toBeNull();
    expect(platform.findExecutable('tool', {})).toBeNull();
  });

  it('checks an absolute path as is, and never resolves a relative one', () => {
    const folder = bin('tool', 0o755);
    expect(platform.findExecutable(join(folder, 'tool'), {})).toBe(join(folder, 'tool'));
    expect(platform.findExecutable(join(folder, 'nope'), {})).toBeNull();
    expect(platform.findExecutable('bin/tool', { PATH: dir })).toBeNull();
  });
});

describe('posix interactiveShell', () => {
  it("opens the user's shell as a login shell, falling back to /bin/sh", () => {
    expect(platform.interactiveShell({ SHELL: '/usr/bin/fish' })).toEqual({ cmd: '/usr/bin/fish', args: ['-l'] });
    expect(platform.interactiveShell({})).toEqual({ cmd: '/bin/sh', args: ['-l'] });
  });
});
