/**
 * The API the preload script exposes on `window.legion` (contextIsolation + sandbox).
 * Engine traffic does not go through it: the renderer gets a MessagePort and talks to the engine directly.
 */

/** `window.postMessage` payload type used to hand the engine port to the page (port in `event.ports[0]`). */
export const ENGINE_PORT_MESSAGE = 'legion:engine-port';

export interface PlatformInfo {
  platform: string;
  arch: string;
  versions: { electron: string; chrome: string; node: string };
}

export interface LegionBridge {
  readonly platform: PlatformInfo;
  /**
   * Ask main for a (new) engine port. It arrives as a window `message` event whose data is
   * `{ type: ENGINE_PORT_MESSAGE, generation }` with the port in `event.ports[0]`. Main also pushes a new
   * port unprompted after an engine restart.
   */
  requestEnginePort(): void;
  /** Native folder picker; resolves to null when cancelled. */
  pickDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** Open an http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>;
  /** Reveal a file or folder in Finder. */
  showItemInFolder(path: string): void;
}

/** IPC channel names between preload and main. */
export const IPC = {
  requestEnginePort: 'legion:request-engine-port',
  enginePort: 'legion:engine-port',
  pickDirectory: 'legion:pick-directory',
  openExternal: 'legion:open-external',
  showItemInFolder: 'legion:show-item-in-folder',
} as const;
