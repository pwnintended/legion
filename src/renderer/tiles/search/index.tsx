/**
 * Search in the project (`git grep`): a query field with case and regex toggles, results grouped by file with
 * the match highlighted. ↑/↓ move through matches, ⏎ opens the file at the line (⌘⏎ in a new column).
 */
import type { SearchMatch, SearchResult } from '@shared/rpc';
import { useEffect, useMemo, useRef, useState } from 'react';
import { rpc, useUi } from '../../app/hooks';
import { openFile } from '../../app/project-actions';
import { projectWorkspaceKey } from '../../app/projects';
import { actions } from '../../app/store';
import { Icon } from '../../chrome/icons';
import { setTileParams } from '../../layout/tree';
import type { TileProps } from '../../layout/types';
import { FileIcon, HighlightQuery, splitPath } from '../project/kit';
import { useListNav } from '../project/list-nav';

const LIMIT = 500;

type State =
  | { status: 'idle' }
  | { status: 'loading'; previous: SearchResult | null }
  | { status: 'done'; result: SearchResult }
  | { status: 'error'; message: string };

export default function SearchTile({ tileId, params, focused }: TileProps<'search'>) {
  const { projectId } = params;
  const [query, setQuery] = useState(params.query);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [state, setState] = useState<State>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRequest = useUi((s) => s.focusRequest);

  // A query handed in (palette, ⌘⇧F with a selection) replaces the field.
  useEffect(() => setQuery(params.query), [params.query]);

  // Keyboard focus landing on the tile goes straight to the field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on each focus request
  useEffect(() => {
    if (!focused) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [focused, focusRequest]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState((s) => ({ status: 'loading', previous: s.status === 'done' ? s.result : null }));
    const timer = setTimeout(() => {
      rpc('files.search', { projectId, query: q, regex, caseSensitive, limit: LIMIT }).then(
        (result) => !cancelled && setState({ status: 'done', result }),
        (error: unknown) =>
          !cancelled && setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
      );
      // Remember the query in the layout (it survives a reload).
      actions.updateLayout(
        projectWorkspaceKey(projectId),
        (ws) => setTileParams(ws, tileId, { projectId, query }),
        false,
      );
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, tileId, query, regex, caseSensitive]);

  const result = state.status === 'done' ? state.result : state.status === 'loading' ? state.previous : null;
  const matches = result?.matches ?? [];
  const groups = useMemo(() => {
    const out: { path: string; items: { match: SearchMatch; index: number }[] }[] = [];
    matches.forEach((match, index) => {
      const last = out.at(-1);
      if (last?.path === match.path) last.items.push({ match, index });
      else out.push({ path: match.path, items: [{ match, index }] });
    });
    return out;
  }, [matches]);

  const open = (index: number, newColumn: boolean) => {
    const match = matches[index];
    if (match) openFile(projectId, match.path, { line: match.line, anchorTileId: tileId, newColumn });
  };
  const nav = useListNav(matches.length, open);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard navigation for the results (rows are buttons)
    <div className="sr" onKeyDown={nav.onKeyDown} data-testid="project-search">
      <div className="sr-field">
        <Icon name="search" size={14} className="sr-icon" />
        <input
          ref={inputRef}
          className="sr-input"
          value={query}
          placeholder="Search the project…"
          aria-label="Search the project"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            nav.setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
          data-testid="search-input"
        />
        <button
          type="button"
          className="sr-toggle mono"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          type="button"
          className="sr-toggle mono"
          aria-pressed={regex}
          title="Regular expression"
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>
      </div>
      <div className="sr-status" aria-live="polite" data-testid="search-status">
        {state.status === 'idle' ? (
          <span className="faint">Text or a regular expression · tracked and untracked files, ignores skipped</span>
        ) : state.status === 'error' ? (
          <span className="sr-error">{state.message}</span>
        ) : result ? (
          <span>
            {result.matches.length === 0
              ? 'No results'
              : `${result.truncated ? `${LIMIT}+` : result.matches.length} result${result.matches.length === 1 ? '' : 's'} in ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}`}
            {state.status === 'loading' ? <span className="sr-busy" /> : null}
          </span>
        ) : (
          <span className="faint">
            Searching… <span className="sr-busy" />
          </span>
        )}
      </div>
      <div className="sr-list" ref={nav.ref} role="listbox" aria-label="Search results">
        {groups.map((group) => {
          const { dir, name } = splitPath(group.path);
          return (
            <div key={group.path} className="sr-group">
              <div className="sr-file" title={group.path}>
                <FileIcon name={name} size={13} />
                <span className="sr-file-name">{name}</span>
                {dir ? <span className="sr-file-dir">{dir}</span> : null}
                <span className="sr-file-count">{group.items.length}</span>
              </div>
              {group.items.map(({ match, index }) => (
                <button
                  key={`${match.path}:${match.line}:${index}`}
                  type="button"
                  role="option"
                  aria-selected={nav.active === index}
                  className="sr-hit"
                  data-row={index}
                  data-active={nav.active === index}
                  data-testid="search-hit"
                  onClick={(event) => {
                    nav.setActive(index);
                    open(index, event.metaKey || event.ctrlKey);
                  }}
                >
                  <span className="sr-ln mono">{match.line}</span>
                  <span className="sr-text mono">
                    {match.clipStart > 0 ? '…' : ''}
                    <HighlightQuery
                      text={match.text.trimStart()}
                      query={query.trim()}
                      regex={regex}
                      caseSensitive={caseSensitive}
                    />
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
