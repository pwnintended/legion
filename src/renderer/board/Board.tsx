/**
 * A project's board: every conversation in the project still going (or holding a decision for you) as a tile,
 * tiled like a window manager: the master on the left, the rest stacked on the right (see arrange.ts). Each tile
 * is the whole conversation, answerable in place. ⌘N splits a new-conversation tile in; with nothing going, that
 * tile alone is the project's page. Keyboard: ⌥ HJKL (⌘⌥ HJKL / arrows) focus, ⌘F monocle, ⌘⇧⏎ master, ⌘W hide.
 */
import type { Project } from '@shared/domain';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { isArchived } from '../app/compat';
import { attemptsOfRun, openInbox, openInboxCount } from '../app/data';
import { useData, useRun, useUi } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { actions, dataStore } from '../app/store';
import { Conversation } from '../chat/ChatView';
import { NewConversation } from '../chat/NewConversation';
import { Icon } from '../chrome/icons';
import { commandTooltip, EngineChip } from '../chrome/ui';
import { SPRING } from '../theme/motion';
import { arrange, GAP, type Rect, SPLIT_MIN, type TabRow } from './arrange';
import { activeRunsOf, boardActions, boardKeyOf, boardOf, boardStore, NEW, reconcile } from './state';
import './board.css';

const EASE = [0.16, 1, 0.3, 1] as const;

export function Board({ boardKey }: { boardKey: string }) {
  const project = useData((s) => s.projects[boardKey] ?? null);
  const board = useStore(boardStore, (s) => s.boards[boardKey]) ?? boardOf(boardKey);
  const runs = useData((s) => s.runs);
  const members = useData(useShallow((s) => activeRunsOf(s, boardKey, board.hidden)));
  const activeRunId = useUi((s) => s.activeRunId);
  const reduced = useReducedMotionPref();

  // A conversation that finishes while the board is up stays until it is hidden or the board is left, so a
  // tile never vanishes while someone reads it.
  const kept = useRef(new Set<string>());
  const order = useMemo(() => {
    for (const id of members) kept.current.add(id);
    const stay = [...kept.current].filter((id) => {
      const run = runs[id];
      return (
        run && !isArchived(run) && board.hidden[id] === undefined && boardKeyOf(dataStore.getState(), run) === boardKey
      );
    });
    const next = reconcile(board.order, stay, runs);
    return project || !next.includes(NEW) ? next : next.filter((id) => id !== NEW);
  }, [members, runs, board.order, board.hidden, boardKey, project]);
  // Nothing going: the new-conversation tile is the whole board (the project's page). It is not stored, so it
  // does not linger once a conversation exists.
  const ids = order.length === 0 && project ? [NEW] : order;

  // Persist the reconciled order (new conversations joined, finished and archived ones left).
  useEffect(() => {
    if (order !== board.order) boardActions.setOrder(boardKey, order);
  }, [order, board.order, boardKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tidy hides whenever the members change
  useEffect(() => boardActions.pruneHidden(boardKey, dataStore.getState()), [members, boardKey]);

  const temporary =
    activeRunId &&
    !ids.includes(activeRunId) &&
    runs[activeRunId] &&
    boardKeyOf(dataStore.getState(), runs[activeRunId]) === boardKey
      ? activeRunId
      : null;
  const shown = temporary ? [...ids, temporary] : ids;
  const focus = activeRunId ? (shown.includes(activeRunId) ? activeRunId : null) : shown.includes(NEW) ? NEW : null;
  const monocle = temporary ?? (board.monocle && shown.includes(board.monocle) ? board.monocle : null);

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

  const arrangement = useMemo(
    () => arrange(shown, size ?? { w: 0, h: 0 }, { monocle, focus, recent: board.recent }),
    [shown, size, monocle, focus, board.recent],
  );

  useLayoutEffect(() => {
    boardStore.setState({
      view: { key: boardKey, projectId: project?.id ?? null, ids: shown, focus, arrangement, temporary },
    });
    if (boardStore.getState().pendingNew) {
      boardStore.setState({ pendingNew: false });
      boardActions.openNew();
    }
  });
  useEffect(() => () => boardStore.setState({ view: null }), []);

  // Keyboard focus moves DOM focus into the tile: its reply box, else the tile itself.
  const focusRequest = useStore(boardStore, (s) => s.focusRequest);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on a request
  useEffect(() => {
    if (!focusRequest || !focus) return;
    const frame = requestAnimationFrame(() => {
      const tile = root.current?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(focus)}"]`);
      const input = tile?.querySelector<HTMLTextAreaElement>('textarea.ch-input');
      (input ?? tile)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  const waiting = useData(useShallow((s) => shown.map((id) => (id === NEW ? 0 : openInboxCount(s, id)))));
  const waitingOf = (id: string) => waiting[shown.indexOf(id)] ?? 0;
  const many = shown.length > 1;

  return (
    <div className="bd" ref={root} data-testid="board" data-monocle={arrangement.monocle || undefined}>
      {size ? (
        <>
          <AnimatePresence initial={false}>
            {arrangement.tiles.map(({ id, rect }) => (
              <TileShell key={id} id={id} rect={rect} reduced={reduced}>
                {id === NEW && project ? (
                  <NewTile project={project} focused={focus === NEW} alone={!many} hidden={board.hidden} />
                ) : (
                  <RunTile
                    runId={id}
                    focused={focus === id}
                    many={many}
                    monocle={monocle !== null}
                    canTile={(size?.w ?? 0) - 2 * GAP >= SPLIT_MIN}
                    temporary={temporary === id}
                    waiting={waitingOf(id)}
                    master={shown[0] === id && !arrangement.monocle && many}
                  />
                )}
              </TileShell>
            ))}
          </AnimatePresence>
          {arrangement.tabs.map((row) => (
            <Tabs key={row.ids.join(' ')} row={row} focus={focus} waitingOf={waitingOf} reduced={reduced} />
          ))}
        </>
      ) : null}
    </div>
  );
}

function TileShell({
  id,
  rect,
  reduced,
  children,
}: {
  id: string;
  rect: Rect;
  reduced: boolean;
  children: React.ReactNode;
}) {
  const move = reduced ? { duration: 0 } : SPRING;
  return (
    <motion.div
      className="bd-slot"
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
      onPointerDownCapture={() => {
        if (boardStore.getState().view?.focus !== id) boardActions.focus(id);
      }}
      onFocusCapture={() => {
        if (boardStore.getState().view?.focus !== id) boardActions.focus(id);
      }}
    >
      {children}
    </motion.div>
  );
}

function NewTile({
  project,
  focused,
  alone,
  hidden,
}: {
  project: Project;
  focused: boolean;
  alone: boolean;
  hidden: Record<string, number>;
}) {
  return (
    <section
      className="tile bd-tile"
      data-tile={NEW}
      data-focused={(focused && !alone) || undefined}
      data-alone={alone || undefined}
      aria-label="New conversation"
      tabIndex={-1}
    >
      {alone ? null : (
        <header className="tile-head bd-head">
          <span className="bd-mark" data-new aria-hidden="true">
            <Icon name="plus" size={12} strokeWidth={2.4} />
          </span>
          <h2 className="tile-title bd-title">New conversation</h2>
          <div className="tile-actions bd-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Close the new conversation"
              title={commandTooltip('board.hide', 'Close (Esc when empty)')}
              onClick={() => boardActions.closeNew()}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        </header>
      )}
      <NewConversation project={project} alone={alone} focused={focused}>
        {alone ? <HiddenWaiting hidden={hidden} /> : null}
      </NewConversation>
    </section>
  );
}

/** Hidden conversations that still wait on you: an empty board must not read as "nothing to do". */
function HiddenWaiting({ hidden }: { hidden: Record<string, number> }) {
  const rows = useData(
    useShallow((s) =>
      Object.keys(hidden).flatMap((id) => {
        const run = s.runs[id];
        const waiting = run && !isArchived(run) ? openInboxCount(s, id) : 0;
        return waiting > 0 && run ? [`${id}\u0000${run.title}\u0000${waiting}`] : [];
      }),
    ),
  );
  if (!rows.length) return null;
  return (
    <ul className="bd-hidden" aria-label="Hidden conversations waiting for you">
      {rows.map((row) => {
        const [id, title, waiting] = row.split('\u0000') as [string, string, string];
        return (
          <li key={id}>
            <button type="button" className="bd-hidden-row" onClick={() => actions.setActiveRun(id)}>
              <span className="bd-needs-dot" aria-hidden="true" />
              <span className="bd-hidden-title">{title}</span>
              <span className="bd-hidden-note">{waiting} waiting · hidden</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RunTile({
  runId,
  focused,
  many,
  monocle,
  canTile,
  temporary,
  waiting,
  master,
}: {
  runId: string;
  focused: boolean;
  many: boolean;
  /** Shown alone because the user asked (not because the board is too narrow to split). */
  monocle: boolean;
  /** The board is wide enough to tile: only then does the monocle toggle do anything. */
  canTile: boolean;
  temporary: boolean;
  waiting: number;
  master: boolean;
}) {
  const run = useRun(runId);
  const engine = useData(
    (s) =>
      attemptsOfRun(s.attempts, runId)
        .filter((a) => a.role === 'assistant')
        .at(-1)?.engine ?? null,
  );
  if (!run) return null;
  const firstOpen = () => openInbox(dataStore.getState().inbox, runId)[0];
  return (
    <section
      className="tile bd-tile"
      data-tile={runId}
      data-focused={(focused && many) || undefined}
      data-waiting={(waiting > 0 && !focused) || undefined}
      data-quiet={(!focused && many) || undefined}
      data-master={master || undefined}
      aria-label={`Conversation: ${run.title}`}
      tabIndex={-1}
      data-testid="board-tile"
    >
      <header className="tile-head bd-head">
        <span className="bd-mark" data-engine={engine ?? undefined} aria-hidden="true">
          <Icon name="spark" size={12} strokeWidth={2} />
        </span>
        <h2 className="tile-title bd-title" title={run.title}>
          {run.title}
        </h2>
        {waiting > 0 ? (
          <button
            type="button"
            className="bd-needs"
            onClick={() => {
              const item = firstOpen();
              if (item) actions.focusChatItem(runId, `inbox:${item.id}`);
            }}
            title="Show what waits for you"
          >
            <span className="bd-needs-dot" aria-hidden="true" />
            {waiting} waiting
          </button>
        ) : null}
        <span className="bd-grow" />
        {engine ? <EngineChip engine={engine} /> : null}
        <div className="tile-actions bd-actions">
          {many && canTile && !temporary ? (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={monocle ? 'Tile the board again' : 'Show this conversation alone'}
              aria-pressed={monocle}
              title={commandTooltip('board.monocle', monocle ? 'Tile again' : 'Alone')}
              onClick={() => boardActions.toggleMonocle(runId)}
            >
              <Icon name={monocle ? 'minimize' : 'maximize'} size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={temporary ? 'Close' : 'Hide from the board until it needs you'}
            title={commandTooltip('board.hide', temporary ? 'Close' : 'Hide until it needs you')}
            onClick={() => (temporary ? boardActions.leaveTemporary() : boardActions.hide(runId))}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>
      <Conversation run={run} focused={focused} />
    </section>
  );
}

function Tabs({
  row,
  focus,
  waitingOf,
  reduced,
}: {
  row: TabRow;
  focus: string | null;
  waitingOf: (id: string) => number;
  reduced: boolean;
}) {
  const titles = useData(
    useShallow((s) => row.ids.map((id) => (id === NEW ? 'New conversation' : (s.runs[id]?.title ?? id)))),
  );
  const { rect } = row;
  return (
    <motion.div
      className="bd-tabs"
      role="tablist"
      aria-label="Conversations"
      initial={false}
      animate={{ x: rect.x, y: rect.y, width: rect.w }}
      transition={reduced ? { duration: 0 } : SPRING}
    >
      {row.ids.map((id, i) => (
        <button
          key={id}
          type="button"
          role="tab"
          className="bd-tab"
          aria-selected={row.active === id}
          data-focused={focus === id || undefined}
          onClick={() => boardActions.focus(id, true)}
          title={titles[i]}
        >
          {row.active === id ? (
            <motion.span
              layoutId={`bd-tab-${row.ids[0]}`}
              className="bd-tab-pill"
              transition={reduced ? { duration: 0 } : SPRING}
            />
          ) : null}
          {waitingOf(id) > 0 ? <span className="bd-needs-dot" aria-hidden="true" /> : null}
          <span className="bd-tab-text">{titles[i]}</span>
          {waitingOf(id) > 0 ? <span className="sr-only">, waiting for you</span> : null}
        </button>
      ))}
    </motion.div>
  );
}
