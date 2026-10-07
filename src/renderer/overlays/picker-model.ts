/**
 * Pure models behind the composer's repository and base-branch pickers: path helpers, filtering and
 * sectioning, and the keyboard model. No React here so it can be unit tested.
 */
import type { DiscoveredRepo, RecentRepo, RepoBranches } from '@shared/rpc';

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** `/Users/me/src/app` → `~/src/app` when under `home`. */
export function abbreviatePath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  if (path === h) return '~';
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** Does the text look like a filesystem path the user typed or pasted (`/…`, `~`, `~/…`)? */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  return t.startsWith('/') || t === '~' || t.startsWith('~/');
}

/**
 * An absolute, normalised path from typed text (`~` expanded, quotes from a Finder copy and trailing
 * slashes removed), or null when it isn't one.
 */
export function expandPath(text: string, home: string | null | undefined): string | null {
  let t = text.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1).trim();
  // Shell-escaped spaces from a Terminal copy.
  t = t.replace(/\\ /g, ' ');
  if (t === '~' || t.startsWith('~/')) {
    if (!home) return null;
    t = home.replace(/\/$/, '') + t.slice(1);
  }
  if (!t.startsWith('/')) return null;
  t = t.replace(/\/{2,}/g, '/');
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

/** A filesystem path from a `file://` URL (Finder drags carry one in `text/uri-list`). */
export function pathFromFileUrl(uriList: string): string | null {
  const line = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line?.startsWith('file://')) return null;
  try {
    const path = decodeURIComponent(new URL(line).pathname);
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  } catch {
    return null;
  }
}

/** The last path segment, for a display name. */
export function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

// ---------------------------------------------------------------------------------------------
// Repository picker
// ---------------------------------------------------------------------------------------------

export interface RepoEntry {
  path: string;
  name: string;
  branch: string | null;
  /** null = not known (a recent repo discovery didn't reach). */
  dirty: boolean | null;
  lastCommitAt: number | null;
}

export type RepoOption =
  | { kind: 'repo'; key: string; section: 'recent' | 'found'; repo: RepoEntry }
  | { kind: 'path'; key: string; path: string }
  | { kind: 'browse'; key: 'browse' };

export interface RepoSection {
  id: 'path' | 'recent' | 'found';
  /** Heading; null for the "Use <path>" row. */
  label: string | null;
  options: RepoOption[];
}

export interface RepoPickerView {
  sections: RepoSection[];
  /** Every option in display order, Browse… last: the keyboard model indexes this. */
  options: RepoOption[];
  /** Count of repo rows (0 → the empty state). */
  repoCount: number;
}

/** Recent repos (enriched with what discovery knows) and discovered repos that aren't recent. */
export function mergeRepos(
  recent: readonly RecentRepo[],
  found: readonly DiscoveredRepo[],
  extra: readonly string[] = [],
): { recent: RepoEntry[]; found: RepoEntry[] } {
  const byPath = new Map(found.map((f) => [f.path, f]));
  const recentEntries: RepoEntry[] = [];
  const seen = new Set<string>();
  // Paths in use (the active run's repo, the current selection) lead the recent list if they aren't in it.
  for (const path of extra) {
    if (seen.has(path) || recent.some((r) => r.path === path)) continue;
    seen.add(path);
    const f = byPath.get(path);
    recentEntries.push({
      path,
      name: f?.name ?? baseName(path),
      branch: f?.branch ?? null,
      dirty: f ? f.dirty : null,
      lastCommitAt: f?.lastCommitAt ?? null,
    });
  }
  for (const r of recent) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    const f = byPath.get(r.path);
    recentEntries.push({
      path: r.path,
      name: r.name || baseName(r.path),
      branch: f?.branch ?? null,
      dirty: f ? f.dirty : null,
      lastCommitAt: f?.lastCommitAt ?? null,
    });
  }
  const foundEntries = found
    .filter((f) => !seen.has(f.path))
    .map((f) => ({ path: f.path, name: f.name, branch: f.branch, dirty: f.dirty, lastCommitAt: f.lastCommitAt }));
  return { recent: recentEntries, found: foundEntries };
}

/**
 * How well `entry` matches every whitespace-separated term (lower is better), or null if a term misses.
 * A term hits the name (prefix best), the `~/` path, or the full path.
 */
export function matchScore(entry: RepoEntry, query: string, home: string | null | undefined): number | null {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const name = entry.name.toLowerCase();
  const short = abbreviatePath(entry.path, home).toLowerCase();
  const full = entry.path.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.startsWith(term)) score += 0;
    else if (name.includes(term)) score += 1;
    else if (short.includes(term) || full.includes(term)) score += 3;
    else return null;
  }
  return score;
}

function filterEntries(entries: readonly RepoEntry[], query: string, home: string | null | undefined): RepoEntry[] {
  if (!query.trim()) return [...entries];
  return entries
    .map((entry, index) => ({ entry, index, score: matchScore(entry, query, home) }))
    .filter((x): x is { entry: RepoEntry; index: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.entry);
}

export function buildRepoPickerView(input: {
  query: string;
  recent: readonly RepoEntry[];
  found: readonly RepoEntry[];
  home: string | null | undefined;
}): RepoPickerView {
  const { query, home } = input;
  const sections: RepoSection[] = [];
  const typedPath = looksLikePath(query) ? expandPath(query, home) : null;
  const all = [...input.recent, ...input.found];
  if (typedPath && !all.some((r) => r.path === typedPath)) {
    sections.push({ id: 'path', label: null, options: [{ kind: 'path', key: `path:${typedPath}`, path: typedPath }] });
  }
  const recent = filterEntries(input.recent, query, home);
  const found = filterEntries(input.found, query, home);
  if (recent.length > 0) {
    sections.push({
      id: 'recent',
      label: 'Recent',
      options: recent.map((repo) => ({ kind: 'repo', key: `recent:${repo.path}`, section: 'recent', repo })),
    });
  }
  if (found.length > 0) {
    sections.push({
      id: 'found',
      label: 'Found on this Mac',
      options: found.map((repo) => ({ kind: 'repo', key: `found:${repo.path}`, section: 'found', repo })),
    });
  }
  const options: RepoOption[] = [...sections.flatMap((s) => s.options), { kind: 'browse', key: 'browse' }];
  return { sections, options, repoCount: recent.length + found.length };
}

// ---------------------------------------------------------------------------------------------
// Base-branch picker
// ---------------------------------------------------------------------------------------------

export interface BranchOption {
  key: string;
  /** The ref to use as the base (`main`, `origin/release`, or whatever was typed). */
  ref: string;
  kind: 'local' | 'remote' | 'custom';
  isDefault: boolean;
  isCurrent: boolean;
}

/**
 * Default branch first, then the current one, then other local branches, then remote-only branches; filtered
 * by substring. A typed ref that matches nothing exactly is offered as "Use <ref>" (tags, SHAs, ...).
 */
export function buildBranchOptions(branches: RepoBranches | null, query: string): BranchOption[] {
  const q = query.trim();
  const ql = q.toLowerCase();
  const local = branches?.local ?? [];
  const def = branches?.default ?? null;
  const current = branches?.current ?? null;
  const ordered: { ref: string; kind: 'local' | 'remote' }[] = [];
  const push = (ref: string, kind: 'local' | 'remote') => {
    if (!ordered.some((o) => o.ref === ref)) ordered.push({ ref, kind });
  };
  if (def) push(def, local.includes(def) || !def.includes('/') ? 'local' : 'remote');
  if (current) push(current, 'local');
  for (const b of local) push(b, 'local');
  for (const r of branches?.remote ?? []) {
    const short = r.slice(r.indexOf('/') + 1);
    if (!local.includes(short) && short !== def) push(r, 'remote');
  }
  const options: BranchOption[] = ordered
    .filter((o) => !ql || o.ref.toLowerCase().includes(ql))
    .map((o) => ({
      key: `${o.kind}:${o.ref}`,
      ref: o.ref,
      kind: o.kind,
      isDefault: o.ref === def,
      isCurrent: o.ref === current,
    }));
  if (q && !/\s/.test(q) && !ordered.some((o) => o.ref === q)) {
    options.push({ key: `custom:${q}`, ref: q, kind: 'custom', isDefault: false, isCurrent: false });
  }
  return options;
}

// ---------------------------------------------------------------------------------------------
// Keyboard model (shared by both pickers)
// ---------------------------------------------------------------------------------------------

export type ListKeyAction = 'next' | 'prev' | 'first' | 'last' | 'choose' | 'close' | 'browse' | 'tab';

/** What a key does inside an open picker (null: let the input have it). */
export function listKeyAction(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): ListKeyAction | null {
  const mod = !!(event.metaKey || event.ctrlKey);
  if (mod && event.key.toLowerCase() === 'o') return 'browse';
  if (mod) return null;
  switch (event.key) {
    case 'ArrowDown':
      return event.altKey ? 'last' : 'next';
    case 'ArrowUp':
      return event.altKey ? 'first' : 'prev';
    case 'PageDown':
    case 'End':
      return event.key === 'End' && !event.altKey ? null : 'last';
    case 'PageUp':
    case 'Home':
      return event.key === 'Home' && !event.altKey ? null : 'first';
    case 'Enter':
      return 'choose';
    case 'Escape':
      return 'close';
    case 'Tab':
      return 'tab';
    default:
      return null;
  }
}

/** Apply a navigation action to the active index (wraps around for next/prev; -1 = nothing active). */
export function moveActive(active: number, action: 'next' | 'prev' | 'first' | 'last', count: number): number {
  if (count <= 0) return -1;
  switch (action) {
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return active < 0 ? 0 : (active + 1) % count;
    case 'prev':
      return active < 0 ? count - 1 : (active - 1 + count) % count;
  }
}

/** Does a key on the closed trigger open the picker? (Enter, Space, ↓, ↑, Alt+↓) */
export function opensPicker(event: { key: string; metaKey?: boolean; ctrlKey?: boolean }): boolean {
  if (event.metaKey || event.ctrlKey) return false;
  return event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp';
}
