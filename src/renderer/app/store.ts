/**
 * The renderer's two Zustand stores:
 * - `dataStore`: the client mirror of engine state (see data.ts), written only by sync.ts / demo mode.
 * - `uiStore`: what the user is looking at — active run, overlays, layout mode, key mode, per-run layouts.
 *
 * Layout trees are kept in sync with run data here (outside React), so the strip is correct before render.
 */
import { createStore } from 'zustand/vanilla';
import { describeTile, itemTargetsTile, tileTaskId } from '../layout/describe';
import { loadLayout, saveLayout } from '../layout/persist';
import { type RunLayoutInput, syncWithRun } from '../layout/sync';
import { allTiles, focusTile, type LayoutMode, type Workspace } from '../layout/tree';
import { type DataState, initialData, latestPlan, openInbox, selectRunList, tasksOfRun } from './data';

export type Overlay = 'composer' | 'inbox' | 'palette';
export type KeyMode = 'normal' | 'resize' | 'move';

export interface UiState {
  activeRunId: string | null;
  overlay: Overlay | null;
  layoutMode: LayoutMode;
  /** Mode to return to when toggling Overview/Pipeline/Focus off. */
  previousMode: LayoutMode;
  keyMode: KeyMode;
  /** DOM focus is inside a terminal: plain keys pass through, only ⌘-chords are intercepted. */
  terminalLocked: boolean;
  layouts: Record<string, Workspace>;
  /** Inbox item ids whose urgency pulse was acknowledged (the user focused the tile). */
  acknowledged: Record<string, true>;
  /** Bumped when keyboard navigation moved layout focus: the focused tile takes DOM focus. */
  focusRequest: number;
  /** Renderer-only fixture mode (`?demo=1`). */
  demo: boolean;
}

const UI_PREFS_KEY = 'legion.ui';

function loadPrefs(): Partial<Pick<UiState, 'activeRunId' | 'layoutMode'>> {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Pick<UiState, 'activeRunId' | 'layoutMode'>>) : {};
  } catch {
    return {};
  }
}

function savePrefs(state: UiState): void {
  try {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({ activeRunId: state.activeRunId, layoutMode: state.layoutMode }),
    );
  } catch {
    // ignore
  }
}

export function initialUi(): UiState {
  const prefs = loadPrefs();
  const mode =
    prefs.layoutMode && ['strip', 'focus', 'overview', 'pipeline'].includes(prefs.layoutMode)
      ? prefs.layoutMode
      : 'strip';
  return {
    activeRunId: typeof prefs.activeRunId === 'string' ? prefs.activeRunId : null,
    overlay: null,
    layoutMode: mode,
    previousMode: 'strip',
    keyMode: 'normal',
    terminalLocked: false,
    layouts: {},
    acknowledged: {},
    focusRequest: 0,
    demo: false,
  };
}

export const dataStore = createStore<DataState>(() => initialData());
export const uiStore = createStore<UiState>(() => initialUi());

// ---------------------------------------------------------------------------------------------
// Layout ↔ run data
// ---------------------------------------------------------------------------------------------

export function runLayoutInput(data: DataState, runId: string): RunLayoutInput | null {
  const run = data.runs[runId];
  if (!run || data.loadedRuns[runId] === undefined) return null;
  const clarify = openInbox(data.inbox, runId).find((i) => i.kind === 'question' && i.payload.source === 'clarify');
  return {
    runId,
    status: run.status,
    nodes: latestPlan(data, runId)?.dag.nodes ?? [],
    tasks: tasksOfRun(data.tasks, runId).map((t) => ({ id: t.id, nodeId: t.nodeId, status: t.status })),
    clarifyItemId: clarify?.id ?? null,
  };
}

/** Acknowledge the urgent items of the focused tile (stops its pulse). */
function acknowledgeFocused(layout: Workspace, acknowledged: Record<string, true>): Record<string, true> {
  if (!layout.focus) return acknowledged;
  const entry = allTiles(layout).find(({ tile }) => tile.id === layout.focus?.tile);
  if (!entry) return acknowledged;
  const data = dataStore.getState();
  const items = openInbox(data.inbox, layout.runId).filter((i) =>
    itemTargetsTile(i, entry.tile, tileTaskId(entry.tile)),
  );
  if (items.every((i) => acknowledged[i.id])) return acknowledged;
  const next = { ...acknowledged };
  for (const item of items) next[item.id] = true;
  return next;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const dirty = new Set<string>();
function scheduleSave(runId: string): void {
  dirty.add(runId);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { layouts } = uiStore.getState();
    for (const id of dirty) {
      const layout = layouts[id];
      if (layout) saveLayout(layout);
    }
    dirty.clear();
  }, 400);
}

/** Bring the active run's layout up to date with its data. */
export function syncActiveLayout(): void {
  const { activeRunId, layouts } = uiStore.getState();
  if (!activeRunId) return;
  const input = runLayoutInput(dataStore.getState(), activeRunId);
  if (!input) return;
  const current = layouts[activeRunId] ?? loadLayout(activeRunId);
  const next = syncWithRun(current, input);
  if (next === layouts[activeRunId]) return;
  uiStore.setState({ layouts: { ...layouts, [activeRunId]: next } });
  scheduleSave(activeRunId);
}

/** Pick a run when none (or a vanished one) is active. */
function ensureActiveRun(): void {
  const data = dataStore.getState();
  if (!data.connection.loaded) return;
  const { activeRunId } = uiStore.getState();
  if (activeRunId && data.runs[activeRunId]) return;
  const first = selectRunList(data)[0];
  const next = first?.id ?? null;
  if (next !== activeRunId) actions.setActiveRun(next);
}

let lastInputs: unknown[] = [];
dataStore.subscribe((data) => {
  ensureActiveRun();
  // Only resync when something the layout depends on changed (not on every agent event).
  const inputs = [data.runs, data.plans, data.tasks, data.inbox, data.loadedRuns, uiStore.getState().activeRunId];
  if (inputs.every((v, i) => v === lastInputs[i])) return;
  lastInputs = inputs;
  syncActiveLayout();
});

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export const actions = {
  setActiveRun(runId: string | null): void {
    if (uiStore.getState().activeRunId === runId) return;
    uiStore.setState({ activeRunId: runId, keyMode: 'normal' });
    savePrefs(uiStore.getState());
    syncActiveLayout();
  },

  openOverlay(overlay: Overlay): void {
    uiStore.setState({ overlay });
  },
  toggleOverlay(overlay: Overlay): void {
    uiStore.setState((s) => ({ overlay: s.overlay === overlay ? null : overlay }));
  },
  closeOverlay(): void {
    if (uiStore.getState().overlay !== null)
      uiStore.setState({ overlay: null, focusRequest: uiStore.getState().focusRequest + 1 });
  },

  setLayoutMode(mode: LayoutMode): void {
    const { layoutMode } = uiStore.getState();
    if (layoutMode === mode) return;
    uiStore.setState({ layoutMode: mode, previousMode: layoutMode, overlay: null });
    savePrefs(uiStore.getState());
  },
  /** Switch to `mode`, or back to the previous mode when already there. */
  toggleLayoutMode(mode: LayoutMode): void {
    const { layoutMode, previousMode } = uiStore.getState();
    actions.setLayoutMode(layoutMode === mode ? (previousMode === mode ? 'strip' : previousMode) : mode);
  },

  setKeyMode(keyMode: KeyMode): void {
    if (uiStore.getState().keyMode !== keyMode) uiStore.setState({ keyMode });
  },
  setTerminalLocked(locked: boolean): void {
    if (uiStore.getState().terminalLocked !== locked) uiStore.setState({ terminalLocked: locked });
  },

  /** Apply a layout op to a run's workspace. `keyboard` moves DOM focus to the newly focused tile. */
  updateLayout(runId: string, op: (layout: Workspace) => Workspace, keyboard = false): void {
    const state = uiStore.getState();
    const current = state.layouts[runId];
    if (!current) return;
    const next = op(current);
    if (next === current) return;
    const acknowledged = acknowledgeFocused(next, state.acknowledged);
    uiStore.setState({
      layouts: { ...state.layouts, [runId]: next },
      acknowledged,
      focusRequest: keyboard ? state.focusRequest + 1 : state.focusRequest,
    });
    scheduleSave(runId);
  },

  /** Apply a layout op to the active run's workspace. */
  layout(op: (layout: Workspace) => Workspace, keyboard = true): void {
    const runId = uiStore.getState().activeRunId;
    if (runId) actions.updateLayout(runId, op, keyboard);
  },

  /** Focus a tile in a run (switching run and to Strip mode when needed). */
  revealTile(runId: string, tileId: string, mode: LayoutMode | null = 'strip'): void {
    actions.setActiveRun(runId);
    if (mode && uiStore.getState().layoutMode !== mode && uiStore.getState().layoutMode !== 'focus')
      actions.setLayoutMode(mode);
    actions.updateLayout(runId, (layout) => focusTile(layout, tileId), true);
  },

  acknowledge(itemIds: readonly string[]): void {
    const { acknowledged } = uiStore.getState();
    if (itemIds.every((id) => acknowledged[id])) return;
    const next = { ...acknowledged };
    for (const id of itemIds) next[id] = true;
    uiStore.setState({ acknowledged: next });
  },
};

/** Urgent tiles across all runs, oldest inbox item first: what ⌘U cycles through. */
export function urgentTargets(): { runId: string; tileId: string; itemId: string }[] {
  const data = dataStore.getState();
  const { layouts } = uiStore.getState();
  const out: { runId: string; tileId: string; itemId: string }[] = [];
  for (const item of openInbox(data.inbox, '*')) {
    const layout = layouts[item.runId] ?? loadLayout(item.runId);
    const target = layout && allTiles(layout).find(({ tile }) => itemTargetsTile(item, tile, tileTaskId(tile)));
    if (target) out.push({ runId: item.runId, tileId: target.tile.id, itemId: item.id });
    else {
      // Layout not built yet (run never opened): fall back to its plan / first matching tile once opened.
      out.push({ runId: item.runId, tileId: '', itemId: item.id });
    }
  }
  return out;
}

/** Jump to the next urgent tile after the current focus (wrapping). Returns false when nothing is urgent. */
export function jumpToNextUrgent(): boolean {
  const targets = urgentTargets();
  if (targets.length === 0) return false;
  const { activeRunId, layouts } = uiStore.getState();
  const current = activeRunId ? layouts[activeRunId]?.focus?.tile : undefined;
  const index = targets.findIndex((t) => t.runId === activeRunId && t.tileId === current);
  const target = targets[(index + 1) % targets.length] ?? targets[0];
  if (!target) return false;
  actions.setActiveRun(target.runId);
  syncActiveLayout();
  let tileId = target.tileId;
  if (!tileId) {
    const layout = uiStore.getState().layouts[target.runId];
    const item = dataStore.getState().inbox[target.itemId];
    const found = layout && item && allTiles(layout).find(({ tile }) => itemTargetsTile(item, tile, tileTaskId(tile)));
    tileId = found ? found.tile.id : '';
  }
  if (tileId) actions.revealTile(target.runId, tileId);
  return true;
}

/** For tests and diagnostics. */
export function describeFocused(): ReturnType<typeof describeTile> | null {
  const { activeRunId, layouts } = uiStore.getState();
  const layout = activeRunId ? layouts[activeRunId] : undefined;
  const entry = layout?.focus && allTiles(layout).find(({ tile }) => tile.id === layout.focus?.tile);
  return entry && activeRunId ? describeTile(dataStore.getState(), activeRunId, entry.tile) : null;
}
