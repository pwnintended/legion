/**
 * The board's keyboard (conversation view only; the agents view keeps its own bindings for the same chords):
 * ⌘N new conversation tile, ⌥ HJKL (also ⌘⌥ HJKL / arrows) focus, ⌘F monocle (Esc leaves it), ⌘⇧⏎ make master, ⌘W hide.
 * The tiles hold text fields, so every binding is a ⌘- or ⌥-chord except Esc, which never fires while typing.
 * Off macOS, ⌥ HJKL is Ctrl+Alt HJKL.
 */
import type { Command, CommandContext } from '../app/commands';
import { paneBindings } from '../app/keys';
import { activeProjectOf } from '../app/store';
import { type Direction, neighbour } from './arrange';
import { boardActions, boardOf, boardStore, NEW } from './state';

const DIRS: { dir: Direction; keys: string[] }[] = [
  { dir: 'left', keys: ['H', 'Left'] },
  { dir: 'down', keys: ['J', 'Down'] },
  { dir: 'up', keys: ['K', 'Up'] },
  { dir: 'right', keys: ['L', 'Right'] },
];

const onBoard = (ctx: CommandContext) => ctx.ui.view === 'chat' && boardStore.getState().view !== null;
const focused = () => boardStore.getState().view?.focus ?? null;

export function boardCommands(): Command[] {
  return [
    {
      id: 'board.new',
      title: 'New conversation tile',
      category: 'Workspace',
      keybinding: 'Mod+N',
      priority: 1,
      // From a conversation's agents too: the new conversation is a tile, so it goes back to the board for it.
      when: (ctx) =>
        (onBoard(ctx) && boardStore.getState().view?.projectId != null) ||
        (ctx.ui.view === 'agents' && activeProjectOf(ctx.ui, ctx.data) !== null),
      run: (ctx) => (ctx.ui.view === 'agents' ? boardActions.newFromAgents() : boardActions.openNew()),
    },
    ...DIRS.map<Command>(({ dir, keys }) => ({
      id: `board.focus.${dir}`,
      title: `Focus the tile ${dir === 'up' ? 'above' : dir === 'down' ? 'below' : `to the ${dir}`}`,
      category: 'Focus',
      keybinding: keys.flatMap((k) => paneBindings(k)),
      priority: 1,
      repeatable: true,
      when: (ctx) => onBoard(ctx) && (boardStore.getState().view?.ids.length ?? 0) > 1,
      run: () => {
        const view = boardStore.getState().view;
        if (!view) return;
        const next = neighbour(view.arrangement, view.ids, view.focus, dir, boardOf(view.key).recent);
        if (next) boardActions.focus(next, true);
      },
    })),
    {
      id: 'board.monocle',
      title: 'Show the focused conversation alone / tile again',
      category: 'Layout',
      keybinding: 'Mod+F',
      priority: 1,
      when: (ctx) => onBoard(ctx) && focused() !== null && (boardStore.getState().view?.ids.length ?? 0) > 1,
      run: () => {
        const id = focused();
        if (id) boardActions.toggleMonocle(id);
      },
    },
    {
      id: 'board.monocle.exit',
      title: 'Tile the board again',
      keybinding: 'Escape',
      hidden: true,
      priority: 1,
      when: (ctx) => {
        const view = boardStore.getState().view;
        if (!onBoard(ctx) || ctx.ui.overlay !== null || !view) return false;
        return view.temporary !== null || boardOf(view.key).monocle !== null;
      },
      run: () => {
        const view = boardStore.getState().view;
        if (!view) return;
        if (view.temporary) boardActions.leaveTemporary();
        else {
          const monocle = boardOf(view.key).monocle;
          if (monocle) boardActions.toggleMonocle(monocle);
        }
      },
    },
    {
      id: 'board.promote',
      title: 'Make the focused tile the master',
      category: 'Layout',
      keybinding: 'Mod+Shift+Enter',
      priority: 1,
      when: (ctx) => {
        const view = boardStore.getState().view;
        return onBoard(ctx) && !!view?.focus && view.ids[0] !== view.focus && view.focus !== view.temporary;
      },
      run: () => {
        const id = focused();
        if (id) boardActions.promote(id);
      },
    },
    {
      id: 'board.hide',
      title: 'Hide the focused conversation until it needs you',
      category: 'Tile',
      keybinding: 'Mod+W',
      priority: 1,
      when: (ctx) => {
        const view = boardStore.getState().view;
        if (!onBoard(ctx) || !view?.focus) return false;
        return view.focus !== NEW || view.ids.length > 1;
      },
      run: () => {
        const view = boardStore.getState().view;
        if (!view?.focus) return;
        if (view.focus === NEW) boardActions.closeNew();
        else if (view.focus === view.temporary) boardActions.leaveTemporary();
        else boardActions.hide(view.focus);
      },
    },
  ];
}
