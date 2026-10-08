import { describe, expect, it } from 'vitest';
import {
  addTile,
  addWorkspace,
  closeTab,
  closeTile,
  cycleViewerTab,
  emptyProject,
  focusTile,
  layoutFocused,
  moveFocused,
  newWorkspace,
  openTab,
  pinTab,
  removeWorkspace,
  type TerminalParams,
  type Workspace,
} from './state';
import { leaves } from './tree';

const shell = (cwd = '/repo'): TerminalParams => ({ terminalId: null, cwd, attemptId: null });
const file = (path: string, line: number | null = null) => ({ projectId: 'p', path, line, endLine: null });
const ws0 = () => newWorkspace('w1', { checkout: null, runId: null, taskId: null });
const viewerTabs = (ws: Workspace) => {
  const id = Object.keys(ws.tiles).find((k) => ws.tiles[k]?.kind === 'viewer');
  const tile = id ? ws.tiles[id] : undefined;
  return tile?.kind === 'viewer' ? tile : null;
};
const paths = (ws: Workspace) => viewerTabs(ws)?.tabs.map((t) => (t.kind === 'code' ? t.params.path : 'diff')) ?? [];

describe('code workspaces', () => {
  it('starts on the project with its panel open; a worktree workspace on its run, panel closed', () => {
    expect(ws0()).toMatchObject({ checkout: null, panel: true, section: 'files', taken: false });
    expect(newWorkspace('w2', { checkout: '/wt/T4', runId: 'r', taskId: 't' })).toMatchObject({
      panel: false,
      section: 'changes',
    });
  });

  it('adds tiles beside the focused one and closes them back to the tile focused before', () => {
    const [a, first] = addTile(ws0(), { kind: 'terminal', params: shell() }, 'h');
    let [b, ws] = addTile(first, { kind: 'terminal', params: shell() }, 'v');
    expect(leaves(ws.root)).toEqual([a, b]);
    expect(ws.focus).toBe(b);
    ws = closeTile(ws, b);
    expect(ws.focus).toBe(a);
    expect(Object.keys(ws.tiles)).toEqual([a]);
  });

  it('opens files into one viewer, replacing the preview; pinned tabs stay; no viewer → one beside the focus', () => {
    let [, ws] = addTile(ws0(), { kind: 'terminal', params: shell() }, 'h');
    ws = openTab(ws, 'code', file('a.ts'), false, 'h');
    expect(Object.values(ws.tiles).map((t) => t.kind)).toEqual(['terminal', 'viewer']);
    ws = openTab(ws, 'code', file('b.ts'), false, 'h');
    expect(paths(ws)).toEqual(['b.ts']);
    ws = openTab(ws, 'code', file('c.ts'), true, 'h');
    ws = openTab(ws, 'code', file('d.ts'), false, 'h');
    expect(paths(ws)).toEqual(['d.ts', 'c.ts']);
    // The same file again is the same tab, at the new line.
    ws = openTab(ws, 'code', file('c.ts', 9), false, 'h');
    expect(paths(ws)).toEqual(['d.ts', 'c.ts']);
    expect(viewerTabs(ws)?.tabs[1]?.params).toEqual(file('c.ts', 9));
    // Still one viewer, focused: opening never makes windows once there is one.
    expect(Object.values(ws.tiles).filter((t) => t.kind === 'viewer')).toHaveLength(1);
  });

  it('opens into the viewer used last when a terminal has the focus', () => {
    let [term, ws] = addTile(ws0(), { kind: 'terminal', params: shell() }, 'h');
    ws = openTab(ws, 'code', file('a.ts'), true, 'h');
    ws = focusTile(ws, term);
    ws = openTab(ws, 'code', file('b.ts'), true, 'h');
    expect(paths(ws)).toEqual(['a.ts', 'b.ts']);
  });

  it('pins, cycles and closes tabs; the viewer closes with its last tab', () => {
    let ws = openTab(ws0(), 'code', file('a.ts'), false, 'h');
    const viewer = ws.focus as string;
    ws = pinTab(ws, viewer);
    expect(viewerTabs(ws)?.tabs[0]?.pinned).toBe(true);
    ws = openTab(ws, 'diff', { target: { kind: 'task', taskId: 't1' } }, false, 'h');
    expect(paths(ws)).toEqual(['a.ts', 'diff']);
    expect(cycleViewerTab(ws, viewer, 1).tiles[viewer]).toMatchObject({ active: viewerTabs(ws)?.tabs[0]?.id });
    ws = closeTab(ws, viewer);
    expect(paths(ws)).toEqual(['a.ts']);
    ws = closeTab(ws, viewer);
    expect(ws.tiles).toEqual({});
    expect(ws.focus).toBeNull();
  });

  it('moves the focused tile and turns its container into tabs', () => {
    const [a, first] = addTile(ws0(), { kind: 'terminal', params: shell() }, 'h');
    let [b, ws] = addTile(first, { kind: 'terminal', params: shell() }, 'h');
    ws = moveFocused(ws, 'left');
    expect(leaves(ws.root)).toEqual([b, a]);
    ws = layoutFocused(ws, 'tabbed');
    expect(ws.root.layout).toBe('tabbed');
    // Focusing a tile behind a tab shows it.
    ws = focusTile(ws, a);
    expect(ws.root.children[ws.root.active]?.id).toBe(a);
  });

  it('keeps workspaces in the order made; closing one shows its left neighbour', () => {
    let p = addWorkspace(emptyProject(), ws0());
    p = addWorkspace(p, newWorkspace('w2', { checkout: '/wt', runId: 'r', taskId: 't' }));
    p = addWorkspace(p, newWorkspace('w3', { checkout: null, runId: null, taskId: null }));
    expect(p.current).toBe('w3');
    p = removeWorkspace(p, 'w3');
    expect(p.current).toBe('w2');
    expect(p.workspaces.map((w) => w.id)).toEqual(['w1', 'w2']);
  });
});
