/**
 * A workspace's side panel: the navigators you open things from, never windows of their own. A workspace on a
 * run's worktree leads with the run's Changes; every workspace has Files and Search (of its own checkout) and
 * the project's Activity. ⌘B shows and hides it, ⌘⇧F opens it on the search with the caret in the field.
 */
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { commandTooltip } from '../app/commands';
import { useReducedMotionPref } from '../app/prefs';
import { projectWorkspaceKey } from '../app/projects';
import { Icon, type IconName } from '../chrome/icons';
import { TileBody } from '../layout/TileFrame';
import { SPRING } from '../theme/motion';
import { Changes } from './Changes';
import { codeStore, type PanelSection, setPanel, updateWorkspace, type Workspace } from './state';

const SECTIONS: { id: PanelSection; label: string; icon: IconName; command?: string }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'files', label: 'Files', icon: 'folder', command: 'file.goto' },
  { id: 'search', label: 'Search', icon: 'search', command: 'project.search' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
];

export function Panel({ projectId, ws }: { projectId: string; ws: Workspace }) {
  const reduced = useReducedMotionPref();
  const root = useRef<HTMLElement>(null);
  const sections = SECTIONS.filter((s) => s.id !== 'changes' || ws.runId !== null);
  const section = sections.some((s) => s.id === ws.section) ? ws.section : 'files';
  const runId = ws.runId ?? projectWorkspaceKey(projectId);
  const checkout = ws.checkout;
  const pick = (id: PanelSection) => updateWorkspace(projectId, ws.id, (w) => setPanel(w, true, id));

  // ⌘⇧F: the caret goes to the search field. Opening the panel by keyboard: focus goes into its list.
  const searchRequest = useStore(codeStore, (s) => s.searchRequest);
  const panelRequest = useStore(codeStore, (s) => s.panelRequest);
  useEffect(() => {
    if (!searchRequest) return;
    // The search's code may still be loading when the panel opens on it: wait for its field (a second at most).
    let frame = 0;
    let tries = 60;
    const attempt = () => {
      const input = root.current?.querySelector<HTMLInputElement>('[data-testid="search-input"]');
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      } else if (tries-- > 0) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [searchRequest]);
  useEffect(() => {
    if (!panelRequest) return;
    const frame = requestAnimationFrame(() => {
      const body = root.current?.querySelector<HTMLElement>('.cw-panel-body');
      const target =
        body?.querySelector<HTMLElement>('input') ?? body?.querySelector<HTMLElement>('button:not([disabled])');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [panelRequest]);

  return (
    <aside ref={root} className="tile cw-panel" aria-label="Side panel" data-testid="code-panel" data-section={section}>
      <div className="cw-panel-head" role="tablist" aria-label="Side panel sections">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="cw-section"
            aria-selected={section === s.id}
            onClick={() => pick(s.id)}
            title={s.command ? commandTooltip(s.command, s.label) : s.label}
            data-testid={`code-section-${s.id}`}
          >
            {section === s.id ? (
              <motion.span
                layoutId="cw-section-pill"
                className="cw-section-pill"
                transition={reduced ? { duration: 0 } : SPRING}
              />
            ) : null}
            <Icon name={s.icon} size={13} />
            <span className="cw-section-label">{s.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="btn btn-ghost btn-icon cw-panel-close"
          aria-label="Hide the side panel"
          title={commandTooltip('code.panel', 'Hide')}
          onClick={() => updateWorkspace(projectId, ws.id, (w) => setPanel(w, false))}
        >
          <Icon name="chevronLeft" size={13} />
        </button>
      </div>
      <div className="cw-panel-body" data-tile-body>
        {section === 'changes' && ws.runId ? (
          <Changes projectId={projectId} runId={ws.runId} />
        ) : section === 'files' ? (
          <TileBody
            runId={runId}
            tile={{ id: `files:${ws.id}`, kind: 'files', params: { projectId, checkout }, auto: true }}
            focused={false}
            visible
            actionsSlot={null}
          />
        ) : section === 'search' ? (
          <TileBody
            runId={runId}
            tile={{
              id: `search:${ws.id}`,
              kind: 'search',
              params: { projectId, query: ws.query, checkout },
              auto: true,
            }}
            focused={false}
            visible
            actionsSlot={null}
            onParams={(_, params) => {
              const query = (params as { query: string }).query;
              updateWorkspace(projectId, ws.id, (w) => (w.query === query ? w : { ...w, query }));
            }}
          />
        ) : (
          <TileBody
            runId={runId}
            tile={{ id: 'activity', kind: 'activity', params: { projectId }, auto: true }}
            focused={false}
            visible
            actionsSlot={null}
          />
        )}
      </div>
    </aside>
  );
}
