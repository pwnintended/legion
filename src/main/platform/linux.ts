/**
 * Linux: native window controls drawn over the end of Legion's title bar (Window Controls Overlay), PATH from the
 * login shell (a `.desktop` launcher doesn't run it either), quit with the last window.
 */
import { titleBarFor } from '@shared/platform';
import { app } from 'electron';
import { loginShellEnv } from '../shell-env';
import { type MainPlatform, overlayWindowOptions } from './types';

export function linuxPlatform(): MainPlatform {
  const titleBar = titleBarFor('linux');
  return {
    os: 'linux',
    titleBar,
    init: () => {},
    windowOptions: (colors) => overlayWindowOptions(titleBar, colors),
    setTitleBarColors: (window, colors) => {
      if (!window.isDestroyed())
        window.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbols, height: titleBar.height });
    },
    resolveChildEnv: (base) => loginShellEnv('linux', base),
    setBadge: (count) => void app.setBadgeCount(count),
    quitWhenAllWindowsClosed: true,
  };
}
