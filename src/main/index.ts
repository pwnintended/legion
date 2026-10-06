import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IPC } from '@shared/bridge';
import type { EngineToMainMessage } from '@shared/host-protocol';
import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, shell } from 'electron';
import { EngineSupervisor } from './engine-supervisor';
import { resolveLoginShellPath } from './shell-env';

/** `LEGION_HOME` overrides the data dir (tests); default ~/Library/Application Support/Legion. */
function resolveDataDir(): string {
  const override = process.env.LEGION_HOME;
  if (override) return resolve(override.replace(/^~(?=$|\/)/, homedir()));
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
  let pathPromise: Promise<string> | null = null;
  const supervisor = new EngineSupervisor({
    entry: join(import.meta.dirname, 'engine.js'),
    dataDir,
    version: app.getVersion(),
    env: async () => {
      pathPromise ??= resolveLoginShellPath();
      const PATH = await pathPromise;
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
      delete env.ELECTRON_RUN_AS_NODE;
      return { ...env, PATH };
    },
  });

  let powerBlocker: number | null = null;
  supervisor.on('message', (message: EngineToMainMessage) => {
    switch (message.type) {
      case 'notify':
        if (Notification.isSupported() && !BrowserWindow.getFocusedWindow()) {
          new Notification({ title: message.title, body: message.body }).show();
        }
        break;
      case 'badge':
        app.dock?.setBadge(message.count > 0 ? String(message.count) : '');
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
  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.on(IPC.showItemInFolder, (_event, path: string) => {
    if (typeof path === 'string') shell.showItemInFolder(path);
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
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
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
    if (process.platform !== 'darwin') app.quit();
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}
