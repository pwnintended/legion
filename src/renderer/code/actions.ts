/**
 * The Code view's actions over the app: the workspace on screen, making and closing workspaces, opening files,
 * diffs, the search and terminals in the right place, and taking a worktree over from its agent.
 */
import type { Attempt } from '@shared/domain';
import type { DiffTarget } from '@shared/rpc';
import { confirmAction } from '../app/confirm';
import type { DataState } from '../app/data';
import { rpc } from '../app/hooks';
import { projectOfRun } from '../app/projects';
import { actions, activeProjectOf, dataStore, uiStore } from '../app/store';
import { confirmClose } from '../tiles/code/editor/buffers';
import {
  addTile,
  addWorkspace,
  closeTab,
  closeTile,
  codeStore,
  focusTile,
  newWorkspace,
  nextWorkspaceId,
  openTab,
  projectCode,
  removeWorkspace,
  setPanel,
  type TabParams,
  type TerminalParams,
  terminalTileOf,
  updateProject,
  updateWorkspace,
  type Workspace,
  type WorkspaceOrigin,
  workspaceOf,
} from './state';
import type { Orientation } from './tree';
import { shownLayout } from './view';

/** The project whose workspaces are in view (or would be, in the Code view). */
export function codeProjectId(): string | null {
  return activeProjectOf(uiStore.getState(), dataStore.getState())?.id ?? null;
}

/** The project and workspace on screen in the Code view; null outside it. */
export function onScreen(): { projectId: string; ws: Workspace } | null {
  if (uiStore.getState().view !== 'code') return null;
  const projectId = codeProjectId();
  if (!projectId) return null;
  const ws = workspaceOf(projectId, projectCode(projectId).current);
  return ws ? { projectId, ws } : null;
}

/** Apply an op to the workspace on screen. */
export function updateOnScreen(op: (ws: Workspace) => Workspace, keyboard = true): void {
  const here = onScreen();
  if (here) updateWorkspace(here.projectId, here.ws.id, op, keyboard);
}

function projectPath(projectId: string): string | null {
  return dataStore.getState().projects[projectId]?.path ?? null;
}

/** The live coding agent of a task (its coder or resolver, running), if any. */
export function liveAgent(data: DataState, taskId: string | null): Attempt | null {
  if (!taskId) return null;
  return (
    Object.values(data.attempts).find(
      (a) => a.taskId === taskId && a.status === 'running' && (a.role === 'coder' || a.role === 'resolver'),
    ) ?? null
  );
}

/** A worktree workspace is read-only while an agent works in it, until the user takes it over. */
export function isReadOnly(data: DataState, ws: Workspace): boolean {
  return ws.checkout !== null && !ws.taken && liveAgent(data, ws.taskId) !== null;
}

/**
 * Which way a new tile splits the focused one: along its longer side (side by side unless it is taller than
 * wide), so tiles never turn into slivers. Without geometry yet, side by side.
 */
function autoOrientation(ws: Workspace): Orientation {
  const rect = shownLayout()?.tiles.find((t) => t.id === ws.focus)?.rect;
  if (!rect) return 'h';
  return rect.w >= rect.h ? 'h' : 'v';
}

// Workspaces -------------------------------------------------------------------------------------

/** Make a workspace (on screen), with a shell in its checkout to start with unless told otherwise. */
export function createWorkspace(projectId: string, origin: WorkspaceOrigin, shell = true): string {
  let id = '';
  updateProject(projectId, (p) => {
    id = nextWorkspaceId(p);
    let ws = newWorkspace(id, origin);
    const cwd = origin.checkout ?? projectPath(projectId);
    if (shell && cwd)
      [, ws] = addTile(ws, { kind: 'terminal', params: { terminalId: null, cwd, attemptId: null } }, 'h');
    return addWorkspace(p, ws);
  });
  codeStore.setState((s) => ({ focusRequest: s.focusRequest + 1 }));
  return id;
}

/** A project's first visit to Code: its main checkout, a shell in it. */
export function ensureWorkspace(projectId: string): void {
  if (projectCode(projectId).workspaces.length > 0) return;
  createWorkspace(projectId, { checkout: null, runId: null, taskId: null });
}

/** Put a workspace on screen in the Code view. */
export function showWorkspace(projectId: string, id: string): void {
  if (codeProjectId() !== projectId) actions.openProjectHome(projectId);
  actions.setView('code');
  updateProject(projectId, (p) =>
    p.current === id || !p.workspaces.some((w) => w.id === id) ? p : { ...p, current: id },
  );
}

/** The workspace on `checkout` (making it when there is none, with a shell unless `shell` is false). */
export function workspaceFor(projectId: string, origin: WorkspaceOrigin, shell = true): string {
  const existing = projectCode(projectId).workspaces.find((w) => w.checkout === origin.checkout);
  if (existing) {
    if (origin.taken && !existing.taken) updateWorkspace(projectId, existing.id, (w) => ({ ...w, taken: true }));
    showWorkspace(projectId, existing.id);
    return existing.id;
  }
  if (codeProjectId() !== projectId) actions.openProjectHome(projectId);
  const id = createWorkspace(projectId, origin, shell);
  actions.setView('code');
  return id;
}

/** ⌘1–9 in Code. */
export function gotoWorkspace(n: number): void {
  const projectId = codeProjectId();
  const ws = projectId ? projectCode(projectId).workspaces[n - 1] : undefined;
  if (projectId && ws) showWorkspace(projectId, ws.id);
}

/** ⌃Tab / ⌃⇧Tab: the next or previous workspace (wrapping). */
export function cycleWorkspace(step: 1 | -1): void {
  const here = onScreen();
  if (!here) return;
  const list = projectCode(here.projectId).workspaces;
  const at = list.findIndex((w) => w.id === here.ws.id);
  const next = list[(at + step + list.length) % list.length];
  if (next && next.id !== here.ws.id) showWorkspace(here.projectId, next.id);
}

/** Close a workspace and the shells in it (asked first when any are open). */
export async function closeWorkspace(projectId: string, id: string): Promise<void> {
  const ws = workspaceOf(projectId, id);
  if (!ws) return;
  const tabs = Object.values(ws.tiles).flatMap((t) => (t.kind === 'viewer' ? t.tabs.map((tab) => tab.id) : []));
  if (!(await confirmClose(tabs))) return;
  const terminals = Object.values(ws.tiles).flatMap((t) => (t.kind === 'terminal' ? [t.params] : []));
  if (terminals.length > 0) {
    const one = terminals.length === 1;
    const ok = await confirmAction({
      title: 'Close this workspace?',
      body: [
        `Its ${one ? 'terminal' : `${terminals.length} terminals`} will close, and anything running in ${one ? 'it' : 'them'} stops.`,
      ],
      confirmLabel: 'Close workspace',
      tone: 'warn',
    });
    if (!ok) return;
  }
  for (const params of terminals) {
    if (params.terminalId) void rpc('terminals.close', { terminalId: params.terminalId }).catch(() => {});
  }
  updateProject(projectId, (p) => removeWorkspace(p, id));
  ensureWorkspace(projectId);
}

/**
 * Take a worktree workspace over: the agent working there is handed to you in a terminal (its session resumed
 * interactively), and the workspace is yours to change from then on.
 */
export async function takeOverWorkspace(projectId: string, id: string): Promise<void> {
  const ws = workspaceOf(projectId, id);
  if (!ws) return;
  const agent = liveAgent(dataStore.getState(), ws.taskId);
  updateWorkspace(projectId, id, (w) => ({ ...w, taken: true }));
  if (agent) {
    const { takeOver } = await import('../tiles/session/actions');
    await takeOver(agent);
  }
}

// Tiles ------------------------------------------------------------------------------------------

/** A shell in the workspace on screen (in its checkout), beside the focused tile; `split` forces the side. */
export function openShellHere(split: Orientation | null = null): void {
  const projectId = codeProjectId();
  if (!projectId) return;
  if (uiStore.getState().view !== 'code') actions.setView('code');
  ensureWorkspace(projectId);
  const ws = workspaceOf(projectId, projectCode(projectId).current);
  if (!ws) return;
  const cwd = ws.checkout ?? projectPath(projectId);
  if (!cwd) return;
  const params: TerminalParams = { terminalId: null, cwd, attemptId: null };
  updateWorkspace(
    projectId,
    ws.id,
    (w) => addTile(w, { kind: 'terminal', params }, split ?? autoOrientation(w))[1],
    true,
  );
}

/**
 * Open a terminal for something of a run: a takeover (the agent's session) or a shell in a task's worktree goes
 * to the workspace on that worktree (made when needed; a takeover marks it taken); anything else to the
 * workspace on screen. Switches the Code view to it.
 */
export function openTerminal(params: TerminalParams, runId: string | null = null): string | null {
  const data = dataStore.getState();
  const run = runId ? data.runs[runId] : undefined;
  const projectId = run ? (projectOfRun(data, run)?.id ?? null) : codeProjectId();
  if (!projectId) return null;
  const attempt = params.attemptId ? data.attempts[params.attemptId] : undefined;
  const task =
    (attempt?.taskId ? data.tasks[attempt.taskId] : undefined) ??
    Object.values(data.tasks).find((t) => t.worktreePath && t.worktreePath === params.cwd);
  let wsId: string;
  if (task?.worktreePath) {
    wsId = workspaceFor(
      projectId,
      { checkout: task.worktreePath, runId: task.runId, taskId: task.id, taken: attempt !== undefined },
      false,
    );
  } else {
    if (codeProjectId() !== projectId) actions.openProjectHome(projectId);
    ensureWorkspace(projectId);
    wsId = projectCode(projectId).current as string;
    showWorkspace(projectId, wsId);
  }
  let opened: string | null = null;
  updateWorkspace(
    projectId,
    wsId,
    (w) => {
      const existing = params.terminalId ? terminalTileOf(w, params.terminalId) : null;
      if (existing) {
        opened = existing;
        return focusTile(w, existing);
      }
      const [id, next] = addTile(w, { kind: 'terminal', params }, autoOrientation(w));
      opened = id;
      return next;
    },
    true,
  );
  return opened;
}

/** Close a terminal tile and end its shell (a dev server in it goes with it). */
export function closeTerminal(projectId: string, wsId: string, id: string): void {
  const tile = workspaceOf(projectId, wsId)?.tiles[id];
  if (tile?.kind === 'terminal' && tile.params.terminalId)
    void rpc('terminals.close', { terminalId: tile.params.terminalId }).catch(() => {});
  updateWorkspace(projectId, wsId, (w) => closeTile(w, id), true);
}

/**
 * ⌘W: the viewer's tab on show (the viewer goes with its last tab; unsaved edits are asked about first), or the
 * focused terminal.
 */
export async function closeFocused(): Promise<void> {
  const here = onScreen();
  const focus = here?.ws.focus;
  if (!here || !focus) return;
  const tile = here.ws.tiles[focus];
  if (tile?.kind === 'viewer') {
    if (tile.active && !(await confirmClose([tile.active]))) return;
    updateWorkspace(here.projectId, here.ws.id, (w) => closeTab(w, focus), true);
  } else closeTerminal(here.projectId, here.ws.id, focus);
}

export interface OpenTabOptions {
  /** Keep the tab (not the preview). */
  pinned?: boolean;
}

/**
 * Show a file or a diff in the project's current workspace: in the focused viewer, else the viewer used last,
 * else a new viewer beside the focused tile. A file is read from the workspace's checkout. Opened from the side
 * panel, the keyboard stays in the panel (keep browsing); from anywhere else it moves to the viewer.
 */
export function openInViewer<K extends 'code' | 'diff'>(
  projectId: string,
  kind: K,
  params: TabParams<K>,
  options: OpenTabOptions = {},
): void {
  if (codeProjectId() !== projectId) actions.openProjectHome(projectId);
  ensureWorkspace(projectId);
  const ws = workspaceOf(projectId, projectCode(projectId).current);
  if (!ws) return;
  showWorkspace(projectId, ws.id);
  const active = document.activeElement;
  const fromPanel = active !== null && active.closest('.cw-panel') !== null;
  const withCheckout = (kind === 'code' ? { ...params, checkout: ws.checkout } : params) as TabParams<K>;
  updateWorkspace(
    projectId,
    ws.id,
    (w) => openTab(w, kind, withCheckout, options.pinned ?? false, autoOrientation(w)),
    !fromPanel,
  );
}

export function openDiff(projectId: string, target: DiffTarget, options: OpenTabOptions = {}): void {
  openInViewer(projectId, 'diff', { target }, options);
}

// Panel ------------------------------------------------------------------------------------------

/** Open the panel on a section (and put the caret in the search field for the search). */
export function showPanel(section: Workspace['section'], query: string | null = null): void {
  const projectId = codeProjectId();
  if (!projectId) return;
  if (uiStore.getState().view !== 'code') actions.setView('code');
  ensureWorkspace(projectId);
  const id = projectCode(projectId).current;
  if (!id) return;
  updateWorkspace(projectId, id, (w) => {
    const opened = setPanel(w, true, section);
    return query !== null && query !== opened.query ? { ...opened, query } : opened;
  });
  codeStore.setState((s) =>
    section === 'search' ? { searchRequest: s.searchRequest + 1 } : { panelRequest: s.panelRequest + 1 },
  );
}

export function togglePanel(): void {
  const here = onScreen();
  if (!here) return;
  if (here.ws.panel) {
    updateWorkspace(here.projectId, here.ws.id, (w) => setPanel(w, false), true);
    return;
  }
  showPanel(here.ws.section);
}
