/**
 * The renderer's two Zustand stores:
 * - `dataStore`: the client mirror of engine state (see data.ts), written only by sync.ts / demo mode.
 * - `uiStore`: what the user is looking at — active project and run, the view (the project's board of
 *   conversations, the run's route map of agents, or the project's code), overlays, and the layout trees of
 *   runs (keyed by run id).
 *
 * A run's layout tree is the model behind its route map: the focused tile is the pane on screen, and tile ids
 * stay stable for commands and jumps. It is kept in sync with the run's data here (outside React), so it is
 * correct before render. The Code view's workspaces have their own store (code/state.ts).
 */
import { createStore } from 'zustand/vanilla';
import { describeTile, itemTargetsTile, tileTaskId } from '../layout/describe';
import { clearLayout, loadLayout, saveLayout } from '../layout/persist';
import { type RunLayoutInput, syncWithRun } from '../layout/sync';
import { allTiles, focusTile, type Workspace } from '../layout/tree';
import {
  attemptsOfRun,
  type DataState,
  hasAgents,
  initialData,
  latestPlan,
  openInbox,
  selectRunList,
  tasksOfRun,
} from './data';
import { projectOfRun, selectProjects } from './projects';

export type Overlay = 'composer' | 'session' | 'palette' | 'settings' | 'addProject' | 'goto';
/**
 * `chat`: the project's board of conversations (home of the app). `agents`: the active run's route map, one
 * station (task, plan, integration, pull request, crew) at a time. `code`: the project's workspaces (its own,
 * and one per run), with files, diffs and terminals (code/).
 */
export type View = 'chat' | 'agents' | 'code';
export type SettingsSection = 'engines' | 'agents' | 'access' | 'gates' | 'runs' | 'appearance';

export interface UiState {
  activeRunId: string | null;
  /** The project in view: its home when `activeRunId` is null, else the active run's project. */
  activeProjectId: string | null;
  overlay: Overlay | null;
  view: View;
  /** A thread item the conversation should scroll to and highlight (`nonce` re-triggers the same item). */
  chatFocus: { itemId: string; nonce: number } | null;
  /**
   * A plan node selected on a run's route map that has no task yet (before execution): it has no tile, so the
   * pane shows its brief. Cleared when a tile is focused from the map.
   */
  mapNode: Record<string, string | null>;
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

type UiPrefs = Partial<Pick<UiState, 'activeRunId' | 'activeProjectId' | 'view'>>;

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
        view: state.view,
      }),
    );
  } catch {
    // ignore
  }
}

export function initialUi(): UiState {
  const prefs = loadPrefs();
  return {
    activeRunId: typeof prefs.activeRunId === 'string' ? prefs.activeRunId : null,
    activeProjectId: typeof prefs.activeProjectId === 'string' ? prefs.activeProjectId : null,
    overlay: null,
    // The agents are a conversation's inside, never a place to launch into: a saved agents view reopens the board.
    view: prefs.view === 'code' ? 'code' : 'chat',
    chatFocus: null,
    mapNode: {},
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
  const { activeRunId, layouts } = uiStore.getState();
  if (!activeRunId) return;
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
    uiStore.setState({ activeRunId: runId, activeProjectId });
    savePrefs(uiStore.getState());
    syncActiveLayout();
  },

  /** Show a project's home (no run focused). */
  openProjectHome(projectId: string): void {
    const state = uiStore.getState();
    if (state.activeRunId === null && state.activeProjectId === projectId) return;
    uiStore.setState({ activeRunId: null, activeProjectId: projectId });
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

  /** Switch view. The agents need a run with a plan or tasks: without one nothing changes. */
  setView(view: View): void {
    if (view === 'agents' && !hasAgents(dataStore.getState(), uiStore.getState().activeRunId)) return;
    if (uiStore.getState().view === view) return;
    uiStore.setState({ view });
    savePrefs(uiStore.getState());
    syncActiveLayout();
  },

  /** Show a thread item of a run's conversation (a decision card, a presentation). */
  focusChatItem(runId: string, itemId: string): void {
    actions.setActiveRun(runId);
    actions.setView('chat');
    uiStore.setState({ chatFocus: { itemId, nonce: (uiStore.getState().chatFocus?.nonce ?? 0) + 1 } });
  },

  /** Select a plan node with no task yet on a run's route map (null clears it). */
  selectMapNode(runId: string, nodeId: string | null): void {
    const { mapNode } = uiStore.getState();
    if ((mapNode[runId] ?? null) === nodeId) return;
    uiStore.setState({ mapNode: { ...mapNode, [runId]: nodeId } });
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
    // Focusing a tile leaves a selected task-less plan node behind.
    const refocused = next.focus?.tile !== current.focus?.tile && state.mapNode[runId];
    uiStore.setState({
      layouts: { ...state.layouts, [runId]: next },
      mapNode: refocused ? { ...state.mapNode, [runId]: null } : state.mapNode,
      acknowledged,
      focusRequest: keyboard ? state.focusRequest + 1 : state.focusRequest,
    });
    scheduleSave(runId);
  },

  /** Apply a layout op to the active run's tree (the route map's). */
  layout(op: (layout: Workspace) => Workspace, keyboard = true): void {
    const { activeRunId } = uiStore.getState();
    if (activeRunId) actions.updateLayout(activeRunId, op, keyboard);
  },

  /** Focus a tile in a run: switch to the run and its agents, and show the tile's station on the route map. */
  revealTile(runId: string, tileId: string): void {
    actions.setActiveRun(runId);
    actions.setView('agents');
    actions.selectMapNode(runId, null);
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
