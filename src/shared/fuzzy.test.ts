import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyRank } from './fuzzy';
import { imageMimeOf, languageOfPath } from './languages';

describe('fuzzyMatch', () => {
  it('requires the characters in order, ignoring case and spaces', () => {
    expect(fuzzyMatch('abc', 'xaxbxc')?.positions).toEqual([1, 3, 5]);
    expect(fuzzyMatch('A B', 'src/ab.ts')).not.toBeNull();
    expect(fuzzyMatch('cba', 'abc')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch('toolong', 'short')).toBeNull();
  });

  it('prefers segment starts, runs and the file name', () => {
    const paths = [
      'src/renderer/layout/StripView.tsx',
      'src/renderer/tiles/session/Rows.tsx',
      'docs/strip-view-notes.md',
      'src/strip.ts',
    ];
    expect(fuzzyRank('stripview', paths, 4).map((r) => r.path)[0]).toBe('src/renderer/layout/StripView.tsx');
    expect(fuzzyRank('rows', paths, 4)[0]?.path).toBe('src/renderer/tiles/session/Rows.tsx');
    expect(fuzzyRank('strip', paths, 4)[0]?.path).toBe('src/strip.ts');
  });

  it('highlights the best alignment, not the first one', () => {
    // "ts" should land on the extension of the file name, not on "tiles/session".
    const match = fuzzyMatch('rowsts', 'src/renderer/tiles/session/Rows.tsx');
    expect(match?.positions.slice(0, 4)).toEqual([27, 28, 29, 30]);
  });
});

describe('languages', () => {
  it('maps names and extensions', () => {
    expect(languageOfPath('src/a.tsx')).toBe('TypeScript');
    expect(languageOfPath('Dockerfile')).toBe('Dockerfile');
    expect(languageOfPath('pnpm-lock.yaml')).toBeNull();
    expect(languageOfPath('.gitignore')).toBeNull();
    expect(imageMimeOf('a/b/Logo.SVG')).toBe('image/svg+xml');
    expect(imageMimeOf('a.ts')).toBeNull();
  });
});
