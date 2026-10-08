/**
 * Add a project (⌘⇧N): the composer's repository picker, inline — recent repositories and checkouts found on
 * this Mac, a typed or pasted path, Browse… (⌘O) or a folder dropped from Finder. Choosing one adds it and opens
 * its home; nothing asks for a prompt.
 */
import type { DiscoveredRepo, RecentRepo } from '@shared/rpc';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { rpc, useData } from '../app/hooks';
import { FILE_MANAGER } from '../app/platform';
import { addProject, openProject, pickFolder } from '../app/project-actions';
import { selectProjects } from '../app/projects';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
import { Glyph } from '../tiles/session/glyphs';
import {
  abbreviatePath,
  buildRepoPickerView,
  listKeyAction,
  mergeRepos,
  moveActive,
  pathFromFileUrl,
  type RepoOption,
} from './picker-model';
import { OverlayPanel } from './Shell';

/** Discovery is cached by the engine too; keep the last answer so reopening is instant. */
let lastFound: DiscoveredRepo[] | null = null;

type LegionWindow = Window & { legion?: { pathForFile?: (file: File) => string } };

function droppedPath(data: DataTransfer): string | null {
  const file = data.files[0];
  const fromFile = file ? ((window as LegionWindow).legion?.pathForFile?.(file) ?? '') : '';
  return fromFile || pathFromFileUrl(data.getData('text/uri-list'));
}

export function AddProjectOverlay() {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [found, setFound] = useState<DiscoveredRepo[]>(lastFound ?? []);
  const [discovering, setDiscovering] = useState(lastFound === null);
  const [home, setHome] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const projects = useData(selectProjects);

  useEffect(() => {
    let cancelled = false;
    rpc('repos.recent', {})
      .then((list) => !cancelled && setRecent(list))
      .catch(() => {});
    rpc('app.info', {})
      .then((info) => !cancelled && setHome(info.homeDir ?? null))
      .catch(() => {});
    rpc('repos.discover', {})
      .then((list) => {
        lastFound = list;
        if (!cancelled) setFound(list);
      })
      .catch(() => {})
      .finally(() => !cancelled && setDiscovering(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Projects already added are left out (choosing a path of one just opens it).
  const lists = useMemo(() => {
    const added = new Set(projects.map((p) => p.path));
    const merged = mergeRepos(recent, found);
    return {
      recent: merged.recent.filter((r) => !added.has(r.path)),
      found: merged.found.filter((r) => !added.has(r.path)),
    };
  }, [recent, found, projects]);
  const view = buildRepoPickerView({ query, recent: lists.recent, found: lists.found, home });
  const current = Math.min(active, view.options.length - 1);

  useEffect(() => {
    const option = view.options[current];
    if (!option) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${CSS.escape(`${listId}-${option.key}`)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current, view.options, listId]);

  const add = async (path: string) => {
    const existing = projects.find((p) => p.path === path);
    if (existing) {
      openProject(existing.id);
      return;
    }
    setBusy(path);
    setError(null);
    try {
      await addProject(path);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        /not a git repository/i.test(message)
          ? `${abbreviatePath(path, home)} is not a git repository. Run \`git init\` there, or pick another folder.`
          : message,
      );
    } finally {
      setBusy(null);
    }
  };

  const browse = async () => {
    const path = await pickFolder();
    if (path) await add(path);
  };

  const choose = (option: RepoOption | undefined) => {
    if (!option || busy) return;
    if (option.kind === 'browse') void browse();
    else void add(option.kind === 'repo' ? option.repo.path : option.path);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = listKeyAction(event);
    if (!action || action === 'tab' || action === 'close') return;
    event.preventDefault();
    if (action === 'choose') choose(view.options[current]);
    else if (action === 'browse') void browse();
    else setActive(moveActive(current, action, view.options.length));
  };

  const optionId = (option: RepoOption) => `${listId}-${option.key}`;
  const browseOption = view.options.at(-1) as RepoOption;

  return (
    <OverlayPanel label="Add a project" placement="center" width={620} top={104} testId="add-project">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for folders dragged from Finder */}
      <div
        className="ap"
        onDragEnter={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return;
          event.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'link';
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          const path = droppedPath(event.dataTransfer);
          if (path) void add(path);
        }}
      >
        <div className="addp-head">
          <span className="addp-title">Add a project</span>
          <span className="addp-sub">A repository you work in. You can browse it first and start runs whenever.</span>
        </div>
        <div className="pk-search addp-search">
          <Icon name="search" size={14} className="pk-search-icon" />
          <input
            className="pk-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={view.options[current] ? optionId(view.options[current] as RepoOption) : undefined}
            aria-label="Search repositories, or paste a path"
            placeholder="Search repositories, or paste a path…"
            value={query}
            data-autofocus
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            data-testid="add-project-input"
          />
          {discovering ? <span className="pk-busy" title="Looking for repositories…" /> : null}
        </div>
        {error ? (
          <div className="addp-error" role="alert" data-testid="add-project-error">
            <Icon name="alert" size={12} />
            {error}
          </div>
        ) : null}
        <div ref={listRef} id={listId} role="listbox" aria-label="Repositories" className="pk-list addp-list">
          {view.sections.map((section) => (
            // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group
            <div key={section.id} role="group" aria-label={section.label ?? 'Path'} className="pk-group">
              {section.label ? (
                <div className="pk-sec" aria-hidden="true">
                  {section.label}
                  {section.id === 'found' && discovering ? <span className="pk-sec-note">searching…</span> : null}
                </div>
              ) : null}
              {section.options.map((option) => {
                const index = view.options.indexOf(option);
                const path = option.kind === 'repo' ? option.repo.path : option.kind === 'path' ? option.path : '';
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input
                  <div
                    key={option.key}
                    id={optionId(option)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === current}
                    data-active={index === current}
                    data-busy={busy === path || undefined}
                    className="pk-row addp-row"
                    data-testid="add-project-option"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => index !== current && setActive(index)}
                    onClick={() => choose(option)}
                  >
                    {option.kind === 'repo' ? (
                      <>
                        <span className="pk-icon">
                          <Icon name="repo" size={14} />
                        </span>
                        <span className="pk-main">
                          <span className="pk-name">{option.repo.name}</span>
                          <span className="pk-path">{abbreviatePath(option.repo.path, home)}</span>
                        </span>
                        {option.repo.branch ? (
                          <span className="pk-branch mono">
                            <Glyph name="branch" size={11} />
                            <span className="pk-branch-name">{option.repo.branch}</span>
                          </span>
                        ) : null}
                        {option.repo.dirty !== null ? (
                          <span className="pk-state" data-dirty={option.repo.dirty} />
                        ) : (
                          <span className="pk-state" />
                        )}
                      </>
                    ) : (
                      <>
                        <span className="pk-icon pk-icon-accent">
                          <Icon name="folderPlus" size={14} />
                        </span>
                        <span className="pk-main">
                          <span className="pk-name">Add</span>
                          <span className="pk-path pk-path-strong mono">{abbreviatePath(path, home)}</span>
                        </span>
                      </>
                    )}
                    {busy === path ? <span className="pk-busy" /> : index === current ? <Kbd>⏎</Kbd> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {view.repoCount === 0 && !view.sections.some((s) => s.id === 'path') ? (
            <div className="pk-empty pk-empty-col">
              {discovering && !query ? (
                <span>Looking for repositories on this Mac…</span>
              ) : query ? (
                <>
                  <span>
                    No repositories match <span className="pk-q">“{query.trim()}”</span>
                  </span>
                  <span className="faint">Paste a full path (/… or ~/…), or browse for a folder.</span>
                </>
              ) : (
                <>
                  <span>No other repositories found</span>
                  <span className="faint">Browse for a folder, paste a path, or drop a folder onto this window.</span>
                </>
              )}
            </div>
          ) : null}
        </div>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input */}
        <div
          id={optionId(browseOption)}
          role="option"
          tabIndex={-1}
          aria-selected={current === view.options.length - 1}
          data-active={current === view.options.length - 1}
          className="pk-row pk-browse"
          data-testid="add-project-browse"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setActive(view.options.length - 1)}
          onClick={() => void browse()}
        >
          <span className="pk-icon">
            <Icon name="folder" size={14} />
          </span>
          <span className="pk-main">
            <span className="pk-name">Browse…</span>
            <span className="pk-path">Choose a folder in {FILE_MANAGER}</span>
          </span>
          <Kbd chord="Mod+O" />
        </div>
        <div className="ovl-foot">
          <span>↑↓ select</span>
          <span>⏎ add</span>
          <span>esc close</span>
          <span className="ovl-keys">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.closeOverlay()}>
              Cancel
            </button>
          </span>
        </div>
        {dragging ? (
          <div className="cmp-drop" data-testid="add-project-drop">
            <span className="cmp-drop-mark">
              <Icon name="folder" size={20} />
            </span>
            <span className="cmp-drop-title">Drop a folder to add it as a project</span>
            <span className="cmp-drop-sub">Any folder inside a git checkout works.</span>
          </div>
        ) : null}
      </div>
    </OverlayPanel>
  );
}
