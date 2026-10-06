import { describe, expect, it } from 'vitest';
import { fallbackPathEntries, mergePaths, parseMarkedPath } from './shell-env';

describe('login shell PATH', () => {
  it('extracts the marked PATH from noisy shell output', () => {
    expect(parseMarkedPath('welcome!\n__LEGION_PATH__/a:/b__LEGION_PATH__\nbye')).toBe('/a:/b');
    expect(parseMarkedPath('no markers')).toBeNull();
    expect(parseMarkedPath('__LEGION_PATH____LEGION_PATH__')).toBeNull();
  });

  it('merges PATH lists without duplicates, keeping order', () => {
    expect(mergePaths('/a:/b', null, '/b:/c', undefined, '')).toBe('/a:/b:/c');
  });

  it('includes Homebrew and ~/.local/bin in the fallback', () => {
    const entries = fallbackPathEntries('/Users/x').split(':');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries).toContain('/Users/x/.local/bin');
  });
});
