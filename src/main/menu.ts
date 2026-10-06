import { type CommandId, IPC } from '@shared/bridge';
import { app, BrowserWindow, globalShortcut, Menu } from 'electron';
import { buildMenuTemplate } from './menu-template';

/** Global shortcut that brings Legion forward and opens the composer. */
export const GLOBAL_COMPOSER_SHORTCUT = 'Alt+CommandOrControl+L';

export interface CommandBus {
  /** Send to the focused Legion window (falling back to the main one). Dropped if there is no window. */
  send(command: CommandId): void;
  /** Show/restore/focus the main window (creating it if needed), then send once its page has loaded. */
  showAndSend(command: CommandId | null): void;
}

/** `getWindow` returns the main window; `createWindow` recreates it when it was closed (macOS keeps the app alive). */
export function createCommandBus(getWindow: () => BrowserWindow | null, createWindow: () => BrowserWindow): CommandBus {
  const deliver = (window: BrowserWindow, command: CommandId): void => {
    if (window.isDestroyed()) return;
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => window.webContents.send(IPC.command, command));
    } else {
      window.webContents.send(IPC.command, command);
    }
  };
  return {
    send(command) {
      const window = BrowserWindow.getFocusedWindow() ?? getWindow();
      if (window) deliver(window, command);
    },
    showAndSend(command) {
      let window = getWindow();
      if (!window || window.isDestroyed()) window = createWindow();
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      app.focus({ steal: true });
      window.focus();
      if (command) deliver(window, command);
    },
  };
}

export function installAppMenu(bus: CommandBus): void {
  const template = buildMenuTemplate({
    appName: app.getName(),
    isMac: process.platform === 'darwin',
    isDev: !app.isPackaged,
    send: (command) => bus.send(command),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Registers ⌥⌘L. Returns false (and logs) when another app already owns it. Call after `app.whenReady()`;
 * the shortcut is released on quit.
 */
export function registerGlobalShortcuts(bus: CommandBus): boolean {
  let ok = false;
  try {
    ok = globalShortcut.register(GLOBAL_COMPOSER_SHORTCUT, () => bus.showAndSend('composer.open'));
  } catch (error) {
    console.warn(`[main] could not register ${GLOBAL_COMPOSER_SHORTCUT}:`, error);
  }
  if (!ok) console.warn(`[main] global shortcut ${GLOBAL_COMPOSER_SHORTCUT} is unavailable (already registered?)`);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  return ok;
}
