import type { DiscoveredRepo, RecentRepo } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import {
  abbreviatePath,
  buildBranchOptions,
  buildRepoPickerView,
  expandPath,
  listKeyAction,
  looksLikePath,
  matchScore,
  mergeRepos,
  moveActive,
  opensPicker,
  pathFromFileUrl,
  type RepoEntry,
} from './picker-model';

const HOME = '/Users/me';
const entry = (path: string, extra: Partial<RepoEntry> = {}): RepoEntry => ({
  path,
  name: path.split('/').at(-1) ?? path,
  branch: 'main',
  dirty: false,
  lastCommitAt: null,
  ...extra,
});

describe('paths', () => {
  it('abbreviates home to ~', () => {
    expect(abbreviatePath('/Users/me/src/app', HOME)).toBe('~/src/app');
    expect(abbreviatePath('/Users/me', HOME)).toBe('~');
    expect(abbreviatePath('/Users/meow/app', HOME)).toBe('/Users/meow/app');
    expect(abbreviatePath('/opt/app', null)).toBe('/opt/app');
  });

  it('recognises and expands typed or pasted paths', () => {
    expect(looksLikePath('~/src')).toBe(true);
    expect(looksLikePath('  /tmp/x')).toBe(true);
    expect(looksLikePath('legion')).toBe(false);
    expect(looksLikePath('~foo')).toBe(false);
    expect(expandPath('~/src/app/', HOME)).toBe('/Users/me/src/app');
    expect(expandPath('~', HOME)).toBe('/Users/me');
    expect(expandPath("'/Users/me/My Repo'", HOME)).toBe('/Users/me/My Repo');
    expect(expandPath('/Users/me/My\\ Repo', HOME)).toBe('/Users/me/My Repo');
    expect(expandPath('//tmp///x//', HOME)).toBe('/tmp/x');
    expect(expandPath('/', HOME)).toBe('/');
    expect(expandPath('~/x', null)).toBeNull();
    expect(expandPath('relative/x', HOME)).toBeNull();
  });

  it('reads a path from a Finder file:// drag', () => {
    expect(pathFromFileUrl('file:///Users/me/My%20Repo/\r\n')).toBe('/Users/me/My Repo');
    expect(pathFromFileUrl('# comment\nfile:///tmp/x')).toBe('/tmp/x');
    expect(pathFromFileUrl('https://example.com')).toBeNull();
    expect(pathFromFileUrl('')).toBeNull();
  });
});

describe('repository picker', () => {
  const recent: RecentRepo[] = [
    { path: '/Users/me/src/legion', name: 'legion', lastUsedAt: 2 },
    { path: '/Users/me/src/web', name: 'web', lastUsedAt: 1 },
  ];
  const found: DiscoveredRepo[] = [
    { path: '/Users/me/src/legion', name: 'legion', branch: 'build/v1', dirty: true, lastCommitAt: 9 },
    { path: '/Users/me/Projects/api-gateway', name: 'api-gateway', branch: 'main', dirty: false, lastCommitAt: 8 },
    { path: '/Users/me/Projects/clients/acme-web', name: 'acme-web', branch: null, dirty: false, lastCommitAt: 7 },
  ];

  it('merges recent and discovered repos without duplicates, enriching recent rows', () => {
    const merged = mergeRepos(recent, found, ['/Users/me/work/current']);
    expect(merged.recent.map((r) => r.path)).toEqual([
      '/Users/me/work/current',
      '/Users/me/src/legion',
      '/Users/me/src/web',
    ]);
    expect(merged.recent[1]).toMatchObject({ branch: 'build/v1', dirty: true });
    // Discovery didn't see it: unknown, not "clean".
    expect(merged.recent[2]).toMatchObject({ branch: null, dirty: null });
    expect(merged.found.map((r) => r.name)).toEqual(['api-gateway', 'acme-web']);
  });

  it('shows Recent and Found on this Mac, with Browse… pinned last', () => {
    const { recent: r, found: f } = mergeRepos(recent, found);
    const view = buildRepoPickerView({ query: '', recent: r, found: f, home: HOME });
    expect(view.sections.map((s) => s.label)).toEqual(['Recent', 'Found on this Mac']);
    expect(view.options.map((o) => o.key)).toEqual([
      'recent:/Users/me/src/legion',
      'recent:/Users/me/src/web',
      'found:/Users/me/Projects/api-gateway',
      'found:/Users/me/Projects/clients/acme-web',
      'browse',
    ]);
    expect(view.repoCount).toBe(4);
  });

  it('filters by name or path, best name matches first', () => {
    const { recent: r, found: f } = mergeRepos(recent, found);
    const names = (query: string) =>
      buildRepoPickerView({ query, recent: r, found: f, home: HOME }).options.map((o) =>
        o.kind === 'repo' ? o.repo.name : o.kind,
      );
    expect(names('web')).toEqual(['web', 'acme-web', 'browse']);
    expect(names('clients')).toEqual(['acme-web', 'browse']);
    expect(names('proj api')).toEqual(['api-gateway', 'browse']);
    expect(names('zzz')).toEqual(['browse']);
    expect(matchScore(entry('/x/acme-web'), 'acme', HOME)).toBe(0);
    expect(matchScore(entry('/x/acme-web'), 'web', HOME)).toBe(1);
  });

  it('offers "Use <path>" for a typed path that is not already listed', () => {
    const { recent: r, found: f } = mergeRepos(recent, found);
    const view = buildRepoPickerView({ query: '~/scratch/new-thing/', recent: r, found: f, home: HOME });
    expect(view.options[0]).toEqual({
      kind: 'path',
      key: 'path:/Users/me/scratch/new-thing',
      path: '/Users/me/scratch/new-thing',
    });
    // An exact listed path doesn't get a duplicate row; the repo itself matches by path.
    const listed = buildRepoPickerView({ query: '~/src/legion', recent: r, found: f, home: HOME });
    expect(listed.options.map((o) => o.key)).toEqual(['recent:/Users/me/src/legion', 'browse']);
  });
});

describe('branch picker', () => {
  const branches = {
    current: 'feature/login',
    default: 'main',
    local: ['feature/login', 'main', 'wip'],
    remote: ['origin/main', 'origin/release/2.0', 'origin/wip'],
  };

  it('puts default and current first, then local, then remote-only', () => {
    expect(buildBranchOptions(branches, '').map((o) => [o.ref, o.kind, o.isDefault, o.isCurrent])).toEqual([
      ['main', 'local', true, false],
      ['feature/login', 'local', false, true],
      ['wip', 'local', false, false],
      ['origin/release/2.0', 'remote', false, false],
    ]);
  });

  it('filters, and offers a typed ref nobody has', () => {
    expect(buildBranchOptions(branches, 'REL').map((o) => o.ref)).toEqual(['origin/release/2.0', 'REL']);
    expect(buildBranchOptions(branches, 'v1.2.0').map((o) => o.kind)).toEqual(['custom']);
    expect(buildBranchOptions(branches, 'main').map((o) => o.ref)).toEqual(['main']);
    expect(buildBranchOptions(null, '').map((o) => o.ref)).toEqual([]);
  });
});

describe('keyboard model', () => {
  it('maps keys to list actions', () => {
    expect(listKeyAction({ key: 'ArrowDown' })).toBe('next');
    expect(listKeyAction({ key: 'ArrowUp' })).toBe('prev');
    expect(listKeyAction({ key: 'ArrowDown', altKey: true })).toBe('last');
    expect(listKeyAction({ key: 'PageUp' })).toBe('first');
    expect(listKeyAction({ key: 'Enter' })).toBe('choose');
    expect(listKeyAction({ key: 'Escape' })).toBe('close');
    expect(listKeyAction({ key: 'Tab' })).toBe('tab');
    expect(listKeyAction({ key: 'o', metaKey: true })).toBe('browse');
    // Home/End move the caret in the search field.
    expect(listKeyAction({ key: 'Home' })).toBeNull();
    expect(listKeyAction({ key: 'a' })).toBeNull();
    expect(listKeyAction({ key: 'Enter', metaKey: true })).toBeNull();
  });

  it('moves the active row with wrap-around', () => {
    expect(moveActive(0, 'next', 3)).toBe(1);
    expect(moveActive(2, 'next', 3)).toBe(0);
    expect(moveActive(0, 'prev', 3)).toBe(2);
    expect(moveActive(-1, 'next', 3)).toBe(0);
    expect(moveActive(-1, 'prev', 3)).toBe(2);
    expect(moveActive(1, 'last', 3)).toBe(2);
    expect(moveActive(1, 'first', 3)).toBe(0);
    expect(moveActive(0, 'next', 0)).toBe(-1);
  });

  it('opens from the trigger on Enter, Space and arrows', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) expect(opensPicker({ key })).toBe(true);
    expect(opensPicker({ key: 'Enter', metaKey: true })).toBe(false);
    expect(opensPicker({ key: 'a' })).toBe(false);
  });
});
