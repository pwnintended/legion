/**
 * The Code view: a project's workspaces. The bar on top names every workspace (the project's main checkout first,
 * then the ones you made, on the project or on a run's worktree); the side panel holds the navigators (a run's
 * changes, files, search, activity); the rest is the workspace's tiles, arranged by you, i3-style (tree.ts):
 * terminals and viewers, split side by side or above each other, or grouped as tabs or a stack. Nothing scrolls
 * off screen and nothing rearranges itself. Keyboard: code/commands.ts.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip, executeCommand } from '../app/commands';
import type { DataState } from '../app/data';
import { useData } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { Icon } from '../chrome/icons';
import { CommandKbd, EngineChip } from '../chrome/ui';
import { SPRING } from '../theme/motion';
import { closeTerminal, ensureWorkspace, isReadOnly, liveAgent, takeOverWorkspace } from './actions';
import { useCurrentWorkspace } from './hooks';
import { tabLabel } from './labels';
import { Panel } from './Panel';
import { codeStore, focusTile, updateWorkspace, type Workspace } from './state';
import { TerminalFrame, terminalLabels } from './TerminalFrame';
import { type Bar, computeRects, GAP, type Layout, type Rect } from './tree';
import { Viewer } from './Viewer';
import { setShown } from './view';
import { WorkspaceBar, workspaceName } from './WorkspaceBar';
import './code.css';

const EASE = [0.16, 1, 0.3, 1] as const;

export function CodeView({ projectId }: { projectId: string }) {
  const ws = useCurrentWorkspace(projectId);
  const reduced = useReducedMotionPref();

  // A project's first visit: its main checkout, with a shell.
  useLayoutEffect(() => ensureWorkspace(projectId), [projectId]);

  return (
    <div className="cw" data-testid="code" data-workspace={ws?.id}>
      <WorkspaceBar projectId={projectId} current={ws} />
      {ws?.checkout ? <CheckoutBar projectId={projectId} ws={ws} /> : null}
      <div className="cw-main">
        {ws?.panel ? (
          // The panel's width snaps (the tiles glide to their new places on the spring); the panel itself fades
          // in from the edge it belongs to.
          <motion.div
            className="cw-panel-slot"
            initial={reduced ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: reduced ? 0 : 0.18, ease: EASE }}
          >
            <Panel projectId={projectId} ws={ws} />
          </motion.div>
        ) : null}
        {ws ? <Tiles key={ws.id} projectId={projectId} ws={ws} reduced={reduced} /> : null}
      </div>
    </div>
  );
}

/**
 * A worktree workspace says what it is on (the task, its branch) and whether it is yours to change: read-only
 * while the task's agent works there, until you take it over (its session handed to you in a terminal).
 */
function CheckoutBar({ projectId, ws }: { projectId: string; ws: Workspace }) {
  const name = useData((s) => workspaceName(s, ws, projectId));
  const branch = useData((s) => (ws.taskId ? (s.tasks[ws.taskId]?.branch ?? null) : null));
  const readOnly = useData((s) => isReadOnly(s, ws));
  const engine = useData((s) => liveAgent(s, ws.taskId)?.engine ?? null);
  const folder = ws.checkout?.split('/').filter(Boolean).at(-1) ?? '';
  return (
    <div className="cw-checkout" data-read-only={readOnly || undefined} data-testid="code-checkout">
      <Icon name={readOnly ? 'lock' : 'branch'} size={13} className="cw-checkout-icon" />
      <span className="cw-checkout-name">{name}</span>
      <span className="cw-checkout-path mono" title={ws.checkout ?? undefined}>
        {branch ?? folder}
      </span>
      <span className="cw-grow" />
      {readOnly ? (
        <>
          <span className="cw-checkout-note">
            Read-only while its agent works here
            {engine ? <EngineChip engine={engine} /> : null}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-warn"
            onClick={() => void takeOverWorkspace(projectId, ws.id)}
            title="Stop the agent here and hand its session to you in a terminal"
            data-testid="code-take-over"
          >
            Take over
          </button>
        </>
      ) : ws.taken ? (
        <span className="cw-checkout-note">Yours: you took it over</span>
      ) : null}
    </div>
  );
}

function Tiles({ projectId, ws, reduced }: { projectId: string; ws: Workspace; reduced: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo<Layout>(() => {
    const area: Rect = {
      x: GAP,
      y: GAP,
      w: Math.max(0, (size?.w ?? 0) - 2 * GAP),
      h: Math.max(0, (size?.h ?? 0) - 2 * GAP),
    };
    if (ws.fullscreen && ws.tiles[ws.fullscreen]) return { tiles: [{ id: ws.fullscreen, rect: area }], bars: [] };
    return computeRects(ws.root, area);
  }, [ws.root, ws.fullscreen, ws.tiles, size]);

  useLayoutEffect(() => setShown({ projectId, workspace: ws.id, layout }));
  useEffect(() => () => setShown(null), []);

  // Keyboard focus moves DOM focus into the focused tile: a terminal takes it itself, a viewer its tab's body.
  // Only for a new request, never under an overlay, and never away from something outside the view (the rail).
  const focusRequest = useStore(codeStore, (s) => s.focusRequest);
  const handled = useRef(focusRequest);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on a request
  useEffect(() => {
    if (handled.current === focusRequest) return;
    handled.current = focusRequest;
    const frame = requestAnimationFrame(() => {
      if (document.body.dataset.overlay || !ws.focus) return;
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest('.cw')) return;
      const tile = root.current?.querySelector<HTMLElement>(`[data-code-tile="${CSS.escape(ws.focus)}"]`);
      if (!tile || tile.contains(active)) return;
      const body = tile.querySelector<HTMLElement>('.cw-tab-body:not([hidden])') ?? tile;
      const target =
        tile.querySelector<HTMLElement>('.xterm-helper-textarea') ??
        body.querySelector<HTMLElement>('.cm-content') ??
        body.querySelector<HTMLElement>('[tabindex="0"]') ??
        tile;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  const count = Object.keys(ws.tiles).length;
  const focusOn = (id: string) => {
    if (ws.focus !== id) updateWorkspace(projectId, ws.id, (w) => focusTile(w, id));
  };

  return (
    <div className="cw-tiles" ref={root} data-fullscreen={ws.fullscreen ? true : undefined}>
      {size && count === 0 ? <EmptyWorkspace /> : null}
      {size ? (
        <>
          <AnimatePresence initial={false}>
            {layout.tiles.map(({ id, rect }) => {
              const tile = ws.tiles[id];
              if (!tile) return null;
              return (
                <Slot key={id} rect={rect} reduced={reduced} onFocus={() => focusOn(id)}>
                  {tile.kind === 'viewer' ? (
                    <Viewer
                      projectId={projectId}
                      ws={ws}
                      id={id}
                      viewer={tile}
                      focused={ws.focus === id && count > 1}
                      canFullscreen={count > 1}
                    />
                  ) : (
                    <TerminalFrame
                      projectId={projectId}
                      ws={ws}
                      id={id}
                      params={tile.params}
                      focused={ws.focus === id && count > 1}
                      canFullscreen={count > 1}
                      onClose={() => closeTerminal(projectId, ws.id, id)}
                    />
                  )}
                </Slot>
              );
            })}
          </AnimatePresence>
          {layout.bars.map((bar) => (
            <ContainerBar
              key={bar.con}
              bar={bar}
              ws={ws}
              reduced={reduced}
              onPick={(id) => updateWorkspace(projectId, ws.id, (w) => focusTile(w, id), true)}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function Slot({
  rect,
  reduced,
  onFocus,
  children,
}: {
  rect: Rect;
  reduced: boolean;
  onFocus: () => void;
  children: React.ReactNode;
}) {
  const move = reduced ? { duration: 0 } : SPRING;
  return (
    <motion.div
      className="cw-slot"
      initial={{ opacity: 0, scale: 0.985, x: rect.x, y: rect.y, width: rect.w, height: rect.h }}
      animate={{ opacity: 1, scale: 1, x: rect.x, y: rect.y, width: rect.w, height: rect.h }}
      exit={{ opacity: 0, scale: 0.985, transition: { duration: reduced ? 0 : 0.15, ease: EASE } }}
      transition={{
        x: move,
        y: move,
        width: move,
        height: move,
        opacity: { duration: reduced ? 0 : 0.2, ease: EASE },
        scale: { duration: reduced ? 0 : 0.2, ease: EASE },
      }}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      {children}
    </motion.div>
  );
}

/** What a tab or title bar calls a child: a tile by its name, a container by its first tile and how many more. */
function childLabels(state: DataState, ws: Workspace, bar: Bar): string[] {
  const terminals = terminalLabels(state, ws);
  const name = (id: string) => {
    const tile = ws.tiles[id];
    if (tile?.kind === 'terminal') return terminals[id]?.title ?? 'Terminal';
    if (tile?.kind === 'viewer') {
      const tab = tile.tabs.find((t) => t.id === tile.active);
      if (!tab) return 'Viewer';
      const label = tabLabel(state, tab);
      return label.id ? `${label.id} ${label.title}` : label.title;
    }
    return id;
  };
  return bar.children.map((c) => {
    const first = c.leaves[0];
    if (!first) return '';
    return c.leaves.length > 1 ? `${name(first)} +${c.leaves.length - 1}` : name(first);
  });
}

/** A tabbed container's tab row, or a stacked container's title bars: every child named, one shown. */
function ContainerBar({
  bar,
  ws,
  reduced,
  onPick,
}: {
  bar: Bar;
  ws: Workspace;
  reduced: boolean;
  onPick: (id: string) => void;
}) {
  const labels = useData(useShallow((s) => childLabels(s, ws, bar)));
  const kinds = bar.children.map((c) => ws.tiles[c.leaves[0] ?? '']?.kind ?? 'terminal');
  const focusedChild = bar.children.findIndex((c) => ws.focus !== null && c.leaves.includes(ws.focus));
  const track = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the tab on show changes
  useEffect(() => {
    track.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [bar.active]);
  const { rect } = bar;
  const tabbed = bar.layout === 'tabbed';
  return (
    <motion.div
      ref={track}
      className={tabbed ? 'bd-tabs cw-con-tabs' : 'cw-con-stack'}
      role="tablist"
      aria-label={tabbed ? 'Tabs' : 'Stack'}
      initial={false}
      animate={{ x: rect.x, y: rect.y, width: rect.w, height: rect.h }}
      transition={reduced ? { duration: 0 } : SPRING}
      data-layout={bar.layout}
    >
      {bar.children.map((child, i) => (
        <button
          key={child.id}
          type="button"
          role="tab"
          className={tabbed ? 'bd-tab' : 'cw-stack-row'}
          aria-selected={bar.active === i}
          data-focused={focusedChild === i || undefined}
          onClick={() => onPick(child.leaves[0] ?? child.id)}
          title={labels[i]}
        >
          {bar.active === i && tabbed ? (
            <motion.span
              layoutId={`cw-tab-${bar.con}`}
              className="bd-tab-pill"
              transition={reduced ? { duration: 0 } : SPRING}
            />
          ) : null}
          <Icon name={kinds[i] === 'viewer' ? 'fileCode' : 'terminal'} size={12} className="cw-tab-icon" />
          <span className="bd-tab-text">{labels[i]}</span>
        </button>
      ))}
    </motion.div>
  );
}

/** A workspace with every tile closed: what to open, and the keys for it. */
function EmptyWorkspace() {
  return (
    <div className="cw-empty" data-testid="code-empty">
      <p className="cw-empty-lede">Nothing open here.</p>
      <div className="cw-empty-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void executeCommand('tile.newTerminal')}
          title={commandTooltip('tile.newTerminal')}
        >
          <Icon name="terminal" size={13} />
          Terminal
          <CommandKbd id="tile.newTerminal" />
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void executeCommand('file.goto')}
          title={commandTooltip('file.goto')}
        >
          <Icon name="file" size={13} />
          Open a file
          <CommandKbd id="file.goto" />
        </button>
      </div>
    </div>
  );
}
