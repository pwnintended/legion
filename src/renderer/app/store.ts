/**
 * The renderer's two Zustand stores:
 * - `dataStore`: the client mirror of engine state (see data.ts), written only by sync.ts / demo mode.
 * - `uiStore`: what the user is looking at — active project and run, the view (the run's conversation, or its
 *   agents: the tiling workspace), overlays, layout mode, key mode, and the layouts of run workspaces (keyed by
 *   run id) and project homes (keyed `project:<id>`, see projects.ts). With an active project and no active
 *   run, the project's page is on screen: a new conversation (chat view) or the repository (agents view).
 *
 * Layout trees are kept in sync with run data here (outside React), so the strip is correct before render.
 */
import { createStore } from 'zustand/vanilla';
import { describeTile, itemTargetsTile, tileTaskId } from '../layout/describe';
import { clearLayout, loadLayout, saveLayout } from '../layout/persist';
import { defaultProjectLayout, isUsableProjectLayout } from '../layout/project';
import { type RunLayoutInput, syncWithRun } from '../layout/sync';
import { allTiles, focusTile, type LayoutMode, type Workspace } from '../layout/tree';
import { attemptsOfRun, type DataState, initialData, latestPlan, openInbox, selectRunList, tasksOfRun } from './data';
import { projectOfRun, projectWorkspaceKey, selectProjects } from './projects';

export type Overlay = 'composer' | 'palette' | 'settings' | 'addProject' | 'goto';
/** `chat`: the run's conversation (home of the app). `agents`: the tiling workspace of its agents. */
export type View = 'chat' | 'agents';
export type SettingsSection = 'engines' | 'agents' | 'access' | 'runs' | 'appearance';
export type KeyMode = 'normal' | 'resize' | 'move';

export interface UiState {
  activeRunId: string | null;
  /** The project in view: its home when `activeRunId` is null, else the active run's project. */
  activeProjectId: string | null;
  overlay: Overlay | null;
  view: View;
  /** A thread item the conversation should scroll to and highlight (`nonce` re-triggers the same item). */
  chatFocus: { itemId: string; nonce: number } | null;
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
  /** Section the settings overlay scrolls to when it opens. */
  settingsSection: SettingsSection | null;
}

const UI_PREFS_KEY = 'legion.ui';

type UiPrefs = Partial<Pick<UiState, 'activeRunId' | 'activeProjectId' | 'layoutMode' | 'view'>>;

function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    return raw ? (JSON.parse(raw) as UiPrefs) : {};
  } catch {
    return {};
  }
}

function savePrefs(state: UiState): void {
  try {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        activeRunId: state.activeRunId,
        activeProjectId: state.activeProjectId,
        layoutMode: state.layoutMode,
        view: state.view,
      }),
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
    activeProjectId: typeof prefs.activeProjectId === 'string' ? prefs.activeProjectId : null,
    overlay: null,
    view: prefs.view === 'agents' ? 'agents' : 'chat',
    chatFocus: null,
    layoutMode: mode,
    previousMode: 'strip',
    keyMode: 'normal',
    terminalLocked: false,
    layouts: {},
    acknowledged: {},
    focusRequest: 0,
    demo: false,
    settingsSection: null,
  };
}

export const dataStore = createStore<DataState>(() => initialData());
export const uiStore = createStore<UiState>(() => initialUi());

/** The workspace on screen: the active run's, else the active project's home (`project:<id>`), else none. */
export function activeWorkspaceKey(ui: Pick<UiState, 'activeRunId' | 'activeProjectId'>): string | null {
  return ui.activeRunId ?? (ui.activeProjectId ? projectWorkspaceKey(ui.activeProjectId) : null);
}

/** The project of whatever is on screen (a project home, or the active run's project). */
export function activeProjectOf(ui: Pick<UiState, 'activeRunId' | 'activeProjectId'>, data: DataState) {
  if (ui.activeRunId) return projectOfRun(data, data.runs[ui.activeRunId]) ?? null;
  return ui.activeProjectId ? (data.projects[ui.activeProjectId] ?? null) : null;
}

// ---------------------------------------------------------------------------------------------
// Layout ↔ run data
// ---------------------------------------------------------------------------------------------

export function runLayoutInput(data: DataState, runId: string): RunLayoutInput | null {
  const run = data.runs[runId];
  if (!run || data.loadedRuns[runId] === undefined) return null;
  const clarify = openInbox(data.inbox, runId).find((i) => i.kind === 'question' && i.payload.source === 'clarify');
  const attempts = attemptsOfRun(data.attempts, runId);
  return {
    runId,
    status: run.status,
    nodes: latestPlan(data, runId)?.dag.nodes ?? [],
    tasks: tasksOfRun(data.tasks, runId).map((t) => ({ id: t.id, nodeId: t.nodeId, status: t.status })),
    clarifyItemId: clarify?.id ?? null,
    hierarchy: attempts.some((a) => a.role === 'assistant' || a.role === 'lead'),
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

/**
 * Bring the active run's layout up to date with its data. Runs inside the data store's subscription, so it
 * must never throw: a layout the ops can't handle is discarded and re-derived from the run.
 */
export function syncActiveLayout(): void {
  const { activeRunId, activeProjectId, layouts } = uiStore.getState();
  if (!activeRunId) {
    if (activeProjectId) syncProjectLayout(activeProjectId);
    return;
  }
  try {
    const input = runLayoutInput(dataStore.getState(), activeRunId);
    if (!input) return;
    const current = layouts[activeRunId] ?? loadLayout(activeRunId);
    let next: Workspace;
    try {
      next = syncWithRun(current, input);
    } catch (error) {
      console.error(`[legion] layout of ${activeRunId} is unusable; rebuilding it`, error);
      clearLayout(activeRunId);
      next = syncWithRun(null, input);
    }
    if (next === layouts[activeRunId]) return;
    uiStore.setState({ layouts: { ...uiStore.getState().layouts, [activeRunId]: next } });
    scheduleSave(activeRunId);
  } catch (error) {
    console.error('[legion] layout sync failed', error);
  }
}

/** A project home's layout: the stored one when it still fits the project, else the default home. */
function syncProjectLayout(projectId: string): void {
  const key = projectWorkspaceKey(projectId);
  const { layouts } = uiStore.getState();
  if (layouts[key]) return;
  const stored = loadLayout(key);
  const layout = isUsableProjectLayout(stored, projectId) ? stored : defaultProjectLayout(key, projectId);
  uiStore.setState({ layouts: { ...uiStore.getState().layouts, [key]: layout } });
}

/**
 * Keep something sensible on screen: a vanished run falls back to its project's home (or the first run); a
 * vanished project to the first run, or the first project's home; nothing selected yet (first launch, or prefs
 * from before projects existed) picks the first run, else the first project.
 */
function ensureActiveRun(): void {
  const data = dataStore.getState();
  if (!data.connection.loaded) return;
  const { activeRunId, activeProjectId } = uiStore.getState();
  if (activeRunId && data.runs[activeRunId]) {
    const project = projectOfRun(data, data.runs[activeRunId]);
    if (project && project.id !== activeProjectId) uiStore.setState({ activeProjectId: project.id });
    return;
  }
  const projectAlive = activeProjectId !== null && data.projects[activeProjectId] !== undefined;
  if (activeRunId && projectAlive) {
    actions.openProjectHome(activeProjectId);
    return;
  }
  if (!activeRunId && projectAlive) return;
  const first = selectRunList(data)[0];
  if (first) {
    actions.setActiveRun(first.id);
    return;
  }
  const project = selectProjects(data)[0];
  if (project) actions.openProjectHome(project.id);
  else if (activeRunId !== null || activeProjectId !== null) {
    uiStore.setState({ activeRunId: null, activeProjectId: null });
    savePrefs(uiStore.getState());
  }
}

let lastInputs: unknown[] = [];
dataStore.subscribe((data) => {
  ensureActiveRun();
  // Only resync when something the layout depends on changed (not on every agent event).
  const ui = uiStore.getState();
  const inputs = [
    data.runs,
    data.plans,
    data.tasks,
    data.inbox,
    data.loadedRuns,
    data.projects,
    ui.activeRunId,
    ui.activeProjectId,
  ];
  if (inputs.every((v, i) => v === lastInputs[i])) return;
  lastInputs = inputs;
  syncActiveLayout();
});

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export const actions = {
  setActiveRun(runId: string | null): void {
    const state = uiStore.getState();
    const data = dataStore.getState();
    const project = runId ? projectOfRun(data, data.runs[runId]) : null;
    const activeProjectId = project?.id ?? state.activeProjectId;
    if (state.activeRunId === runId && state.activeProjectId === activeProjectId) return;
    uiStore.setState({ activeRunId: runId, activeProjectId, keyMode: 'normal' });
    savePrefs(uiStore.getState());
    syncActiveLayout();
  },

  /** Show a project's home (no run focused). */
  openProjectHome(projectId: string): void {
    const state = uiStore.getState();
    if (state.activeRunId === null && state.activeProjectId === projectId) return;
    uiStore.setState({ activeRunId: null, activeProjectId: projectId, keyMode: 'normal' });
    savePrefs(uiStore.getState());
    syncActiveLayout();
  },

  openOverlay(overlay: Overlay): void {
    uiStore.setState({ overlay });
  },
  openSettings(section: SettingsSection | null = null): void {
    uiStore.setState({ overlay: 'settings', settingsSection: section });
  },
  toggleOverlay(overlay: Overlay): void {
    uiStore.setState((s) => ({ overlay: s.overlay === overlay ? null : overlay }));
  },
  closeOverlay(): void {
    if (uiStore.getState().overlay !== null)
      uiStore.setState({ overlay: null, focusRequest: uiStore.getState().focusRequest + 1 });
  },

  setView(view: View): void {
    if (uiStore.getState().view === view) return;
    uiStore.setState({ view, keyMode: 'normal' });
    savePrefs(uiStore.getState());
  },
  toggleView(): void {
    actions.setView(uiStore.getState().view === 'chat' ? 'agents' : 'chat');
  },

  /** Show a thread item of a run's conversation (a decision card, a presentation). */
  focusChatItem(runId: string, itemId: string): void {
    actions.setActiveRun(runId);
    actions.setView('chat');
    uiStore.setState({ chatFocus: { itemId, nonce: (uiStore.getState().chatFocus?.nonce ?? 0) + 1 } });
  },

  /** A layout mode of the agents view (switching to it). */
  setLayoutMode(mode: LayoutMode): void {
    const { layoutMode, view } = uiStore.getState();
    if (view !== 'agents') uiStore.setState({ view: 'agents' });
    if (layoutMode === mode) {
      if (view !== 'agents') savePrefs(uiStore.getState());
      return;
    }
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

  /** Apply a layout op to the workspace on screen (the active run's, or the project home). */
  layout(op: (layout: Workspace) => Workspace, keyboard = true): void {
    const key = activeWorkspaceKey(uiStore.getState());
    if (key) actions.updateLayout(key, op, keyboard);
  },

  /** Focus a tile in a run (switching run, to the agents view, and to Strip mode when needed). */
  revealTile(runId: string, tileId: string, mode: LayoutMode | null = 'strip'): void {
    actions.setActiveRun(runId);
    actions.setView('agents');
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

/** The run a ⌘U cycle started from: its decisions come first for the whole cycle (a stable order). */
let cycleAnchor: string | null = null;

/** Open decisions in ⌘U order: `firstRun`'s, then every other run's, each oldest first. */
export function openDecisions(firstRun: string | null = null): { runId: string; itemId: string }[] {
  const items = openInbox(dataStore.getState().inbox, '*');
  return [...items.filter((i) => i.runId === firstRun), ...items.filter((i) => i.runId !== firstRun)].map((item) => ({
    runId: item.runId,
    itemId: item.id,
  }));
}

/**
 * Show the next open decision as its card in the run's conversation. A cycle starts with the run on screen and
 * keeps that order while it lasts (the shown card stays the reference), so every open decision is reached once
 * per round. Returns false when nothing waits.
 */
export function jumpToNextDecision(): boolean {
  const { activeRunId, chatFocus } = uiStore.getState();
  const focused = chatFocus?.itemId.startsWith('inbox:') ? chatFocus.itemId.slice('inbox:'.length) : null;
  const continuing = focused !== null && dataStore.getState().inbox[focused]?.resolvedAt === null;
  if (!continuing || cycleAnchor === null) cycleAnchor = activeRunId;
  const targets = openDecisions(cycleAnchor);
  if (targets.length === 0) return false;
  const index = continuing ? targets.findIndex((t) => t.itemId === focused) : -1;
  const target = targets[(index + 1) % targets.length] ?? targets[0];
  if (!target) return false;
  actions.focusChatItem(target.runId, `inbox:${target.itemId}`);
  return true;
}

/** For tests and diagnostics. */
export function describeFocused(): ReturnType<typeof describeTile> | null {
  const { activeRunId, layouts } = uiStore.getState();
  const layout = activeRunId ? layouts[activeRunId] : undefined;
  const entry = layout?.focus && allTiles(layout).find(({ tile }) => tile.id === layout.focus?.tile);
  return entry && activeRunId ? describeTile(dataStore.getState(), activeRunId, entry.tile) : null;
}
