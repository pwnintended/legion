import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { IPC } from '@shared/bridge';
import type { EngineToMainMessage } from '@shared/host-protocol';
import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, shell } from 'electron';
import { EngineSupervisor } from './engine-supervisor';
import { type CommandBus, createCommandBus, installAppMenu, registerGlobalShortcuts } from './menu';
import { DEFAULT_TITLE_BAR_COLORS, isHexColor, mainPlatform, type TitleBarColors } from './platform';

/**
 * `LEGION_HOME` overrides the data dir (tests); default `<appData>/Legion`: ~/Library/Application Support/Legion on
 * macOS, ~/.config/Legion on Linux, %APPDATA%\Legion on Windows.
 */
function resolveDataDir(): string {
  const override = process.env.LEGION_HOME;
  if (override) return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
  return join(app.getPath('appData'), 'Legion');
}

const dataDir = resolveDataDir();
app.setName('Legion');
// Keep Chromium's profile next to Legion's data so isolated LEGION_HOMEs don't share state or the
// single-instance lock.
app.setPath('userData', process.env.LEGION_HOME ? join(dataDir, 'chromium') : dataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  const platform = mainPlatform();
  platform.init();
  let childEnv: Promise<Record<string, string>> | null = null;
  const supervisor = new EngineSupervisor({
    entry: join(import.meta.dirname, 'engine.js'),
    dataDir,
    version: app.getVersion(),
    env: () => {
      if (!childEnv) {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
        delete env.ELECTRON_RUN_AS_NODE;
        childEnv = platform.resolveChildEnv(env);
      }
      return childEnv;
    },
  });

  let powerBlocker: number | null = null;
  let commandBus: CommandBus | null = null;
  // Keep notifications referenced until dismissed, or they can be collected before the user clicks them.
  const liveNotifications = new Set<Notification>();
  supervisor.on('message', (message: EngineToMainMessage) => {
    switch (message.type) {
      case 'notify':
        if (Notification.isSupported() && !BrowserWindow.getFocusedWindow()) {
          const notification = new Notification({ title: message.title, body: message.body });
          liveNotifications.add(notification);
          const forget = (): void => void liveNotifications.delete(notification);
          notification.on('click', () => {
            forget();
            commandBus?.showAndSend('focus.nextUrgent');
          });
          notification.on('close', forget);
          notification.show();
        }
        break;
      case 'badge':
        platform.setBadge(message.count, mainWindow);
        break;
      case 'power':
        if (message.preventSleep && powerBlocker === null) {
          powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
        } else if (!message.preventSleep && powerBlocker !== null) {
          powerSaveBlocker.stop(powerBlocker);
          powerBlocker = null;
        }
        break;
      case 'ready':
        break;
    }
  });

  ipcMain.on(IPC.requestEnginePort, (event) => supervisor.attach(event.sender));
  ipcMain.handle(IPC.pickDirectory, async (event, options: { title?: string; defaultPath?: string } = {}) => {
    // Test hook (Playwright can't drive the native dialog): answer with this path instead.
    const e2ePick = process.env.LEGION_E2E_PICK_DIR;
    if (e2ePick) return e2ePick;
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: options.title ?? 'Choose a repository',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(
    IPC.pickFiles,
    async (event, options: { title?: string; extensions?: readonly string[] } = {}): Promise<string[]> => {
      // Test hook: answer with these paths (path-delimiter separated) instead of the native dialog.
      const e2ePick = process.env.LEGION_E2E_PICK_FILES;
      if (e2ePick) return e2ePick.split(delimiter).filter(Boolean);
      const window = BrowserWindow.fromWebContents(event.sender);
      const extensions = Array.isArray(options.extensions)
        ? options.extensions.filter((e) => typeof e === 'string')
        : [];
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title ?? 'Attach files',
        properties: ['openFile', 'multiSelections'],
        ...(extensions.length ? { filters: [{ name: 'Images, text and PDFs', extensions }] } : {}),
      };
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? [] : result.filePaths;
    },
  );
  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.on(IPC.showItemInFolder, (_event, path: string) => {
    if (typeof path === 'string') shell.showItemInFolder(path);
  });
  // The renderer reports its theme's title bar colours; the native window controls follow (new windows too).
  let titleBarColors: TitleBarColors = DEFAULT_TITLE_BAR_COLORS;
  ipcMain.on(IPC.setTitleBarColors, (event, colors: Partial<TitleBarColors> | null) => {
    if (!isHexColor(colors?.background) || !isHexColor(colors?.symbols)) return;
    titleBarColors = { background: colors.background, symbols: colors.symbols };
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) platform.setTitleBarColors(window, titleBarColors);
  });

  let mainWindow: BrowserWindow | null = null;
  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: 'Legion',
      ...platform.windowOptions(titleBarColors),
      backgroundColor: '#11111b',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    window.once('ready-to-show', () => window.show());

    // Never navigate away from the app or open new windows; hand http(s) links to the browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && devUrl) void window.loadURL(devUrl);
    else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
    return window;
  };

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (platform.quitWhenAllWindowsClosed) app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void supervisor.stop().finally(() => app.quit());
  });

  await app.whenReady();
  void supervisor.start();
  mainWindow = createWindow();
  commandBus = createCommandBus(
    () => mainWindow,
    () => {
      mainWindow = createWindow();
      return mainWindow;
    },
  );
  installAppMenu(commandBus);
  registerGlobalShortcuts(commandBus);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}
