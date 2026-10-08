import { describe, expect, it } from 'vitest';
import { fallbackPathEntries, loginShell, mergePaths, parseMarkedPath } from './shell-env';

describe('login shell PATH', () => {
  it('extracts the marked PATH from noisy shell output', () => {
    expect(parseMarkedPath('welcome!\n__LEGION_PATH__/a:/b__LEGION_PATH__\nbye')).toBe('/a:/b');
    expect(parseMarkedPath('no markers')).toBeNull();
    expect(parseMarkedPath('__LEGION_PATH____LEGION_PATH__')).toBeNull();
  });

  it('merges PATH lists without duplicates, keeping order', () => {
    expect(mergePaths('/a:/b', null, '/b:/c', undefined, '')).toBe('/a:/b:/c');
  });

  it('includes Homebrew and ~/.local/bin in the macOS fallback', () => {
    const entries = fallbackPathEntries('mac', '/Users/x').split(':');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries).toContain('/Users/x/.local/bin');
  });

  it('includes ~/.local/bin, Linuxbrew and snaps in the Linux fallback, but not macOS Homebrew', () => {
    const entries = fallbackPathEntries('linux', '/home/x').split(':');
    expect(entries[0]).toBe('/home/x/.local/bin');
    expect(entries).toContain('/home/linuxbrew/.linuxbrew/bin');
    expect(entries).toContain('/snap/bin');
    expect(entries).toContain('/usr/bin');
    expect(entries).not.toContain('/opt/homebrew/bin');
  });

  it('prefers $SHELL for the login shell', () => {
    expect(loginShell({ SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish');
    expect(loginShell({})).toMatch(/^\//);
  });
});
