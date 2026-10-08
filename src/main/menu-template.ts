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
 * ⌘W is bound here on purpose so Electron's default (close window) never swallows `code.close` / the board's hide.
 * ⌘1–9 belong to the renderer's workspace switching and are never bound here.
 */
export const MENU_ACCELERATORS: Partial<Record<CommandId, string>> = {
  'composer.open': 'CmdOrCtrl+Shift+N',
  'inbox.open': 'CmdOrCtrl+I',
  'palette.open': 'CmdOrCtrl+K',
  'focus.nextUrgent': 'CmdOrCtrl+U',
  'view.code': 'CmdOrCtrl+Shift+E',
  'code.panel': 'CmdOrCtrl+B',
  'code.close': 'CmdOrCtrl+W',
  'settings.open': 'CmdOrCtrl+,',
  'project.add': 'CmdOrCtrl+O',
  'file.goto': 'CmdOrCtrl+P',
  'project.search': 'CmdOrCtrl+Shift+F',
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
      item('Settings…', 'settings.open'),
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
      item('Add Project…', 'project.add'),
      { type: 'separator' },
      item('Go to File…', 'file.goto'),
      item('Search in Project…', 'project.search'),
      { type: 'separator' },
      item('Open Inbox', 'inbox.open'),
      item('Command Palette…', 'palette.open'),
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            item('Settings…', 'settings.open'),
            { type: 'separator' },
            { role: 'quit' },
          ] as MenuItemConstructorOptions[])),
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
      item('Code', 'view.code'),
      item('Side Panel', 'code.panel'),
      item('Close Tab or Terminal', 'code.close'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(isDev
        ? ([
            { type: 'separator' },
            // Reload stays off ⌘R (too close to everyday chords); ⇧⌘R.
            { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
            { role: 'toggleDevTools' },
          ] as MenuItemConstructorOptions[])
        : []),
    ],
  };

  // Not `role: 'windowMenu'`: its Close item owns ⌘W, which closes a tab or terminal here.
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
