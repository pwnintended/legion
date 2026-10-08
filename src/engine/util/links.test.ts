import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refuse = vi.hoisted(() => ({ files: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    // Windows without Developer Mode: file symlinks fail with EPERM, junctions still work.
    symlink: (target: string, path: string, type?: string) =>
      refuse.files && type === 'file'
        ? Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
        : real.symlink(target, path, type as never),
  };
});

const { linkOrCopy } = await import('./links');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-links-'));
  refuse.files = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('linkOrCopy', () => {
  it('links files and directories', async () => {
    writeFileSync(join(dir, '.env'), 'A=1');
    mkdirSync(join(dir, 'cache'));
    expect(await linkOrCopy(join(dir, '.env'), join(dir, 'env-link'))).toBe('linked');
    expect(await linkOrCopy(join(dir, 'cache'), join(dir, 'cache-link'))).toBe('linked');
    expect(lstatSync(join(dir, 'env-link')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'cache-link')).isSymbolicLink()).toBe(true);
  });

  it('copies a file when the OS refuses file symlinks, and still links directories', async () => {
    refuse.files = true;
    writeFileSync(join(dir, '.env'), 'A=1');
    mkdirSync(join(dir, 'cache'));
    expect(await linkOrCopy(join(dir, '.env'), join(dir, 'env-copy'))).toBe('copied');
    expect(lstatSync(join(dir, 'env-copy')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'env-copy'), 'utf8')).toBe('A=1');
    expect(await linkOrCopy(join(dir, 'cache'), join(dir, 'cache-link'))).toBe('linked');
  });
});
