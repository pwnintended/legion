import type { CommandId } from '@shared/bridge';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuTemplateOptions {
  appName: string;
  isMac: boolean;
  isDev: boolean;
  /** Send a command id to the focused renderer. */
  send: (command: CommandId) => void;
}

/**
 * Accelerators mirror the renderer's command registry (`src/renderer/app/commands.ts`), which stays the source of
 * truth: the renderer handles a chord first and calls preventDefault, so a menu accelerator only fires when the
 * renderer didn't (focus in a terminal, command unavailable), and then routes the same command id back to it.
 * ⌘W and ⌘R are bound here on purpose so Electron's defaults (close window, reload) never swallow
 * `column.cycleMode` / `mode.resize`. ⌘1–9 belong to the renderer's workspace switching and are never bound here.
 */
export const MENU_ACCELERATORS: Partial<Record<CommandId, string>> = {
  'composer.open': 'CmdOrCtrl+N',
  'inbox.open': 'CmdOrCtrl+I',
  'palette.open': 'CmdOrCtrl+K',
  'layout.focus': 'CmdOrCtrl+Return',
  // ⌘⇥ is taken by the macOS app switcher; the registry's second binding is the one that works.
  'layout.overview': 'CmdOrCtrl+Shift+O',
  'layout.pipeline': 'CmdOrCtrl+G',
  'focus.nextUrgent': 'CmdOrCtrl+U',
  'column.cycleMode': 'CmdOrCtrl+W',
  'mode.resize': 'CmdOrCtrl+R',
};

export function buildMenuTemplate({ appName, isMac, isDev, send }: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const item = (label: string, command: CommandId): MenuItemConstructorOptions => {
    const accelerator = MENU_ACCELERATORS[command];
    return { label, ...(accelerator ? { accelerator } : {}), click: () => send(command) };
  };

  const app: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      item('New Run…', 'composer.open'),
      { type: 'separator' },
      item('Open Inbox', 'inbox.open'),
      item('Command Palette…', 'palette.open'),
      ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' },
    ],
  };

  const run: MenuItemConstructorOptions = {
    label: 'Run',
    submenu: [
      item('Next Tile That Needs You', 'focus.nextUrgent'),
      { type: 'separator' },
      item('Pause Run', 'run.pause'),
      item('Resume Run', 'run.resume'),
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      item('Strip Layout', 'layout.strip'),
      item('Focus Layout', 'layout.focus'),
      item('Overview', 'layout.overview'),
      item('Pipeline', 'layout.pipeline'),
      { type: 'separator' },
      item('Toggle Tabbed / Stacked Column', 'column.cycleMode'),
      item('Resize Mode', 'mode.resize'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(isDev
        ? ([
            { type: 'separator' },
            // ⌘R is resize mode; keep reload reachable on ⇧⌘R.
            { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
            { role: 'toggleDevTools' },
          ] as MenuItemConstructorOptions[])
        : []),
    ],
  };

  // Not `role: 'windowMenu'`: its Close item owns ⌘W, which is column.cycleMode here.
  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    ...(isMac ? { role: 'window' as const } : {}),
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : []),
    ],
  };

  const help: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [],
  };

  return [...(isMac ? [app] : []), file, edit, run, view, windowMenu, help];
}
