import { describe, expect, it } from 'vitest';
import { compileGlob, globMatchesPath, globProblems, globsOverlap, isLiteralGlob, normalizeGlob } from './glob';

describe('normalizeGlob / isLiteralGlob', () => {
  it('normalizes leading ./ and duplicate slashes', () => {
    expect(normalizeGlob('  ./src//a/ ')).toBe('src/a/');
    expect(normalizeGlob('././x')).toBe('x');
  });

  it('detects wildcard-free patterns', () => {
    expect(isLiteralGlob('src/db/schema.ts')).toBe(true);
    expect(isLiteralGlob('src/*.ts')).toBe(false);
    expect(isLiteralGlob('src/{a,b}.ts')).toBe(false);
    expect(isLiteralGlob('src/\\*.ts')).toBe(true);
  });
});

describe('globProblems', () => {
  const severities = (glob: string) => globProblems(glob).map((p) => p.severity);

  it('accepts sane relative globs', () => {
    for (const glob of ['src/a.ts', 'src/**/*.test.ts', './docs/', 'src/{a,b}/[xy].ts']) {
      expect(globProblems(glob)).toEqual([]);
    }
  });

  it('rejects absolute, escaping, .git, negated, empty and unbalanced globs', () => {
    for (const glob of [
      '/etc/passwd',
      '~/x',
      'C:\\x',
      '../x',
      'src/../../x',
      '.git/config',
      '!src/**',
      '',
      '.',
      'src/{a',
      'src/a}',
      'src/[ab',
    ]) {
      expect(severities(glob), glob).toContain('error');
    }
  });

  it('warns about whole-repo globs, extglobs and backslash separators', () => {
    for (const glob of ['**', '**/*', '*', 'src/@(a|b).ts', 'src\\a.ts']) {
      expect(severities(glob), glob).toEqual(['warning']);
    }
  });
});

describe('globsOverlap', () => {
  const overlapping: [string, string][] = [
    ['src/**', 'src/a.ts'],
    ['src/*.ts', 'src/index.ts'],
    ['src/**/*.test.ts', 'src/a/b/c.test.ts'],
    ['**/index.ts', 'src/index.ts'],
    ['**/index.ts', 'index.ts'],
    ['src/{a,b}/x.ts', 'src/b/*.ts'],
    ['src/db', 'src/db/schema.ts'],
    ['src/db/', 'src/db/x/y.ts'],
    ['src/[ab].ts', 'src/b.ts'],
    ['src/[a-f]*.ts', 'src/[e-z]*.ts'],
    ['src/a*', 'src/*b'],
    ['src/*/x.ts', 'src/**/x.ts'],
    ['src/**/a/**', 'src/**/b/**'],
    ['src/?.ts', 'src/x.ts'],
    ['src/[!a].ts', 'src/b.ts'],
    ['src/*.ts', 'src/*.ts'],
  ];
  const disjoint: [string, string][] = [
    ['src/a/**', 'src/b/**'],
    ['src/*.ts', 'src/a/b.ts'],
    ['src/[ab].ts', 'src/c.ts'],
    ['docs/**', 'src/**'],
    ['src/a.ts', 'src/a.tsx'],
    ['**/*.ts', '**/*.tsx'],
    ['src/{a,b}.ts', 'src/c.ts'],
    ['*.md', 'src/x.md'],
    ['src/[!a].ts', 'src/a.ts'],
    ['src/?.ts', 'src/ab.ts'],
    ['src/[a-c]*.ts', 'src/[x-z]*.ts'],
    ['src/db', 'src/dbx.ts'],
  ];

  it.each(overlapping)('%s overlaps %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(true);
    expect(globsOverlap(b, a)).toBe(true);
  });

  it.each(disjoint)('%s is disjoint from %s', (a, b) => {
    expect(globsOverlap(a, b)).toBe(false);
    expect(globsOverlap(b, a)).toBe(false);
  });

  it('is conservative for unsupported syntax', () => {
    expect(compileGlob('src/@(a|b).ts').unsupported).toBe(true);
    expect(globsOverlap('src/@(a|b).ts', 'docs/x.md')).toBe(true);
    expect(globsOverlap('src/file{1..3}.ts', 'lib/x.ts')).toBe(true);
    const huge = 'a{1,2,3,4,5,6,7}/b{1,2,3,4,5,6,7}/c{1,2,3,4,5,6,7}';
    expect(compileGlob(huge).unsupported).toBe(true);
    expect(globsOverlap(huge, 'zzz')).toBe(true);
  });

  it('treats literal braces without a comma as text', () => {
    expect(globsOverlap('src/{x}.ts', 'src/{x}.ts')).toBe(true);
    expect(globsOverlap('src/{x}.ts', 'src/x.ts')).toBe(false);
  });

  it('can compare as exact file paths', () => {
    expect(globsOverlap('src', '**/package.json')).toBe(true);
    expect(globsOverlap('src', '**/package.json', false)).toBe(false);
  });
});

describe('globMatchesPath', () => {
  it('matches concrete paths', () => {
    expect(globMatchesPath('src/**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(globMatchesPath('src/**/*.ts', 'src/b.ts')).toBe(true);
    expect(globMatchesPath('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatchesPath('src/db', 'src/db/x.ts')).toBe(true);
    expect(globMatchesPath('src/db', 'src/db')).toBe(true);
    expect(globMatchesPath('src/db', 'src/dbx.ts')).toBe(false);
    expect(globMatchesPath('src/[*].ts', 'src/*.ts')).toBe(true);
    expect(globMatchesPath('src/\\*.ts', 'src/a.ts')).toBe(false);
  });
});

describe('globsOverlap soundness (seeded fuzz)', () => {
  // Never under-report: whenever a concrete path matches both globs, they must overlap.
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const pick = <T>(items: readonly T[]): T => items[rand(items.length)] as T;
  const segmentPieces = ['a', 'b', 'ab', '*', 'a*', '*b', '?', '[ab]', '[!a]', '{a,b}', 'x.ts', '*.ts', 'index.ts'];
  const globs = Array.from({ length: 60 }, () => {
    const depth = 1 + rand(3);
    return Array.from({ length: depth }, () => (rand(5) === 0 ? '**' : pick(segmentPieces))).join('/');
  });
  const names = ['a', 'b', 'ab', 'ba', 'x.ts', 'index.ts', 'c', 'aa.ts'];
  const paths = Array.from({ length: 400 }, () => Array.from({ length: 1 + rand(4) }, () => pick(names)).join('/'));

  // Independent reference matcher (regex) for the fuzz alphabet above.
  const referenceRegex = (glob: string): RegExp => {
    const full = /[*?[\]{}]/.test(glob) ? glob : `${glob}/**`;
    const segment = (seg: string) =>
      seg
        .replace(/[.]/g, '\\.')
        .replace(/\[!/g, '[^/')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{([^}]*)\}/g, (_, body: string) => `(?:${body.split(',').join('|')})`);
    const body = full
      .split('/')
      .map((seg) => (seg === '**' ? '(?:/[^/]+)*' : `/${segment(seg)}`))
      .join('');
    return new RegExp(`^${body}$`);
  };

  it('agrees with an independent regex matcher on concrete paths', () => {
    for (const g of globs) {
      const re = referenceRegex(g);
      for (const p of paths) expect(globMatchesPath(g, p), `${g} ~ ${p}`).toBe(re.test(`/${p}`));
    }
  });

  it('reports an overlap whenever a sample path matches both globs', () => {
    const matches = globs.map((g) => {
      const re = referenceRegex(g);
      return new Set(paths.filter((p) => re.test(`/${p}`)));
    });
    let witnessed = 0;
    for (let i = 0; i < globs.length; i++) {
      for (let j = i + 1; j < globs.length; j++) {
        const a = matches[i] as Set<string>;
        const b = matches[j] as Set<string>;
        if ([...a].some((p) => b.has(p))) {
          witnessed++;
          expect(globsOverlap(globs[i] as string, globs[j] as string), `${globs[i]} vs ${globs[j]}`).toBe(true);
        }
      }
    }
    expect(witnessed).toBeGreaterThan(50);
  });
});
