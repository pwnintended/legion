/**
 * The project's file tree: git-tracked and untracked-not-ignored files, loaded one directory at a time,
 * filterable (fuzzy, over the whole project) and fully keyboard driven: ↑/↓ or j/k move, → expands / steps in,
 * ← collapses / steps out, ⏎ or space opens in the viewer (⌘⏎ as a pinned tab), typing filters. The file
 * shown in the viewer is marked. Lives in the Code view's side panel.
 */
import type { FileEntry, FileList, FileMatch } from '@shared/rpc';
import { useEffect, useMemo, useRef, useState } from 'react';
import { commandTooltip } from '../../app/commands';
import { rpc } from '../../app/hooks';
import { openFile } from '../../app/project-actions';
import { fetchQuery, isStale, peekQuery, useQueryVersion } from '../../app/query';
import { Icon } from '../../chrome/icons';
import { Kbd } from '../../chrome/ui';
import { useShownTab } from '../../code/hooks';
import type { TileProps } from '../../layout/types';
import { FileIcon, formatBytes, HighlightPositions, splitPath } from '../project/kit';
import { useListNav } from '../project/list-nav';

/** Expanded directories per project and checkout (kept while the app runs, so the tree survives re-mounts). */
const expandedByProject = new Map<string, Set<string>>();

type TreeRow =
  | { kind: 'entry'; entry: FileEntry; depth: number }
  | { kind: 'loading'; dir: string; depth: number }
  | { kind: 'error'; dir: string; depth: number; message: string };

const dirKey = (projectId: string, checkout: string | null, dir: string) => `dir:${projectId}:${checkout ?? ''}:${dir}`;
/** Agents add and remove files while you look: the open directories are read again this often. */
const DIR_STALE_MS = 4_000;

function loadDir(projectId: string, checkout: string | null, dir: string, force = false): void {
  const key = dirKey(projectId, checkout, dir);
  if (force || isStale(key, DIR_STALE_MS))
    void fetchQuery(key, () => rpc('files.list', { projectId, checkout, dir })).catch(() => {});
}

/** The visible rows of the tree (root + expanded directories), from the query cache. */
function flatten(projectId: string, checkout: string | null, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const entry = peekQuery<FileList>(dirKey(projectId, checkout, dir));
    if (!entry?.data) {
      if (entry?.error) rows.push({ kind: 'error', dir, depth, message: entry.error });
      else rows.push({ kind: 'loading', dir, depth });
      return;
    }
    for (const item of entry.data.entries) {
      rows.push({ kind: 'entry', entry: item, depth });
      if (item.type === 'dir' && expanded.has(item.path)) walk(item.path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export default function FilesTile({ params, focused, visible }: TileProps<'files'>) {
  const { projectId } = params;
  const checkout = params.checkout ?? null;
  const treeKey = `${projectId}:${checkout ?? ''}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedByProject.get(treeKey) ?? new Set());
  const [filter, setFilter] = useState('');
  const [matches, setMatches] = useState<FileMatch[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const version = useQueryVersion();
  const openPath = useShownTab(projectId, (tab) => (tab.kind === 'code' ? tab.params.path : null));

  useEffect(() => {
    expandedByProject.set(treeKey, expanded);
    loadDir(projectId, checkout, '');
    for (const dir of expanded) loadDir(projectId, checkout, dir);
  }, [projectId, checkout, treeKey, expanded]);

  // Live: while on screen, the open directories are read again (new files from agents appear on their own).
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      loadDir(projectId, checkout, '');
      for (const dir of expanded) loadDir(projectId, checkout, dir);
    }, DIR_STALE_MS);
    return () => clearInterval(timer);
  }, [visible, projectId, checkout, expanded]);

  // Filtering searches the whole project (debounced), not just the expanded directories.
  useEffect(() => {
    const query = filter.trim();
    if (!query) {
      setMatches(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc('files.find', { projectId, checkout, query, limit: 200 }).then(
        (found) => !cancelled && setMatches(found),
        () => !cancelled && setMatches([]),
      );
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, checkout, filter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads the query cache.
  const rows = useMemo(() => flatten(projectId, checkout, expanded), [projectId, checkout, expanded, version]);
  const filtering = matches !== null;
  const count = filtering ? matches.length : rows.length;

  const toggle = (path: string, open?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      const want = open ?? !next.has(path);
      if (want) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const openEntry = (path: string, pinned: boolean) => openFile(projectId, path, { pinned });

  const activate = (index: number, pinned: boolean) => {
    if (filtering) {
      const match = matches[index];
      if (match) openEntry(match.path, pinned);
      return;
    }
    const row = rows[index];
    if (row?.kind !== 'entry') return;
    if (row.entry.type === 'dir') toggle(row.entry.path);
    else openEntry(row.entry.path, pinned);
  };

  const nav = useListNav(count, activate, (event, active) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const typing = event.target === inputRef.current;
    if (event.key === 'Escape' && filter) {
      event.preventDefault();
      event.stopPropagation();
      setFilter('');
      return true;
    }
    if (typing || filtering) return false;
    const row = rows[active];
    if (event.key === ' ' && row?.kind === 'entry') {
      event.preventDefault();
      activate(active, false);
      return true;
    }
    if (event.key === 'ArrowRight' && row?.kind === 'entry' && row.entry.type === 'dir') {
      event.preventDefault();
      if (!expanded.has(row.entry.path)) toggle(row.entry.path, true);
      else if (rows[active + 1]?.depth === row.depth + 1) nav.setActive(active + 1);
      return true;
    }
    if (event.key === 'ArrowLeft' && row) {
      event.preventDefault();
      if (row.kind === 'entry' && row.entry.type === 'dir' && expanded.has(row.entry.path))
        toggle(row.entry.path, false);
      else {
        const parent = row.kind === 'entry' ? parentOf(row.entry.path) : row.dir;
        const index = rows.findIndex((r) => r.kind === 'entry' && r.entry.path === parent);
        if (index !== -1) nav.setActive(index);
      }
      return true;
    }
    // Type to filter.
    if (event.key.length === 1 && /[\w.\-/]/.test(event.key)) {
      event.preventDefault();
      setFilter((f) => f + event.key);
      inputRef.current?.focus();
      return true;
    }
    return false;
  });

  // Reveal the open file in the tree (expand its parents) when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the open file changes
  useEffect(() => {
    if (!openPath) return;
    const parents: string[] = [];
    for (let dir = parentOf(openPath); dir; dir = parentOf(dir)) parents.push(dir);
    if (parents.every((p) => expanded.has(p))) return;
    setExpanded((current) => new Set([...current, ...parents]));
  }, [openPath]);

  // ⌘F inside the files tile focuses the filter.
  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'f' && event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard navigation for the tree (rows are buttons)
    <div className="ft" onKeyDown={nav.onKeyDown} data-testid="project-files">
      <div className="ft-filter">
        <Icon name="search" size={13} className="ft-filter-icon" />
        <input
          ref={inputRef}
          className="ft-input"
          value={filter}
          placeholder="Filter files…"
          aria-label="Filter files"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setFilter(event.target.value);
            nav.setActive(0);
          }}
          data-testid="files-filter"
        />
        {filter ? (
          <button type="button" className="ft-clear" aria-label="Clear filter" onClick={() => setFilter('')}>
            <Icon name="close" size={11} />
          </button>
        ) : (
          <span className="ft-hint" title={commandTooltip('file.goto')}>
            <Kbd>⌘P</Kbd>
          </span>
        )}
      </div>
      <div className="ft-list" ref={nav.ref} role="tree" aria-label="Files">
        {filtering ? (
          matches.length === 0 ? (
            <div className="ft-empty">
              No files match <span className="mono">“{filter.trim()}”</span>
            </div>
          ) : (
            matches.map((match, index) => {
              const { dir, name } = splitPath(match.path);
              return (
                <button
                  key={match.path}
                  type="button"
                  role="treeitem"
                  className="ft-row ft-match"
                  data-row={index}
                  data-active={nav.active === index}
                  data-open={match.path === openPath}
                  onClick={(event) => {
                    nav.setActive(index);
                    openEntry(match.path, event.metaKey || event.ctrlKey);
                  }}
                  title={match.path}
                >
                  <FileIcon name={name} size={13} />
                  <span className="ft-name">
                    <HighlightPositions
                      text={name}
                      positions={match.positions}
                      offset={match.path.length - name.length}
                    />
                  </span>
                  {dir ? (
                    <span className="ft-dir">
                      <HighlightPositions text={dir} positions={match.positions.filter((p) => p < dir.length)} />
                    </span>
                  ) : null}
                </button>
              );
            })
          )
        ) : (
          rows.map((row, index) => {
            if (row.kind !== 'entry') {
              return (
                <div
                  key={`${row.kind}:${row.dir}`}
                  className="ft-row ft-note"
                  data-row={index}
                  style={{ '--depth': row.depth } as React.CSSProperties}
                >
                  {row.kind === 'loading' ? (
                    <span className="ft-loading" />
                  ) : (
                    <span className="faint">{row.message}</span>
                  )}
                </div>
              );
            }
            const { entry } = row;
            const isDir = entry.type === 'dir';
            const open = isDir && expanded.has(entry.path);
            return (
              <button
                key={entry.path}
                type="button"
                role="treeitem"
                aria-expanded={isDir ? open : undefined}
                aria-level={row.depth + 1}
                className="ft-row"
                data-row={index}
                data-active={nav.active === index}
                data-open={entry.path === openPath}
                data-kind={entry.type}
                data-testid="file-row"
                data-path={entry.path}
                style={{ '--depth': row.depth } as React.CSSProperties}
                onClick={(event) => {
                  nav.setActive(index);
                  if (isDir) toggle(entry.path);
                  else openEntry(entry.path, event.metaKey || event.ctrlKey);
                }}
                title={entry.type === 'symlink' ? `${entry.path} (symlink)` : entry.path}
              >
                <span className="ft-twisty" aria-hidden="true">
                  {isDir ? <Icon name="chevronRight" size={11} strokeWidth={2.4} data-open={open} /> : null}
                </span>
                {isDir ? (
                  <Icon name={open ? 'folderOpen' : 'folder'} size={14} className="ft-folder" />
                ) : entry.type === 'symlink' ? (
                  <Icon name="link" size={13} className="faint" />
                ) : (
                  <FileIcon name={entry.name} size={13} />
                )}
                <span className="ft-name">{entry.name}</span>
                {entry.size !== null ? <span className="ft-size">{formatBytes(entry.size)}</span> : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
