/**
 * Go to file (⌘P): fuzzy search over every file of the project on screen. `path:42` jumps to a line. ⏎ opens in
 * the code viewer's preview column, ⌘⏎ in a new column. With nothing typed: the files opened recently.
 */
import type { FileMatch } from '@shared/rpc';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { rpc, useUi } from '../app/hooks';
import { currentProject, openFile, recentFiles } from '../app/project-actions';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
import { FileIcon, HighlightPositions, splitPath } from '../tiles/project/kit';
import { OverlayPanel } from './Shell';

/** `src/a.ts:12` → query `src/a.ts`, line 12. */
export function parseGoto(input: string): { query: string; line: number | null } {
  const match = /^(.*?):(\d+)(?::\d+)?\s*$/.exec(input.trim());
  if (match?.[1] && match[2]) return { query: match[1], line: Number(match[2]) };
  return { query: input.trim(), line: null };
}

export function GoToFileOverlay() {
  const listId = useId();
  const project = useUi(() => currentProject());
  const [input, setInput] = useState('');
  const [results, setResults] = useState<FileMatch[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { query, line } = parseGoto(input);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        rpc('files.find', { projectId, query, limit: 60 }).then(
          (found) => !cancelled && setResults(found),
          () => !cancelled && setResults([]),
        );
      },
      query ? 50 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, query]);

  const items = useMemo(() => {
    if (!projectId) return [];
    if (query) return results ?? [];
    const recents = recentFiles(projectId).map((path) => ({ path, score: 0, positions: [] }));
    const rest = (results ?? []).filter((r) => !recents.some((x) => x.path === r.path));
    return [...recents, ...rest].slice(0, 60);
  }, [projectId, query, results]);
  const recentCount = query || !projectId ? 0 : recentFiles(projectId).length;
  const current = Math.min(active, items.length - 1);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const open = (index: number, newColumn: boolean) => {
    const item = items[index];
    if (!item || !projectId) return;
    actions.closeOverlay();
    openFile(projectId, item.path, { line, newColumn });
  };

  return (
    <OverlayPanel label="Go to file" placement="center" width={620} top={96} testId="goto-file">
      <div className="pal-input-row">
        <Icon name="file" size={16} className="pal-search" />
        <input
          className="pal-input"
          value={input}
          data-autofocus
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-label="Go to file"
          placeholder={project ? `Go to a file in ${project.name}…  (path:line jumps to a line)` : 'No project open'}
          onChange={(event) => {
            setInput(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
              event.preventDefault();
              setActive(Math.min(items.length - 1, current + 1));
            } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
              event.preventDefault();
              setActive(Math.max(0, current - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              open(current, event.metaKey || event.ctrlKey);
            }
          }}
          data-testid="goto-input"
        />
        {line ? <span className="chip chip-accent mono">line {line}</span> : null}
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Files" className="pal-list gt-list">
        {items.length === 0 ? (
          <div className="pal-empty">{results === null ? 'Indexing files…' : 'No matching files.'}</div>
        ) : (
          items.map((item, index) => {
            const { dir, name } = splitPath(item.path);
            const offset = item.path.length - name.length;
            return (
              <div key={item.path}>
                {index === 0 && recentCount > 0 ? <div className="gt-sec">Recently opened</div> : null}
                {index === recentCount && recentCount > 0 ? <div className="gt-sec">Files</div> : null}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the input (combobox) */}
                <div
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  data-selected={index === current}
                  data-index={index}
                  className="pal-item gt-item"
                  data-testid="goto-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => index !== current && setActive(index)}
                  onClick={(event) => open(index, event.metaKey || event.ctrlKey)}
                >
                  <FileIcon name={name} size={14} />
                  <span className="gt-name">
                    <HighlightPositions text={name} positions={item.positions} offset={offset} />
                  </span>
                  <span className="gt-dir">
                    <HighlightPositions text={dir} positions={item.positions.filter((p) => p < dir.length)} />
                  </span>
                  {index === current ? <Kbd>⏎</Kbd> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="ovl-foot">
        <span>↑↓ select</span>
        <span>⏎ open</span>
        <span>⌘⏎ new column</span>
        <span>esc close</span>
      </div>
    </OverlayPanel>
  );
}
