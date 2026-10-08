/**
 * Windows: native window controls over the end of Legion's title bar (as on Linux), no login shell to ask (GUI apps
 * get the user's Path), an app id for toasts and the taskbar, a dot overlaid on the taskbar button for the badge.
 */
import { titleBarFor } from '@shared/platform';
import { app, nativeImage } from 'electron';
import { type MainPlatform, overlayWindowOptions } from './types';

/** electron-builder.yml `appId`: an installed Legion's Start menu shortcut carries it, so toasts show. */
export const WINDOWS_APP_ID = 'dev.erudiet.legion';

export function windowsPlatform(): MainPlatform {
  const titleBar = titleBarFor('windows');
  let dot: Electron.NativeImage | null = null;
  return {
    os: 'windows',
    titleBar,
    init: () => app.setAppUserModelId(WINDOWS_APP_ID),
    windowOptions: (colors) => overlayWindowOptions(titleBar, colors),
    setTitleBarColors: (window, colors) => {
      if (!window.isDestroyed())
        window.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbols, height: titleBar.height });
    },
    resolveChildEnv: async (base) => windowsChildEnv(base),
    // No badge counts on Windows: a dot over the taskbar button, the count in its accessible description.
    setBadge: (count, window) => {
      if (!window || window.isDestroyed()) return;
      if (count <= 0) return window.setOverlayIcon(null, '');
      dot ??= nativeImage.createFromBitmap(badgeDotBitmap(16, BADGE_BGRA), { width: 16, height: 16 });
      window.setOverlayIcon(dot, `${count} ${count === 1 ? 'thing needs' : 'things need'} you`);
    },
    quitWhenAllWindowsClosed: true,
  };
}

/**
 * The engine's environment from main's own: one `PATH` key (Windows spells it `Path`, and a copied env object is
 * case-sensitive, so engine code reading `env.PATH` would find nothing), and long paths on for every git process
 * (worktrees under %APPDATA% plus node_modules pass 260 characters).
 */
export function windowsChildEnv(base: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = { ...base };
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
  const path = pathKeys.map((key) => env[key]).find((value) => value) ?? '';
  for (const key of pathKeys) delete env[key];
  env.PATH = path;
  // GIT_CONFIG_COUNT/KEY_n/VALUE_n: config for every git command, appended to any the user set.
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  env[`GIT_CONFIG_KEY_${count}`] = 'core.longpaths';
  env[`GIT_CONFIG_VALUE_${count}`] = 'true';
  env.GIT_CONFIG_COUNT = String(count + 1);
  return env;
}

/** Catppuccin red (#f38ba8) as blue, green, red, alpha. */
const BADGE_BGRA = [0xa8, 0x8b, 0xf3, 0xff] as const;

/** A `size`² BGRA bitmap of a filled, anti-aliased circle in `bgra`. */
export function badgeDotBitmap(size: number, bgra: readonly [number, number, number, number]): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x - centre, y - centre)));
      const at = (y * size + x) * 4;
      // Premultiplied alpha, as Skia bitmaps are.
      pixels[at] = Math.round(bgra[0] * coverage);
      pixels[at + 1] = Math.round(bgra[1] * coverage);
      pixels[at + 2] = Math.round(bgra[2] * coverage);
      pixels[at + 3] = Math.round(bgra[3] * coverage);
    }
  }
  return pixels;
}
