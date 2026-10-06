import { ENGINE_PORT_MESSAGE, IPC, type LegionBridge } from '@shared/bridge';
import { contextBridge, ipcRenderer } from 'electron';

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
  requestEnginePort: () => ipcRenderer.send(IPC.requestEnginePort),
  pickDirectory: (options) => ipcRenderer.invoke(IPC.pickDirectory, options ?? {}),
  openExternal: async (url) => {
    await ipcRenderer.invoke(IPC.openExternal, url);
  },
  showItemInFolder: (path) => ipcRenderer.send(IPC.showItemInFolder, path),
};

contextBridge.exposeInMainWorld('legion', bridge);
