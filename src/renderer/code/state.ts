/**
 * The Code view's model: a project's workspaces. Code belongs to the project: its first workspace is the main
 * checkout, and you make more when you want them, on the project or on one of a run's worktrees (a task's, the
 * integration's). A worktree workspace is read-only while an agent works there, until you take it over.
 *
 * Inside a workspace the user arranges the tiles, i3-style (tree.ts). Tiles are terminals and viewers; a viewer
 * holds files and diffs as tabs, like an editor pane holds buffers: opening a file shows it in the focused viewer
 * (or the one used last) instead of making a window, and the unpinned preview tab is replaced by the next thing
 * opened. State is per project, in localStorage.
 */
import type { DiffTarget } from '@shared/rpc';
import { createStore } from 'zustand/vanilla';
import type { TileParamsByKind } from '../layout/types';
import {
  type Con,
  type ConLayout,
  cycleTabs,
  type Direction,
  emptyRoot,
  isSound,
  leaves,
  move,
  type Orientation,
  openBeside,
  remove,
  resize,
  reveal,
  setLayout,
  toggleSplit,
} from './tree';

export type TabKind = 'code' | 'diff';
export type ViewerTab =
  | { id: string; kind: 'code'; params: TileParamsByKind['code']; pinned: boolean }
  | { id: string; kind: 'diff'; params: TileParamsByKind['diff']; pinned: boolean };
export type TabParams<K extends TabKind> = TileParamsByKind[K];
export type TerminalParams = TileParamsByKind['terminal'];
export type PanelSection = 'changes' | 'files' | 'search' | 'activity';

export type TileSpec =
  | { kind: 'terminal'; params: TerminalParams }
  | { kind: 'viewer'; tabs: ViewerTab[]; active: string | null };

export interface Workspace {
  id: string;
  /** Null: named after what it is on (the project, or the run's task). */
  name: string | null;
  /** The checkout it works in: null = the project's main checkout, else a worktree's path. */
  checkout: string | null;
  /** The run (and task) whose worktree it is on, if any. */
  runId: string | null;
  taskId: string | null;
  /** The user took the worktree over: it is theirs to change even while the run goes on. */
  taken: boolean;
  root: Con;
  tiles: Record<string, TileSpec>;
  focus: string | null;
  /** Most recently focused tiles first (directional focus and "the viewer used last" remember them). */
  recent: string[];
  /** The tile shown alone (⌘F), or null. */
  fullscreen: string | null;
  panel: boolean;
  section: PanelSection;
  /** The panel's search query. */
  query: string;
  seq: number;
}

export interface ProjectCode {
  workspaces: Workspace[];
  /** The workspace on screen. */
  current: string | null;
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------

export interface WorkspaceOrigin {
  checkout: string | null;
  runId: string | null;
  taskId: string | null;
  name?: string | null;
  taken?: boolean;
}

export function newWorkspace(id: string, origin: WorkspaceOrigin): Workspace {
  return {
    id,
    name: origin.name ?? null,
    checkout: origin.checkout,
    runId: origin.runId,
    taskId: origin.taskId,
    taken: origin.taken ?? false,
    root: emptyRoot(),
    tiles: {},
    focus: null,
    recent: [],
    fullscreen: null,
    panel: origin.checkout === null,
    section: origin.runId ? 'changes' : 'files',
    query: '',
    seq: 1,
  };
}

export function emptyProject(): ProjectCode {
  return { workspaces: [], current: null };
}

export function addWorkspace(project: ProjectCode, workspace: Workspace): ProjectCode {
  return { workspaces: [...project.workspaces, workspace], current: workspace.id };
}

/** Remove a workspace; its left neighbour (else the next one) comes on screen. */
export function removeWorkspace(project: ProjectCode, id: string): ProjectCode {
  const at = project.workspaces.findIndex((w) => w.id === id);
  if (at === -1) return project;
  const workspaces = project.workspaces.filter((w) => w.id !== id);
  const current = project.current === id ? (workspaces[Math.max(0, at - 1)]?.id ?? null) : project.current;
  return { workspaces, current };
}

export function nextWorkspaceId(project: ProjectCode): string {
  let n = project.workspaces.length + 1;
  while (project.workspaces.some((w) => w.id === `w${n}`)) n++;
  return `w${n}`;
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

function touch(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, 24);
}

export function focusTile(ws: Workspace, id: string): Workspace {
  if (!ws.tiles[id]) return ws;
  const root = reveal(ws.root, id);
  if (ws.focus === id && ws.recent[0] === id && root === ws.root) return ws;
  const fullscreen = ws.fullscreen && ws.fullscreen !== id ? null : ws.fullscreen;
  return { ...ws, root, focus: id, recent: touch(ws.recent, id), fullscreen };
}

/** Add a tile beside the focused one along `orientation`, and focus it. */
export function addTile(ws: Workspace, spec: TileSpec, orientation: Orientation): [string, Workspace] {
  const id = `t${ws.seq}`;
  const root = openBeside(ws.root, ws.focus, id, orientation, `c${ws.seq}`);
  const next: Workspace = { ...ws, root, seq: ws.seq + 1, tiles: { ...ws.tiles, [id]: spec }, fullscreen: null };
  return [id, focusTile(next, id)];
}

/** Remove a tile; focus goes to the tile focused before it. */
export function closeTile(ws: Workspace, id: string): Workspace {
  if (!ws.tiles[id]) return ws;
  const { [id]: _gone, ...tiles } = ws.tiles;
  const root = remove(ws.root, id);
  const recent = ws.recent.filter((r) => r !== id && tiles[r]);
  const focus = ws.focus === id ? (recent[0] ?? leaves(root)[0] ?? null) : ws.focus;
  const next: Workspace = {
    ...ws,
    root,
    tiles,
    recent,
    focus,
    fullscreen: ws.fullscreen === id ? null : ws.fullscreen,
  };
  return focus ? focusTile(next, focus) : next;
}

export function setTerminal(ws: Workspace, id: string, params: TerminalParams): Workspace {
  const tile = ws.tiles[id];
  if (tile?.kind !== 'terminal') return ws;
  return { ...ws, tiles: { ...ws.tiles, [id]: { kind: 'terminal', params } } };
}

/** The terminal tile already showing this engine terminal (a takeover asked for twice). */
export function terminalTileOf(ws: Workspace, terminalId: string): string | null {
  for (const [id, tile] of Object.entries(ws.tiles)) {
    if (tile.kind === 'terminal' && tile.params.terminalId === terminalId) return id;
  }
  return null;
}

// Layout ops on the focused tile ------------------------------------------------------------------

export function moveFocused(ws: Workspace, dir: Direction): Workspace {
  if (!ws.focus) return ws;
  const root = move(ws.root, ws.focus, dir, `c${ws.seq}`);
  return root === ws.root ? ws : { ...ws, root, seq: ws.seq + 1 };
}

export function resizeFocused(ws: Workspace, dir: Direction, step = 0.05): Workspace {
  if (!ws.focus) return ws;
  const root = resize(ws.root, ws.focus, dir, step);
  return root === ws.root ? ws : { ...ws, root };
}

export function layoutFocused(ws: Workspace, layout: ConLayout | 'toggle'): Workspace {
  if (!ws.focus) return ws;
  const root = layout === 'toggle' ? toggleSplit(ws.root, ws.focus) : setLayout(ws.root, ws.focus, layout);
  return root === ws.root ? ws : { ...ws, root };
}

/** Step through the tabs of the tabbed or stacked container around the focused tile. */
export function cycleContainerTabs(ws: Workspace, step: 1 | -1): Workspace {
  if (!ws.focus) return ws;
  const cycled = cycleTabs(ws.root, ws.focus, step);
  if (!cycled) return ws;
  return focusTile({ ...ws, root: cycled.root }, cycled.focus);
}

export function toggleFullscreen(ws: Workspace, id: string | null = ws.focus): Workspace {
  if (!id) return ws;
  if (ws.fullscreen === id) return { ...ws, fullscreen: null };
  return focusTile({ ...ws, fullscreen: id }, id);
}

export function setPanel(ws: Workspace, panel: boolean, section: PanelSection = ws.section): Workspace {
  if (ws.panel === panel && ws.section === section) return ws;
  return { ...ws, panel, section };
}

// ---------------------------------------------------------------------------------------------
// Viewers and their tabs
// ---------------------------------------------------------------------------------------------

function targetKey(target: DiffTarget): string {
  switch (target.kind) {
    case 'task':
      return `task:${target.taskId}`;
    case 'run':
      return `run:${target.runId}`;
    case 'range':
      return `range:${target.runId}:${target.from}..${target.to}`;
    case 'commit':
      return `commit:${target.projectId}:${target.sha}`;
  }
}

/** What a tab shows, regardless of where in it: a file's path (any line), a diff's target. */
export function tabIdentity(tab: Pick<ViewerTab, 'kind' | 'params'>): string {
  return tab.kind === 'code'
    ? `code:${(tab.params as TabParams<'code'>).path}`
    : `diff:${targetKey((tab.params as TabParams<'diff'>).target)}`;
}

/** The viewer things open in: the focused tile when it is one, else the viewer used last; null for none. */
export function targetViewer(ws: Workspace): string | null {
  if (ws.focus && ws.tiles[ws.focus]?.kind === 'viewer') return ws.focus;
  return ws.recent.find((id) => ws.tiles[id]?.kind === 'viewer') ?? null;
}

/**
 * Show `params` in a viewer and focus it: a tab already showing the same thing is reused (and takes the new
 * line); otherwise the unpinned preview tab is replaced in place, else a new tab opens right of the active one.
 * Without a viewer, one opens beside the focused tile along `orientation`.
 */
export function openTab<K extends TabKind>(
  ws: Workspace,
  kind: K,
  params: TabParams<K>,
  pinned: boolean,
  orientation: Orientation,
): Workspace {
  let next = ws;
  let viewerId = targetViewer(ws);
  if (!viewerId) {
    [viewerId, next] = addTile(ws, { kind: 'viewer', tabs: [], active: null }, orientation);
  }
  const viewer = next.tiles[viewerId];
  if (viewer?.kind !== 'viewer') return ws;
  const identity = tabIdentity({ kind, params } as ViewerTab);
  const same = viewer.tabs.find((t) => tabIdentity(t) === identity);
  let tabs: ViewerTab[];
  let active: string;
  let seq = next.seq;
  if (same) {
    tabs = viewer.tabs.map((t) => (t.id === same.id ? ({ ...t, params, pinned: t.pinned || pinned } as ViewerTab) : t));
    active = same.id;
  } else {
    const preview = pinned ? undefined : viewer.tabs.find((t) => !t.pinned);
    // Always a new id, also in the preview's place: the body remounts for the new thing.
    const tab = { id: `b${seq++}`, kind, params, pinned } as ViewerTab;
    if (preview) tabs = viewer.tabs.map((t) => (t.id === preview.id ? tab : t));
    else {
      const at = viewer.tabs.findIndex((t) => t.id === viewer.active);
      tabs = [...viewer.tabs];
      tabs.splice(at === -1 ? tabs.length : at + 1, 0, tab);
    }
    active = tab.id;
  }
  const withTab: Workspace = { ...next, seq, tiles: { ...next.tiles, [viewerId]: { kind: 'viewer', tabs, active } } };
  return focusTile(withTab, viewerId);
}

function updateViewer(ws: Workspace, viewerId: string, change: (v: Extract<TileSpec, { kind: 'viewer' }>) => TileSpec) {
  const viewer = ws.tiles[viewerId];
  if (viewer?.kind !== 'viewer') return ws;
  const next = change(viewer);
  return next === viewer ? ws : { ...ws, tiles: { ...ws.tiles, [viewerId]: next } };
}

export function selectTab(ws: Workspace, viewerId: string, tabId: string): Workspace {
  return focusTile(
    updateViewer(ws, viewerId, (v) => (v.tabs.some((t) => t.id === tabId) ? { ...v, active: tabId } : v)),
    viewerId,
  );
}

export function pinTab(ws: Workspace, viewerId: string, tabId: string | null = null): Workspace {
  return updateViewer(ws, viewerId, (v) => {
    const id = tabId ?? v.active;
    if (!v.tabs.some((t) => t.id === id && !t.pinned)) return v;
    return { ...v, tabs: v.tabs.map((t) => (t.id === id ? { ...t, pinned: true } : t)) };
  });
}

/** Close a tab; the one to its right takes its place (else its left). A viewer with no tab left closes. */
export function closeTab(ws: Workspace, viewerId: string, tabId: string | null = null): Workspace {
  const viewer = ws.tiles[viewerId];
  if (viewer?.kind !== 'viewer') return ws;
  const id = tabId ?? viewer.active;
  const at = viewer.tabs.findIndex((t) => t.id === id);
  if (at === -1) return ws;
  const tabs = viewer.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return closeTile(ws, viewerId);
  const active = viewer.active === id ? (tabs[at]?.id ?? tabs[at - 1]?.id ?? null) : viewer.active;
  return { ...ws, tiles: { ...ws.tiles, [viewerId]: { ...viewer, tabs, active } } };
}

/** Step through a viewer's tabs (wrapping). */
export function cycleViewerTab(ws: Workspace, viewerId: string, step: 1 | -1): Workspace {
  const viewer = ws.tiles[viewerId];
  if (viewer?.kind !== 'viewer' || viewer.tabs.length < 2) return ws;
  const at = viewer.tabs.findIndex((t) => t.id === viewer.active);
  const next = viewer.tabs[(at + step + viewer.tabs.length) % viewer.tabs.length];
  return next ? selectTab(ws, viewerId, next.id) : ws;
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

const STORAGE_PREFIX = 'legion.code.';
const VERSION = 2;

function isWorkspace(value: unknown): value is Workspace {
  const w = value as Workspace | null;
  if (!w || typeof w.id !== 'string' || !w.tiles || typeof w.tiles !== 'object') return false;
  if (!isSound(w.root) || w.root.type !== 'con') return false;
  const ids = leaves(w.root);
  return ids.length === Object.keys(w.tiles).length && ids.every((id) => w.tiles[id] !== undefined);
}

export function loadProject(projectId: string): ProjectCode {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return emptyProject();
    const parsed = JSON.parse(raw) as { v?: number; workspaces?: unknown[]; current?: unknown };
    if (parsed.v !== VERSION || !Array.isArray(parsed.workspaces)) return emptyProject();
    const workspaces = parsed.workspaces.filter(isWorkspace).map((w) => ({
      ...newWorkspace(w.id, w),
      ...w,
      // Fullscreen is a moment, not a place: it is not restored.
      fullscreen: null,
      focus: w.focus && w.tiles[w.focus] ? w.focus : (leaves(w.root)[0] ?? null),
    }));
    const current =
      typeof parsed.current === 'string' && workspaces.some((w) => w.id === parsed.current)
        ? parsed.current
        : (workspaces[0]?.id ?? null);
    return { workspaces, current };
  } catch {
    return emptyProject();
  }
}

function saveProject(projectId: string, project: ProjectCode): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify({ v: VERSION, ...project }));
  } catch {
    // Storage full or unavailable: the workspaces just won't survive a reload.
  }
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

interface CodeState {
  projects: Record<string, ProjectCode>;
  /** Bumped when the keyboard moved focus to another tile: that tile takes DOM focus. */
  focusRequest: number;
  /** Bumped to put the caret in the panel's search field. */
  searchRequest: number;
  /** Bumped to move DOM focus into the panel. */
  panelRequest: number;
  /** Bumped to open the "new workspace" picker (⌘⌥N). */
  newRequest: number;
}

export const codeStore = createStore<CodeState>(() => ({
  projects: {},
  focusRequest: 0,
  searchRequest: 0,
  panelRequest: 0,
  newRequest: 0,
}));

const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(projectId: string): void {
  dirty.add(projectId);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { projects } = codeStore.getState();
    for (const id of dirty) {
      const project = projects[id];
      if (project) saveProject(id, project);
    }
    dirty.clear();
  }, 300);
}

/** Projects read from storage but not changed yet (reading must not write the store: it happens in render). */
const loaded = new Map<string, ProjectCode>();

export function projectCode(projectId: string): ProjectCode {
  const known = codeStore.getState().projects[projectId];
  if (known) return known;
  let project = loaded.get(projectId);
  if (!project) {
    project = loadProject(projectId);
    loaded.set(projectId, project);
  }
  return project;
}

export function workspaceOf(projectId: string, id: string | null): Workspace | null {
  if (!id) return null;
  return projectCode(projectId).workspaces.find((w) => w.id === id) ?? null;
}

export function updateProject(projectId: string, op: (project: ProjectCode) => ProjectCode): void {
  const current = projectCode(projectId);
  const next = op(current);
  if (next === current) return;
  codeStore.setState((s) => ({ projects: { ...s.projects, [projectId]: next } }));
  scheduleSave(projectId);
}

/** Apply an op to one workspace. `keyboard` moves DOM focus to the newly focused tile. */
export function updateWorkspace(
  projectId: string,
  id: string,
  op: (ws: Workspace) => Workspace,
  keyboard = false,
): void {
  updateProject(projectId, (project) => {
    const at = project.workspaces.findIndex((w) => w.id === id);
    const ws = project.workspaces[at];
    if (!ws) return project;
    const next = op(ws);
    if (next === ws) return project;
    const workspaces = [...project.workspaces];
    workspaces[at] = next;
    return { ...project, workspaces };
  });
  if (keyboard) codeStore.setState((s) => ({ focusRequest: s.focusRequest + 1 }));
}

/** For tests. */
export function resetCodeStore(): void {
  loaded.clear();
  codeStore.setState({ projects: {}, focusRequest: 0, searchRequest: 0, panelRequest: 0, newRequest: 0 });
}
