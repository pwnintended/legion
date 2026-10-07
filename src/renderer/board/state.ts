/**
 * The project board's state: which conversations are on it and in what order (the first is the master),
 * which ones the user hid, which tile is in monocle, and the focus history. Kept per board (a project id, or
 * `repo:<path>` for runs whose project was removed); order, hidden and monocle persist per board.
 *
 * Focus is not stored here: the focused tile is the app's active run (`uiStore.activeRunId`), or the new
 * conversation tile when no run is active. Focusing a tile sets the active run, so the title bar, ⌘U and the
 * agents view keep meaning "this conversation".
 */
import type { Run } from '@shared/domain';
import { createStore } from 'zustand/vanilla';
import { isArchived } from '../app/compat';
import { type DataState, openInboxCount, TERMINAL_RUN_STATUSES } from '../app/data';
import { projectOfRun } from '../app/projects';
import { actions, dataStore, uiStore } from '../app/store';
import type { Arrangement } from './arrange';

/** The new-conversation tile's id in a board's order. */
export const NEW = 'new';

export interface Board {
  /** Tile ids, master first: run ids and possibly `NEW`. */
  order: string[];
  /** Hidden runs, with how many decisions waited when hidden: one more brings the tile back. */
  hidden: Record<string, number>;
  monocle: string | null;
  /** Most recently focused first (not persisted). */
  recent: string[];
}

/** What is on screen, for the keyboard (set by the board as it renders). */
export interface BoardView {
  key: string;
  projectId: string | null;
  ids: string[];
  focus: string | null;
  arrangement: Arrangement;
  /** A run shown only because it was opened (finished, or hidden): it leaves when monocle closes. */
  temporary: string | null;
}

interface BoardStore {
  boards: Record<string, Board>;
  view: BoardView | null;
  /** Bumped when the keyboard moved focus: the focused tile takes DOM focus. */
  focusRequest: number;
  /** A new conversation was asked for from a conversation's agents: the board splits it in once it is up. */
  pendingNew: boolean;
}

export const boardStore = createStore<BoardStore>(() => ({
  boards: {},
  view: null,
  focusRequest: 0,
  pendingNew: false,
}));

const STORAGE = 'legion.board.';

function load(key: string): Board {
  try {
    const raw = localStorage.getItem(STORAGE + key);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Board>;
      return {
        order: Array.isArray(saved.order) ? saved.order.filter((id) => typeof id === 'string') : [],
        hidden: saved.hidden && typeof saved.hidden === 'object' ? saved.hidden : {},
        monocle: typeof saved.monocle === 'string' ? saved.monocle : null,
        recent: [],
      };
    }
  } catch {
    // ignore
  }
  return { order: [], hidden: {}, monocle: null, recent: [] };
}

function save(key: string, board: Board): void {
  try {
    const { order, hidden, monocle } = board;
    localStorage.setItem(STORAGE + key, JSON.stringify({ order, hidden, monocle }));
  } catch {
    // ignore
  }
}

/** Boards read from storage but not changed yet (reading must not write the store: it happens in render). */
const loaded = new Map<string, Board>();

export function boardOf(key: string): Board {
  const existing = boardStore.getState().boards[key];
  if (existing) return existing;
  let board = loaded.get(key);
  if (!board) {
    board = load(key);
    loaded.set(key, board);
  }
  return board;
}

function update(key: string, change: (board: Board) => Board): void {
  const current = boardOf(key);
  const next = change(current);
  if (next === current) return;
  boardStore.setState((s) => ({ boards: { ...s.boards, [key]: next } }));
  save(key, next);
}

/** The board a run belongs to: its project, or its repository when the project was removed. */
export function boardKeyOf(data: DataState, run: Run): string {
  return projectOfRun(data, run)?.id ?? `repo:${run.repoPath}`;
}

/**
 * A board's conversations, in no particular order: its runs that are not archived and either still going or
 * holding a decision for the user (a finished run with its PR waiting). Hidden runs stay off until one more
 * decision waits on them.
 */
export function activeRunsOf(data: DataState, key: string, hidden: Record<string, number>): string[] {
  return Object.values(data.runs)
    .filter((run) => !isArchived(run) && boardKeyOf(data, run) === key)
    .filter((run) => {
      const waiting = openInboxCount(data, run.id);
      if (hidden[run.id] !== undefined && waiting <= (hidden[run.id] as number)) return false;
      return !TERMINAL_RUN_STATUSES.has(run.status) || waiting > 0;
    })
    .map((run) => run.id);
}

/**
 * The board's order for `members`: the stored order kept, members it does not know yet added at the end of the
 * stack, oldest first, so nothing that turns up (a run started elsewhere, a hidden tile coming back because it
 * needs you) moves the tiles under the user. A conversation started on the board takes the new tile's place
 * instead (`started`). With nothing stored yet, the most recently updated conversation is the master.
 */
export function reconcile(order: readonly string[], members: readonly string[], runs: DataState['runs']): string[] {
  const set = new Set(members);
  const kept = order.filter((id, i) => (id === NEW || set.has(id)) && order.indexOf(id) === i);
  const known = new Set(kept);
  const fresh = members.filter((id) => !known.has(id));
  if (kept.length) fresh.sort((a, b) => (runs[a]?.createdAt ?? 0) - (runs[b]?.createdAt ?? 0));
  else fresh.sort((a, b) => (runs[b]?.updatedAt ?? 0) - (runs[a]?.updatedAt ?? 0));
  const next = [...kept, ...fresh];
  return next.length === order.length && next.every((id, i) => id === order[i]) ? (order as string[]) : next;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

function withRecent(board: Board, id: string): Board {
  if (board.recent[0] === id) return board;
  return { ...board, recent: [id, ...board.recent.filter((r) => r !== id)].slice(0, 12) };
}

export const boardActions = {
  setOrder(key: string, order: string[]): void {
    update(key, (b) =>
      b.order.length === order.length && b.order.every((id, i) => id === order[i]) ? b : { ...b, order },
    );
  },

  /** Focus a tile: its run becomes the active run (the new tile: the project's page). Monocle follows it. */
  focus(id: string, keyboard = false): void {
    const view = boardStore.getState().view;
    if (!view) return;
    update(view.key, (b) => {
      const next = withRecent(b, id);
      return next.monocle && next.monocle !== id && view.ids.includes(id) && id !== view.temporary
        ? { ...next, monocle: id }
        : next;
    });
    if (id === NEW) {
      if (view.projectId) actions.openProjectHome(view.projectId);
    } else actions.setActiveRun(id);
    if (keyboard) boardStore.setState((s) => ({ focusRequest: s.focusRequest + 1 }));
  },

  /** Back from a conversation's agents to the board, with that conversation's tile focused. */
  backFromAgents(): void {
    actions.setView('chat');
    boardStore.setState((s) => ({ focusRequest: s.focusRequest + 1 }));
  },

  /** New conversation from a conversation's agents: back to the board, where the new tile splits in. */
  newFromAgents(): void {
    boardStore.setState({ pendingNew: true });
    actions.setView('chat');
  },

  /** Split a new-conversation tile in as the master (or focus the one already there). */
  openNew(): void {
    const view = boardStore.getState().view;
    if (!view?.projectId) return;
    update(view.key, (b) => (b.order.includes(NEW) ? b : { ...b, order: [NEW, ...b.order], monocle: null }));
    boardActions.focus(NEW, true);
  },

  /** Close the new-conversation tile; focus moves to the master. */
  closeNew(): void {
    const view = boardStore.getState().view;
    if (!view) return;
    update(view.key, (b) => ({
      ...b,
      order: b.order.filter((id) => id !== NEW),
      monocle: b.monocle === NEW ? null : b.monocle,
    }));
    const next = view.ids.find((id) => id !== NEW);
    if (next) boardActions.focus(next, true);
  },

  /** The new tile became a conversation: it keeps the tile's place (even if the run's event got here first). */
  started(key: string, runId: string): void {
    update(key, (b) => ({
      ...b,
      order: b.order.includes(NEW)
        ? b.order.filter((id) => id !== runId).map((id) => (id === NEW ? runId : id))
        : [runId, ...b.order.filter((id) => id !== runId)],
      monocle: b.monocle === NEW ? runId : b.monocle,
      recent: [runId, ...b.recent],
    }));
  },

  /** Make a tile the master. */
  promote(id: string): void {
    const view = boardStore.getState().view;
    if (!view) return;
    update(view.key, (b) => (b.order[0] === id ? b : { ...b, order: [id, ...b.order.filter((o) => o !== id)] }));
  },

  /** Show the focused tile alone, or tile the board again. Leaving a temporary tile's monocle closes it. */
  toggleMonocle(id: string): void {
    const view = boardStore.getState().view;
    if (!view) return;
    if (view.temporary && view.temporary === id) {
      boardActions.leaveTemporary();
      return;
    }
    update(view.key, (b) => ({ ...b, monocle: b.monocle === id ? null : id }));
    boardStore.setState((s) => ({ focusRequest: s.focusRequest + 1 }));
  },

  leaveTemporary(): void {
    const view = boardStore.getState().view;
    if (!view) return;
    const next = view.ids.find((id) => id !== view.temporary);
    if (next) boardActions.focus(next, true);
    else if (view.projectId) actions.openProjectHome(view.projectId);
  },

  /** Take a conversation off the board (the run goes on); it comes back when something new waits on you. */
  hide(runId: string): void {
    const view = boardStore.getState().view;
    if (!view) return;
    const waiting = openInboxCount(dataStore.getState(), runId);
    update(view.key, (b) => ({
      ...b,
      order: b.order.filter((id) => id !== runId),
      hidden: { ...b.hidden, [runId]: waiting },
      monocle: b.monocle === runId ? null : b.monocle,
      recent: b.recent.filter((id) => id !== runId),
    }));
    if (uiStore.getState().activeRunId !== runId) return;
    const board = boardOf(view.key);
    const next =
      board.recent.find((id) => view.ids.includes(id) && id !== runId) ?? view.ids.find((id) => id !== runId);
    if (next) boardActions.focus(next, true);
    else if (view.projectId) actions.openProjectHome(view.projectId);
  },

  /** Forget hides that something new waiting has already undone. */
  pruneHidden(key: string, data: DataState): void {
    update(key, (b) => {
      const stale = Object.entries(b.hidden).filter(
        ([id, at]) => !data.runs[id] || isArchived(data.runs[id]) || openInboxCount(data, id) > at,
      );
      if (!stale.length) return b;
      const hidden = { ...b.hidden };
      for (const [id] of stale) delete hidden[id];
      return { ...b, hidden };
    });
  },
};
