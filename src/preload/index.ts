import { type CommandId, ENGINE_PORT_MESSAGE, IPC, type LegionBridge } from '@shared/bridge';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// MessagePorts can't cross the contextBridge, so the engine port is forwarded to the page with
// window.postMessage (the page listens for ENGINE_PORT_MESSAGE and takes event.ports[0]).
ipcRenderer.on(IPC.enginePort, (event, data: { type: string; generation: number }) => {
  window.postMessage({ type: ENGINE_PORT_MESSAGE, generation: data.generation }, '*', event.ports);
});

const bridge: LegionBridge = {
  platform: {
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
    },
  },
  onCommand: (callback) => {
    const listener = (_event: unknown, command: CommandId): void => callback(command);
    ipcRenderer.on(IPC.command, listener);
    return () => {
      ipcRenderer.removeListener(IPC.command, listener);
    };
  },
  requestEnginePort: () => ipcRenderer.send(IPC.requestEnginePort),
  pickDirectory: (options) => ipcRenderer.invoke(IPC.pickDirectory, options ?? {}),
  pickFiles: (options) => ipcRenderer.invoke(IPC.pickFiles, options ?? {}),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openExternal: async (url) => {
    await ipcRenderer.invoke(IPC.openExternal, url);
  },
  showItemInFolder: (path) => ipcRenderer.send(IPC.showItemInFolder, path),
  setTitleBarColors: (colors) => ipcRenderer.send(IPC.setTitleBarColors, colors),
};

contextBridge.exposeInMainWorld('legion', bridge);
