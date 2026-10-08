/**
 * A viewer tile: files and diffs as tabs in its head, like an editor pane holds buffers. Opening something shows
 * it in the focused viewer (or the one used last) instead of making a window; the preview tab (dashed, like
 * everything "not kept yet") is replaced by the next thing opened, and a double-click, ⌘⏎ or opening with ⌘
 * keeps it. Tabs stay mounted while open, so each keeps its scroll and selection. The last tab closed closes the
 * viewer.
 */
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip } from '../app/commands';
import type { DataState } from '../app/data';
import { useData } from '../app/hooks';
import { projectWorkspaceKey } from '../app/projects';
import { useQueryVersion } from '../app/query';
import { Icon } from '../chrome/icons';
import { TileBody } from '../layout/TileFrame';
import { confirmClose, dropBuffers, useDirtyTabs } from '../tiles/code/editor/buffers';
import { FileIcon } from '../tiles/project/kit';
import { type TabLabel, tabLabel } from './labels';
import { FullscreenButton } from './parts';
import {
  closeTab,
  pinTab,
  selectTab,
  type TileSpec,
  toggleFullscreen,
  updateWorkspace,
  type ViewerTab,
  type Workspace,
} from './state';

type ViewerSpec = Extract<TileSpec, { kind: 'viewer' }>;

/** The run a tab is about (a diff reads its run's plan and reviews); the project's own key otherwise. */
function runOfTab(data: DataState, tab: ViewerTab, fallback: string): string {
  if (tab.kind !== 'diff') return fallback;
  const target = tab.params.target;
  if (target.kind === 'task') return data.tasks[target.taskId]?.runId ?? fallback;
  if (target.kind === 'run' || target.kind === 'range') return target.runId;
  return fallback;
}

export function Viewer({
  projectId,
  ws,
  id,
  viewer,
  focused,
  canFullscreen,
}: {
  projectId: string;
  ws: Workspace;
  id: string;
  viewer: ViewerSpec;
  focused: boolean;
  canFullscreen: boolean;
}) {
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  // One stable ref callback per tab (a new callback each render would detach and re-attach, setting state).
  const slotRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotRef = (tabId: string) => {
    let ref = slotRefs.current.get(tabId);
    if (!ref) {
      ref = (el) => setSlots((s) => (s[tabId] === el ? s : { ...s, [tabId]: el }));
      slotRefs.current.set(tabId, ref);
    }
    return ref;
  };
  const update = (op: (w: Workspace) => Workspace, keyboard = false) => updateWorkspace(projectId, ws.id, op, keyboard);
  const fallback = ws.runId ?? projectWorkspaceKey(projectId);
  const runs = useData(useShallow((s) => viewer.tabs.map((tab) => runOfTab(s, tab, fallback))));
  const dirty = useDirtyTabs(viewer.tabs.map((t) => t.id));

  // An edited preview tab is kept (the next file opened must not replace unsaved work).
  useEffect(() => {
    for (const tabId of dirty.split(' ').filter(Boolean)) {
      if (viewer.tabs.some((t) => t.id === tabId && !t.pinned)) update((w) => pinTab(w, id, tabId));
    }
  });

  // Tabs replaced or closed leave their buffers behind: drop them.
  const shownIds = useRef<string[]>([]);
  useEffect(() => {
    const now = viewer.tabs.map((t) => t.id);
    const gone = shownIds.current.filter((tabId) => !now.includes(tabId));
    shownIds.current = now;
    if (gone.length) dropBuffers(gone);
  });

  return (
    <section
      className="tile cw-tile cw-viewer"
      tabIndex={-1}
      aria-label="Viewer"
      data-code-tile={id}
      data-focused={focused}
      data-testid="code-viewer"
    >
      <header className="tile-head cw-head cw-viewer-head">
        <TabStrip
          viewer={viewer}
          onSelect={(tabId) => update((w) => selectTab(w, id, tabId))}
          onPin={(tabId) => update((w) => pinTab(w, id, tabId))}
          dirty={dirty}
          onClose={(tabId) =>
            void confirmClose([tabId]).then((ok) => {
              if (ok) update((w) => closeTab(w, id, tabId));
            })
          }
        />
        <div className="cw-actions cw-viewer-actions">
          {viewer.tabs.map((tab) => (
            <div
              key={tab.id}
              className="tile-actions cw-tab-actions"
              hidden={tab.id !== viewer.active}
              ref={slotRef(tab.id)}
            />
          ))}
          {canFullscreen ? (
            <FullscreenButton on={ws.fullscreen === id} onClick={() => update((w) => toggleFullscreen(w, id), true)} />
          ) : null}
        </div>
      </header>
      <div className="tile-body" data-tile-body>
        {viewer.tabs.map((tab, i) => (
          <div
            key={tab.id}
            className="cw-tab-body"
            hidden={tab.id !== viewer.active}
            data-tab={tab.id}
            data-kind={tab.kind}
          >
            <TileBody
              runId={runs[i] ?? fallback}
              tile={{ id: tab.id, kind: tab.kind, params: tab.params, auto: false } as never}
              focused={focused && tab.id === viewer.active}
              visible={tab.id === viewer.active}
              actionsSlot={slots[tab.id] ?? null}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function TabStrip({
  viewer,
  dirty,
  onSelect,
  onPin,
  onClose,
}: {
  viewer: ViewerSpec;
  /** Tab ids with unsaved edits, space-separated. */
  dirty: string;
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const labels = useTabLabels(viewer.tabs);

  // Keep the tab on show in view, and say which edges have more tabs behind them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the tab on show or the tabs change
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    el.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const measure = () =>
      setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [viewer.active, viewer.tabs.length]);

  return (
    <div
      ref={strip}
      className="cw-vtabs"
      role="tablist"
      aria-label="Open files and diffs"
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      onWheel={(event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {viewer.tabs.map((tab, i) => {
        const label = labels[i] ?? { id: null, title: tab.id, full: tab.id, note: null };
        const active = tab.id === viewer.active;
        return (
          <div
            key={tab.id}
            className="cw-vtab"
            data-active={active || undefined}
            data-preview={!tab.pinned || undefined}
            data-dirty={dirty.split(' ').includes(tab.id) || undefined}
          >
            <button
              type="button"
              role="tab"
              className="cw-vtab-main"
              aria-selected={active}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={() => onPin(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
              title={
                tab.pinned
                  ? label.full
                  : `${label.full}\nPreview: the next file you open replaces it. Double-click to keep it.`
              }
              data-testid="code-tab"
              data-pinned={tab.pinned || undefined}
            >
              {tab.kind === 'code' ? (
                <FileIcon name={label.title} size={13} />
              ) : (
                <Icon
                  name={tab.params.target.kind === 'commit' ? 'commit' : 'diff'}
                  size={13}
                  className="cw-vtab-icon"
                />
              )}
              {label.id ? <span className="cw-vtab-id mono">{label.id}</span> : null}
              <span className="cw-vtab-title">{label.title}</span>
              {label.note ? <span className="cw-vtab-note">{label.note}</span> : null}
            </button>
            <span className="cw-vtab-dirty" aria-hidden="true" />
            <button
              type="button"
              className="cw-vtab-close"
              aria-label={`Close ${label.full}`}
              title={commandTooltip('code.close', 'Close')}
              onClick={() => onClose(tab.id)}
            >
              <Icon name="close" size={10} strokeWidth={2.4} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Labels of the tabs; a file's folder is added when two open files share a name. */
function useTabLabels(tabs: readonly ViewerTab[]): (TabLabel & { note: string | null })[] {
  useQueryVersion();
  const raw = useData(useShallow((s) => tabs.map((tab) => JSON.stringify(tabLabel(s, tab)))));
  const labels = raw.map((r) => JSON.parse(r) as TabLabel);
  return labels.map((label, i) => {
    const tab = tabs[i];
    const clash =
      tab?.kind === 'code' && labels.filter((l, j) => tabs[j]?.kind === 'code' && l.title === label.title).length > 1;
    return { ...label, note: clash ? (label.full.split('/').at(-2) ?? null) : null };
  });
}
