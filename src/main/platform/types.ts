/** The contract of a main-process platform implementation (see index.ts), plus helpers they share. */
import type { Os, TitleBarSpec } from '@shared/platform';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/** Colours of the title bar the native window controls sit on (from the renderer's theme). */
export interface TitleBarColors {
  /** Title bar background (`--mantle`). */
  background: string;
  /** Window control glyphs (`--text`). */
  symbols: string;
}

export interface MainPlatform {
  readonly os: Os;
  readonly titleBar: TitleBarSpec;
  /** One-time setup at startup, before any window or notification (Windows: the app's taskbar / toast identity). */
  init(): void;
  /** Frame and title bar options for every BrowserWindow (merged into the window's own options). */
  windowOptions(colors: TitleBarColors): BrowserWindowConstructorOptions;
  /** Recolour the native window controls after a theme change (a no-op where they don't take colours). */
  setTitleBarColors(window: BrowserWindow, colors: TitleBarColors): void;
  /**
   * The environment the engine and its child processes get, from main's own (`base`). GUI launches don't inherit
   * the user's shell environment, so this is where PATH (and the login shell, `SHELL`) are put right.
   */
  resolveChildEnv(base: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /**
   * Show how many things need the user on the app's icon (Dock badge, launcher count, taskbar overlay); 0 clears it.
   * `window` is the main window, where the OS badges a window rather than the app.
   */
  setBadge(count: number, window: BrowserWindow | null): void;
  /** Quit once the last window is closed (macOS keeps the app alive in the Dock instead). */
  readonly quitWhenAllWindowsClosed: boolean;
}

/** Mocha's mantle and text: the title bar before the renderer reports its theme. */
export const DEFAULT_TITLE_BAR_COLORS: TitleBarColors = { background: '#181825', symbols: '#cdd6f4' };

/** Window Controls Overlay options shared by every OS that draws its controls over Legion's title bar. */
export function overlayWindowOptions(spec: TitleBarSpec, colors: TitleBarColors): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.background, symbolColor: colors.symbols, height: spec.height },
  };
}

/** Is `value` a CSS hex colour (what `titleBarOverlay` accepts)? Guards the renderer's input. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}
