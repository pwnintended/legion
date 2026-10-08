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

/** Command ids main sends to the renderer (app menu, global shortcut, notification clicks). */
export const COMMAND_IDS = [
  'composer.open',
  'run.new',
  'inbox.open',
  'palette.open',
  'focus.nextUrgent',
  'view.code',
  'code.panel',
  'code.close',
  'run.pause',
  'run.resume',
  'settings.open',
  'project.add',
  'file.goto',
  'project.search',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export interface LegionBridge {
  readonly platform: PlatformInfo;
  /** Subscribe to native commands from main (menu items, ⌥⌘L, notification clicks). Returns unsubscribe. */
  onCommand(callback: (command: CommandId) => void): () => void;
  /**
   * Ask main for a (new) engine port. It arrives as a window `message` event whose data is
   * `{ type: ENGINE_PORT_MESSAGE, generation }` with the port in `event.ports[0]`. Main also pushes a new
   * port unprompted after an engine restart.
   */
  requestEnginePort(): void;
  /** Native folder picker; resolves to null when cancelled. */
  pickDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** Native multi-file picker (attachments); resolves to [] when cancelled. */
  pickFiles(options?: { title?: string; extensions?: readonly string[] }): Promise<string[]>;
  /**
   * The filesystem path of a File from a drag-and-drop (Finder folder or file); '' when it has none.
   * (`File.path` is gone in sandboxed renderers; this wraps `webUtils.getPathForFile`.)
   */
  pathForFile(file: File): string;
  /** Open an http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>;
  /** Reveal a file or folder in the system file manager (Finder on macOS). */
  showItemInFolder(path: string): void;
  /**
   * Colour the native window controls drawn over the title bar (Linux, Windows) to match the theme: hex colours of
   * the title bar's background and of the control glyphs. Ignored where the controls take no colours (macOS).
   */
  setTitleBarColors(colors: { background: string; symbols: string }): void;
}

/** IPC channel names between preload and main. */
export const IPC = {
  requestEnginePort: 'legion:request-engine-port',
  enginePort: 'legion:engine-port',
  pickDirectory: 'legion:pick-directory',
  pickFiles: 'legion:pick-files',
  openExternal: 'legion:open-external',
  showItemInFolder: 'legion:show-item-in-folder',
  setTitleBarColors: 'legion:set-title-bar-colors',
  /** main → renderer: a CommandId. */
  command: 'legion:command',
} as const;
