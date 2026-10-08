/**
 * The operating systems Legion knows about, and the platform facts every process must agree on. Pure (no Node
 * or DOM), so main, the engine and the renderer derive the same answer from `process.platform`.
 *
 * Behaviour that differs per OS lives behind one interface per process, each with an implementation per OS:
 * `main/platform/` (window, PATH, badge), `engine/platform/` (shell, executables) and the renderer's
 * `app/platform.ts` (keyboard, wording). See docs/architecture.md §3 "Platforms".
 */

export const OPERATING_SYSTEMS = ['mac', 'linux', 'windows'] as const;
export type Os = (typeof OPERATING_SYSTEMS)[number];

/** `process.platform` → Os. Every other Unix (FreeBSD, …) is treated as Linux. */
export function osOf(platform: string): Os {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * How the window's title bar is drawn. Main builds the BrowserWindow from it and the renderer lays its title bar
 * out around the native window controls, so the two never disagree.
 */
export interface TitleBarSpec {
  /**
   * `inset`: macOS traffic lights over the start of Legion's own title bar (`hiddenInset`).
   * `overlay`: native window controls over its end (Window Controls Overlay: `titleBarStyle: 'hidden'` +
   * `titleBarOverlay`); the renderer reads their exact box from the `titlebar-area-*` CSS env variables.
   */
  style: 'inset' | 'overlay';
  /** Height of Legion's title bar in px (also the overlay's height). */
  height: number;
  /** Space kept free at the start of the title bar for the native controls (px). */
  startInset: number;
  /** Space kept free at the end when the platform can't report the overlay's box (px). */
  endInsetFallback: number;
}

const TITLE_BAR_HEIGHT = 44;

export function titleBarFor(os: Os): TitleBarSpec {
  if (os === 'mac') return { style: 'inset', height: TITLE_BAR_HEIGHT, startInset: 84, endInsetFallback: 0 };
  return { style: 'overlay', height: TITLE_BAR_HEIGHT, startInset: 0, endInsetFallback: 140 };
}
