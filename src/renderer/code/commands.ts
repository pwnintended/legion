/**
 * The Code view's keyboard, i3-style, every binding a ⌘-chord (terminals keep every other key):
 * - ⌘T a terminal beside the focused tile (along its longer side), ⌘D one to its right, ⌘⇧D one below.
 * - ⌘⌥ HJKL / arrows focus, ⌘⌥⇧ HJKL / arrows move the tile, ⌘⌃ HJKL / arrows resize it.
 * - ⌘⌥T tabbed, ⌘⌥S stacked, ⌘⌥E split (again: the other way) for the container around the focused tile.
 * - ⌘F the focused tile alone (Esc tiles again), ⌘W close the viewer's tab or the terminal, ⌘S save the file.
 * - Inside the editor, ⌘F (find) and ⌘D (select the next occurrence) are the editor's.
 * - ⌘⇧[ / ⌘⇧] the viewer's tabs (or a tabbed container's), ⌘⏎ keep the preview tab.
 * - ⌘1–9 the workspaces (in Code; elsewhere they stay the rail's runs), ⌃Tab / ⌃⇧Tab step through them, ⌘⌥N a
 *   new workspace, ⌘B the side panel.
 */
import type { Command, CommandContext } from '../app/commands';
import { activeProjectOf } from '../app/store';
import {
  closeFocused,
  cycleWorkspace,
  gotoWorkspace,
  onScreen,
  openShellHere,
  togglePanel,
  updateOnScreen,
} from './actions';
import {
  codeStore,
  cycleContainerTabs,
  cycleViewerTab,
  focusTile,
  layoutFocused,
  moveFocused,
  pinTab,
  projectCode,
  resizeFocused,
  toggleFullscreen,
} from './state';
import { type Direction, neighbour } from './tree';
import { shownLayout } from './view';

const DIRS: { dir: Direction; keys: string[] }[] = [
  { dir: 'left', keys: ['H', 'Left'] },
  { dir: 'down', keys: ['J', 'Down'] },
  { dir: 'up', keys: ['K', 'Up'] },
  { dir: 'right', keys: ['L', 'Right'] },
];

const inCode = (ctx: CommandContext) => ctx.ui.view === 'code' && onScreen() !== null;
/** The keyboard is in the code editor (it keeps the editor's own ⌘F and ⌘D). */
const inEditor = () => document.activeElement?.closest('.cm-editor') != null;
const tileCount = () => Object.keys(onScreen()?.ws.tiles ?? {}).length;
const focusedKind = () => {
  const ws = onScreen()?.ws;
  return ws?.focus ? (ws.tiles[ws.focus]?.kind ?? null) : null;
};
const name = (dir: Direction) => (dir === 'up' ? 'up' : dir === 'down' ? 'down' : dir);

export function codeCommands(): Command[] {
  return [
    // Tiles --------------------------------------------------------------------------------------------
    {
      id: 'tile.newTerminal',
      title: 'Open a terminal here',
      category: 'Tile',
      keybinding: 'Mod+T',
      priority: 1,
      when: (ctx) => activeProjectOf(ctx.ui, ctx.data) !== null,
      run: () => openShellHere(),
    },
    {
      id: 'code.splitRight',
      title: 'Split: a terminal to the right',
      category: 'Tile',
      keybinding: 'Mod+D',
      priority: 1,
      when: (ctx) => inCode(ctx) && !inEditor(),
      run: () => openShellHere('h'),
    },
    {
      id: 'code.splitDown',
      title: 'Split: a terminal below',
      category: 'Tile',
      keybinding: 'Mod+Shift+D',
      priority: 1,
      when: inCode,
      run: () => openShellHere('v'),
    },
    ...DIRS.map<Command>(({ dir, keys }) => ({
      id: `code.focus.${dir}`,
      title: `Focus the tile ${dir === 'up' ? 'above' : dir === 'down' ? 'below' : `to the ${dir}`}`,
      category: 'Focus',
      keybinding: keys.map((k) => `Mod+Alt+${k}`),
      priority: 1,
      repeatable: true,
      when: (ctx) => inCode(ctx) && tileCount() > 1,
      run: () => {
        const ws = onScreen()?.ws;
        const layout = shownLayout();
        if (!ws || !layout) return;
        const next = neighbour(layout, ws.focus, dir, ws.recent);
        if (next) updateOnScreen((w) => focusTile(w, next));
      },
    })),
    ...DIRS.map<Command>(({ dir, keys }) => ({
      id: `code.move.${dir}`,
      title: `Move the tile ${name(dir)}`,
      category: 'Layout',
      keybinding: keys.map((k) => `Mod+Alt+Shift+${k}`),
      priority: 1,
      repeatable: true,
      when: (ctx) => inCode(ctx) && tileCount() > 1,
      run: () => updateOnScreen((w) => moveFocused(w, dir)),
    })),
    ...DIRS.map<Command>(({ dir, keys }) => ({
      id: `code.resize.${dir}`,
      title: dir === 'right' ? 'Wider' : dir === 'left' ? 'Narrower' : dir === 'down' ? 'Taller' : 'Shorter',
      category: 'Layout',
      keybinding: keys.map((k) => `Mod+Ctrl+${k}`),
      priority: 1,
      repeatable: true,
      when: (ctx) => inCode(ctx) && tileCount() > 1,
      // Wider/taller grow the tile, narrower/shorter shrink it (whichever neighbour gives or takes the room).
      run: () =>
        updateOnScreen(
          (w) =>
            resizeFocused(
              w,
              dir === 'left' ? 'right' : dir === 'up' ? 'down' : dir,
              dir === 'left' || dir === 'up' ? -0.05 : 0.05,
            ),
          false,
        ),
    })),
    {
      id: 'code.layout.tabbed',
      title: 'Tabbed: the tiles around the focused one as tabs',
      category: 'Layout',
      keybinding: 'Mod+Alt+T',
      priority: 1,
      when: (ctx) => inCode(ctx) && tileCount() > 1,
      run: () => updateOnScreen((w) => layoutFocused(w, 'tabbed'), false),
    },
    {
      id: 'code.layout.stacked',
      title: 'Stacked: the tiles around the focused one as a stack',
      category: 'Layout',
      keybinding: 'Mod+Alt+S',
      priority: 1,
      when: (ctx) => inCode(ctx) && tileCount() > 1,
      run: () => updateOnScreen((w) => layoutFocused(w, 'stacked'), false),
    },
    {
      id: 'code.layout.split',
      title: 'Split: side by side / above each other',
      category: 'Layout',
      keybinding: 'Mod+Alt+E',
      priority: 1,
      when: (ctx) => inCode(ctx) && tileCount() > 1,
      run: () => updateOnScreen((w) => layoutFocused(w, 'toggle'), false),
    },
    {
      id: 'code.fullscreen',
      title: 'Show the focused tile alone / tile again',
      category: 'Layout',
      keybinding: 'Mod+F',
      priority: 1,
      when: (ctx) => inCode(ctx) && tileCount() > 1 && !inEditor(),
      run: () => updateOnScreen((w) => toggleFullscreen(w)),
    },
    {
      id: 'code.fullscreen.exit',
      title: 'Tile again',
      keybinding: 'Escape',
      hidden: true,
      priority: 1,
      when: (ctx) => inCode(ctx) && ctx.ui.overlay === null && onScreen()?.ws.fullscreen != null,
      run: () => updateOnScreen((w) => ({ ...w, fullscreen: null })),
    },
    {
      id: 'code.close',
      title: 'Close the tab or terminal',
      category: 'Tile',
      keybinding: 'Mod+W',
      priority: 1,
      when: (ctx) => inCode(ctx) && focusedKind() !== null,
      run: closeFocused,
    },
    {
      id: 'code.pin',
      title: 'Keep the preview tab open',
      category: 'Tile',
      keybinding: 'Mod+Enter',
      priority: 1,
      inInput: false,
      when: (ctx) => {
        const ws = onScreen()?.ws;
        const tile = ws?.focus ? ws.tiles[ws.focus] : undefined;
        if (!inCode(ctx) || tile?.kind !== 'viewer') return false;
        return tile.tabs.some((t) => t.id === tile.active && !t.pinned);
      },
      run: () => updateOnScreen((w) => (w.focus ? pinTab(w, w.focus) : w), false),
    },
    ...([1, -1] as const).map<Command>((step) => ({
      id: step === 1 ? 'code.tab.next' : 'code.tab.previous',
      title: step === 1 ? 'Next tab' : 'Previous tab',
      category: 'Tile',
      keybinding: step === 1 ? 'Mod+Shift+]' : 'Mod+Shift+[',
      priority: 1,
      repeatable: true,
      when: inCode,
      // The focused viewer's tabs first; else the tabs of the container around the focused tile.
      run: () =>
        updateOnScreen((w) => {
          const tile = w.focus ? w.tiles[w.focus] : undefined;
          if (w.focus && tile?.kind === 'viewer' && tile.tabs.length > 1) return cycleViewerTab(w, w.focus, step);
          return cycleContainerTabs(w, step);
        }),
    })),

    // Workspaces ---------------------------------------------------------------------------------------
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map<Command>((n) => ({
      id: `code.workspace.${n}`,
      title: `Go to code workspace ${n}`,
      category: 'Workspace',
      keybinding: `Mod+${n}`,
      hidden: true,
      // Above the rail's ⌘1–9 while Code is on screen.
      priority: 2,
      when: (ctx) => {
        const here = onScreen();
        return inCode(ctx) && !!here && projectCode(here.projectId).workspaces.length >= n;
      },
      run: () => gotoWorkspace(n),
    })),
    {
      id: 'code.workspace.next',
      title: 'Next workspace',
      category: 'Workspace',
      keybinding: 'Ctrl+Tab',
      priority: 1,
      repeatable: true,
      when: inCode,
      run: () => cycleWorkspace(1),
    },
    {
      id: 'code.workspace.previous',
      title: 'Previous workspace',
      category: 'Workspace',
      keybinding: 'Ctrl+Shift+Tab',
      priority: 1,
      repeatable: true,
      when: inCode,
      run: () => cycleWorkspace(-1),
    },
    {
      id: 'code.newWorkspace',
      title: 'New workspace… (on the project or a run’s worktree)',
      category: 'Workspace',
      keybinding: 'Mod+Alt+N',
      priority: 1,
      when: inCode,
      run: () => codeStore.setState((s) => ({ newRequest: s.newRequest + 1 })),
    },
    {
      id: 'code.panel',
      title: 'Show / hide the side panel',
      category: 'Layout',
      keybinding: 'Mod+B',
      priority: 1,
      when: inCode,
      run: togglePanel,
    },
  ];
}
