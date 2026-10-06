import type { CommandId } from '@shared/bridge';
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuTemplateOptions {
  appName: string;
  isMac: boolean;
  isDev: boolean;
  /** Send a command id to the focused renderer. */
  send: (command: CommandId) => void;
}

/** Legion items only carry accelerators that don't collide with text editing; ⌘W etc. stay with the renderer. */
export function buildMenuTemplate({ appName, isMac, isDev, send }: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const item = (label: string, command: CommandId, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => send(command),
  });

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
      item('New Run…', 'composer.open', 'CmdOrCtrl+N'),
      { type: 'separator' },
      item('Open Inbox', 'inbox.open', 'CmdOrCtrl+I'),
      item('Command Palette…', 'palette.open', 'CmdOrCtrl+K'),
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
      item('Next Urgent Item', 'focus.nextUrgent', 'CmdOrCtrl+Shift+U'),
      { type: 'separator' },
      item('Pause Run', 'run.pause', 'Alt+CmdOrCtrl+P'),
      item('Resume Run', 'run.resume', 'Alt+CmdOrCtrl+R'),
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      item('Strip Layout', 'layout.strip', 'CmdOrCtrl+1'),
      item('Focus Layout', 'layout.focus', 'CmdOrCtrl+2'),
      item('Overview', 'layout.overview', 'CmdOrCtrl+G'),
      item('Pipeline', 'layout.pipeline', 'CmdOrCtrl+3'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(isDev
        ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
        : []),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'windowMenu',
  };

  const help: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [],
  };

  return [...(isMac ? [app] : []), file, edit, run, view, windowMenu, help];
}
