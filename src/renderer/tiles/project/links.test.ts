import { describe, expect, it } from 'vitest';
import { absolutizeRepoLinks, repoTarget, resolveRepoPath } from './links';

describe('repository links', () => {
  it('resolves relative paths against the file they appear in', () => {
    expect(resolveRepoPath('README.md', 'docs/design.md')).toBe('docs/design.md');
    expect(resolveRepoPath('docs/a/b.md', '../img/x.png?raw=1#top')).toBe('docs/img/x.png');
    expect(resolveRepoPath('docs/b.md', '/LICENSE')).toBe('LICENSE');
    expect(resolveRepoPath('README.md', '../outside.md')).toBeNull();
    expect(resolveRepoPath('README.md', 'https://example.com')).toBeNull();
    expect(resolveRepoPath('README.md', '#install')).toBeNull();
  });

  it('rewrites relative links and images so the renderer keeps them', () => {
    const out = absolutizeRepoLinks(
      'See [notes](docs/design.md#why), ![logo](public/logo.svg) and [site](https://x.dev). <img src="a b.png">',
      'README.md',
    );
    expect(out).toContain('(https://repo.legion.invalid/docs/design.md#why)');
    expect(out).toContain('(https://repo.legion.invalid/public/logo.svg)');
    expect(out).toContain('(https://x.dev)');
    expect(out).toContain('src="https://repo.legion.invalid/a%20b.png"');
    expect(repoTarget('https://repo.legion.invalid/a%20b.png', 'README.md')).toBe('a b.png');
    expect(repoTarget('https://x.dev', 'README.md')).toBeNull();
  });
});
