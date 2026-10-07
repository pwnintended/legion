/**
 * Combobox popovers for the composer: the repository picker (search, Recent / Found on this Mac, typed paths,
 * Browse… ⌘O) and the base-branch picker. The list renders into the overlay layer (a portal) so the panel's
 * scroll box can't clip it; it owns its plain keys (`data-local-keys`), so Esc closes the list and not the
 * composer. Keyboard: ↑/↓ move, ⌥↑/⌥↓ jump, ⏎ choose, Esc close, Tab leaves.
 */
import type { RepoBranches } from '@shared/rpc';
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
import { Glyph } from '../tiles/session/glyphs';
import {
  abbreviatePath,
  type BranchOption,
  buildBranchOptions,
  buildRepoPickerView,
  listKeyAction,
  moveActive,
  opensPicker,
  type RepoEntry,
  type RepoOption,
} from './picker-model';

// ---------------------------------------------------------------------------------------------
// Popover shell
// ---------------------------------------------------------------------------------------------

interface Placement {
  left: number;
  width: number;
  top: number | null;
  bottom: number | null;
  maxHeight: number;
}

const GAP = 6;
const MARGIN = 12;

/** Below the anchor, or above when there's clearly more room there; width ≥ minWidth, inside the window. */
function place(anchor: DOMRect, minWidth: number, idealHeight: number): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(anchor.width, minWidth), vw - MARGIN * 2);
  const left = Math.min(Math.max(anchor.left, MARGIN), vw - MARGIN - width);
  const below = vh - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  if (below >= Math.min(idealHeight, 280) || below >= above) {
    return {
      left,
      width,
      top: anchor.bottom + GAP,
      bottom: null,
      maxHeight: Math.max(160, Math.min(idealHeight, below)),
    };
  }
  return {
    left,
    width,
    top: null,
    bottom: vh - anchor.top + GAP,
    maxHeight: Math.max(160, Math.min(idealHeight, above)),
  };
}

function Popover({
  anchor,
  minWidth,
  idealHeight,
  onDismiss,
  children,
  testId,
}: {
  anchor: HTMLElement;
  minWidth: number;
  idealHeight: number;
  onDismiss: () => void;
  children: ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement>(() => place(anchor.getBoundingClientRect(), minWidth, idealHeight));

  useLayoutEffect(() => {
    const update = () => setPos(place(anchor.getBoundingClientRect(), minWidth, idealHeight));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor, minWidth, idealHeight]);

  // A press anywhere else closes the list (without taking focus away from where the press lands).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || anchor.contains(target))) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [anchor, onDismiss]);

  const host = anchor.closest<HTMLElement>('[data-overlay-root]') ?? document.body;
  return createPortal(
    <div
      ref={ref}
      className="pk"
      data-local-keys
      data-testid={testId}
      data-side={pos.top === null ? 'top' : 'bottom'}
      style={{
        left: pos.left,
        width: pos.width,
        top: pos.top ?? undefined,
        bottom: pos.bottom ?? undefined,
        maxHeight: pos.maxHeight,
      }}
    >
      {children}
    </div>,
    host,
  );
}

/** Keep the active row in view as the keyboard moves it. */
function useScrollActive(listRef: React.RefObject<HTMLElement | null>, activeId: string | undefined) {
  useLayoutEffect(() => {
    if (!activeId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [listRef, activeId]);
}

function SearchRow({
  inputRef,
  value,
  onChange,
  placeholder,
  listId,
  activeId,
  onKeyDown,
  label,
  trailing,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  listId: string;
  activeId: string | undefined;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="pk-search">
      <Icon name="search" size={14} className="pk-search-icon" />
      <input
        ref={inputRef}
        className="pk-input"
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {trailing}
    </div>
  );
}

/** Shared open/close + keyboard plumbing for a trigger button and its list. */
function usePickerState<T extends { key: string }>(
  options: T[],
  initialKey: string | null,
  query: string,
  setQuery: (query: string) => void,
) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openList = useCallback(() => {
    setQuery('');
    setOpen(true);
  }, [setQuery]);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  // On open: focus the search field and start on the current value.
  const initialRef = useRef(initialKey);
  initialRef.current = initialKey;
  useLayoutEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Typing resets the active row to the best match; opening starts on the current value.
  const keys = options.map((o) => o.key).join('\n');
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the option set (keys) or query changes
  useLayoutEffect(() => {
    if (!open) return;
    const list = optionsRef.current;
    const current = query ? -1 : list.findIndex((o) => o.key === initialRef.current);
    setActive(current >= 0 ? current : list.length > 0 ? 0 : -1);
  }, [open, query, keys]);

  return { open, openList, close, active, setActive, triggerRef, inputRef };
}

// ---------------------------------------------------------------------------------------------
// Repository picker
// ---------------------------------------------------------------------------------------------

export interface RepoPickerProps {
  id: string;
  value: string | null;
  /** Display name for the value when it isn't in the lists yet. */
  valueName: string | null;
  home: string | null;
  recent: RepoEntry[];
  found: RepoEntry[];
  discovering: boolean;
  invalid: boolean;
  describedBy?: string;
  onChange: (path: string) => void;
  onBrowse: () => void;
}

function DirtyMark({ dirty }: { dirty: boolean | null }) {
  if (dirty === null) return <span className="pk-state" />;
  return (
    <span
      className="pk-state"
      data-dirty={dirty}
      title={dirty ? 'Uncommitted changes (Legion leaves them alone)' : 'Clean working tree'}
      role="img"
      aria-label={dirty ? 'uncommitted changes' : 'clean'}
    />
  );
}

function RepoRow({ repo, home, selected }: { repo: RepoEntry; home: string | null; selected: boolean }) {
  return (
    <>
      <span className="pk-icon">
        <Icon name="repo" size={14} />
      </span>
      <span className="pk-main">
        <span className="pk-name">{repo.name}</span>
        <span className="pk-path" title={repo.path}>
          {abbreviatePath(repo.path, home)}
        </span>
      </span>
      {repo.branch ? (
        <span className="pk-branch mono" title={`On ${repo.branch}`}>
          <Glyph name="branch" size={11} />
          <span className="pk-branch-name">{repo.branch}</span>
        </span>
      ) : null}
      <DirtyMark dirty={repo.dirty} />
      <span className="pk-check">{selected ? <Icon name="check" size={13} strokeWidth={2.4} /> : null}</span>
    </>
  );
}

export function RepoPicker(props: RepoPickerProps) {
  const { value, home, recent, found, discovering } = props;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const view = buildRepoPickerView({ query, recent, found, home });
  const valueKey = value ? (view.options.find((o) => o.kind === 'repo' && o.repo.path === value)?.key ?? null) : null;
  const s = usePickerState(view.options, valueKey, query, setQuery);

  const optionId = (o: RepoOption) => `${listId}-${o.key}`;
  const activeOption = view.options[s.active];
  const activeId = activeOption ? optionId(activeOption) : undefined;
  useScrollActive(listRef, activeId);

  const choose = (option: RepoOption | undefined) => {
    if (!option) return;
    if (option.kind === 'browse') {
      s.close(true);
      props.onBrowse();
      return;
    }
    props.onChange(option.kind === 'repo' ? option.repo.path : option.path);
    s.close(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = listKeyAction(event);
    if (!action) return;
    if (action === 'tab') {
      s.close(false);
      // Focus goes back to the trigger, and the browser's Tab moves on from there.
      s.triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === 'close') s.close(true);
    else if (action === 'choose') choose(activeOption);
    else if (action === 'browse') choose({ kind: 'browse', key: 'browse' });
    else s.setActive(moveActive(s.active, action, view.options.length));
  };

  const selected = value ? [...recent, ...found].find((r) => r.path === value) : null;
  const name = selected?.name ?? props.valueName;

  let empty: ReactNode = null;
  if (view.repoCount === 0 && !view.sections.some((sec) => sec.id === 'path')) {
    if (discovering && !query) {
      empty = (
        <div className="pk-empty">
          <span className="dot live" style={{ color: 'var(--mauve)', width: 6, height: 6 }} />
          Looking for repositories on this Mac…
        </div>
      );
    } else if (query) {
      empty = (
        <div className="pk-empty pk-empty-col">
          <span>
            No repositories match <span className="pk-q">“{query.trim()}”</span>
          </span>
          <span className="faint">Paste a full path (/… or ~/…), or browse for a folder.</span>
        </div>
      );
    } else {
      empty = (
        <div className="pk-empty pk-empty-col">
          <span>No repositories found yet</span>
          <span className="faint">
            Browse for a folder, paste a path, or drop a folder from Finder onto this window.
          </span>
        </div>
      );
    }
  }

  return (
    <>
      <button
        ref={s.triggerRef}
        id={props.id}
        type="button"
        className="field pk-trigger"
        data-testid="repo-picker"
        data-open={s.open}
        aria-haspopup="listbox"
        aria-expanded={s.open}
        aria-controls={s.open ? listId : undefined}
        aria-invalid={props.invalid}
        aria-describedby={props.describedBy}
        title={value ?? undefined}
        onClick={() => (s.open ? s.close(false) : s.openList())}
        onKeyDown={(event) => {
          if (!s.open && opensPicker(event)) {
            event.preventDefault();
            s.openList();
          }
        }}
      >
        <span className="pk-trigger-icon">
          <Icon name="repo" size={14} />
        </span>
        {value ? (
          <span className="pk-trigger-text">
            <span className="pk-trigger-name">{name}</span>
            <span className="pk-trigger-path">{abbreviatePath(value, home)}</span>
          </span>
        ) : (
          <span className="pk-trigger-text pk-placeholder">Choose a repository…</span>
        )}
        <Icon name="chevronUpDown" size={13} className="pk-chevron" />
      </button>
      {s.open && s.triggerRef.current ? (
        <Popover
          anchor={s.triggerRef.current}
          minWidth={500}
          idealHeight={420}
          onDismiss={() => s.close(false)}
          testId="repo-picker-list"
        >
          <SearchRow
            inputRef={s.inputRef}
            value={query}
            onChange={setQuery}
            placeholder="Search repositories, or paste a path…"
            label="Search repositories"
            listId={listId}
            activeId={activeId}
            onKeyDown={onKeyDown}
            trailing={discovering ? <span className="pk-busy" title="Looking for repositories…" /> : null}
          />
          <div ref={listRef} id={listId} role="listbox" aria-label="Repositories" className="pk-list">
            {view.sections.map((section) => (
              // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group, not a form fieldset
              <div key={section.id} role="group" aria-label={section.label ?? 'Path'} className="pk-group">
                {section.label ? (
                  <div className="pk-sec" aria-hidden="true">
                    {section.label}
                    {section.id === 'found' && discovering ? <span className="pk-sec-note">searching…</span> : null}
                  </div>
                ) : null}
                {section.options.map((option) => {
                  const index = view.options.indexOf(option);
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input (aria-activedescendant)
                    <div
                      key={option.key}
                      id={optionId(option)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === s.active}
                      data-active={index === s.active}
                      data-testid={option.kind === 'path' ? 'repo-option-path' : 'repo-option'}
                      className="pk-row"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => index !== s.active && s.setActive(index)}
                      onClick={() => choose(option)}
                    >
                      {option.kind === 'repo' ? (
                        <RepoRow repo={option.repo} home={home} selected={option.repo.path === value} />
                      ) : option.kind === 'path' ? (
                        <>
                          <span className="pk-icon pk-icon-accent">
                            <Icon name="folderPlus" size={14} />
                          </span>
                          <span className="pk-main">
                            <span className="pk-name">Use</span>
                            <span className="pk-path pk-path-strong mono">{abbreviatePath(option.path, home)}</span>
                          </span>
                          <Kbd>⏎</Kbd>
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {empty}
          </div>
          {(() => {
            const browse = view.options.at(-1) as RepoOption;
            const index = view.options.length - 1;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input (aria-activedescendant)
              <div
                id={optionId(browse)}
                role="option"
                tabIndex={-1}
                aria-selected={index === s.active}
                data-active={index === s.active}
                data-testid="repo-browse"
                className="pk-row pk-browse"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => index !== s.active && s.setActive(index)}
                onClick={() => choose(browse)}
              >
                <span className="pk-icon">
                  <Icon name="folder" size={14} />
                </span>
                <span className="pk-main">
                  <span className="pk-name">Browse…</span>
                  <span className="pk-path">Choose a folder in Finder</span>
                </span>
                <Kbd>⌘O</Kbd>
              </div>
            );
          })()}
        </Popover>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Base-branch picker
// ---------------------------------------------------------------------------------------------

export interface BranchPickerProps {
  id: string;
  /** '' = the repo's default branch. */
  value: string;
  branches: RepoBranches | null;
  loading: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onChange: (ref: string) => void;
}

export function BranchPicker(props: BranchPickerProps) {
  const { branches, value } = props;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const options = buildBranchOptions(branches, query);
  const shown = value || branches?.default || '';
  const s = usePickerState(
    options,
    options.find((o) => o.ref === shown && o.kind !== 'custom')?.key ?? null,
    query,
    setQuery,
  );

  const optionId = (o: BranchOption) => `${listId}-${o.key}`;
  const activeOption = options[s.active];
  const activeId = activeOption ? optionId(activeOption) : undefined;
  useScrollActive(listRef, activeId);

  const choose = (option: BranchOption | undefined) => {
    if (!option) return;
    // Picking the default branch stores '' (the run follows the repo's default).
    props.onChange(option.isDefault ? '' : option.ref);
    s.close(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = listKeyAction(event);
    if (!action || action === 'browse') return;
    if (action === 'tab') {
      s.close(false);
      s.triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === 'close') s.close(true);
    else if (action === 'choose') choose(activeOption);
    else s.setActive(moveActive(s.active, action, options.length));
  };

  const isDefault = !value || value === branches?.default;
  return (
    <>
      <button
        ref={s.triggerRef}
        id={props.id}
        type="button"
        className="field pk-trigger pk-trigger-branch"
        data-testid="branch-picker"
        data-open={s.open}
        aria-haspopup="listbox"
        aria-expanded={s.open}
        aria-disabled={props.disabled}
        title={props.disabled ? (props.disabledReason ?? undefined) : undefined}
        onClick={() => {
          if (props.disabled) return;
          if (s.open) s.close(false);
          else s.openList();
        }}
        onKeyDown={(event) => {
          if (!props.disabled && !s.open && opensPicker(event)) {
            event.preventDefault();
            s.openList();
          }
        }}
      >
        <Glyph name="branch" size={12} className="pk-trigger-icon" />
        {shown ? (
          <span className="pk-trigger-text mono">
            <span className="pk-trigger-name">{shown}</span>
          </span>
        ) : (
          <span className="pk-trigger-text pk-placeholder">{props.loading ? 'Loading…' : 'Default branch'}</span>
        )}
        {shown && isDefault ? <span className="pk-tag">default</span> : null}
        <Icon name="chevronUpDown" size={13} className="pk-chevron" />
      </button>
      {s.open && s.triggerRef.current ? (
        <Popover
          anchor={s.triggerRef.current}
          minWidth={300}
          idealHeight={340}
          onDismiss={() => s.close(false)}
          testId="branch-picker-list"
        >
          <SearchRow
            inputRef={s.inputRef}
            value={query}
            onChange={setQuery}
            placeholder="Filter branches, or type a ref…"
            label="Filter branches"
            listId={listId}
            activeId={activeId}
            onKeyDown={onKeyDown}
          />
          <div ref={listRef} id={listId} role="listbox" aria-label="Branches" className="pk-list">
            {options.map((option, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input (aria-activedescendant)
              <div
                key={option.key}
                id={optionId(option)}
                role="option"
                tabIndex={-1}
                aria-selected={index === s.active}
                data-active={index === s.active}
                data-testid="branch-option"
                className="pk-row pk-row-tight"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => index !== s.active && s.setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="pk-icon">
                  <Glyph name="branch" size={12} />
                </span>
                <span className="pk-main">
                  {option.kind === 'custom' ? <span className="pk-name">Use</span> : null}
                  <span className="pk-name mono pk-ref">{option.ref}</span>
                </span>
                {option.isDefault ? <span className="pk-tag">default</span> : null}
                {option.isCurrent ? <span className="pk-tag pk-tag-quiet">checked out</span> : null}
                {option.kind === 'remote' ? <span className="pk-tag pk-tag-quiet">remote</span> : null}
                <span className="pk-check">
                  {option.ref === shown && option.kind !== 'custom' ? (
                    <Icon name="check" size={13} strokeWidth={2.4} />
                  ) : null}
                </span>
              </div>
            ))}
            {options.length === 0 ? (
              <div className="pk-empty">{props.loading ? 'Loading branches…' : 'No branches yet'}</div>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
