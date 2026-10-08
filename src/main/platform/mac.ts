/** macOS: traffic lights inset into Legion's title bar, vibrancy, PATH from the login shell, stays in the Dock. */
import { titleBarFor } from '@shared/platform';
import { app } from 'electron';
import { loginShellEnv } from '../shell-env';
import type { MainPlatform } from './types';

export function macPlatform(): MainPlatform {
  const titleBar = titleBarFor('mac');
  return {
    os: 'mac',
    titleBar,
    init: () => {},
    windowOptions: () => ({
      titleBarStyle: 'hiddenInset',
      // Centred in the title bar: the lights are 12 px tall plus a 1 px ring.
      trafficLightPosition: { x: 16, y: Math.round((titleBar.height - 16) / 2) },
      vibrancy: 'under-window',
      visualEffectState: 'active',
    }),
    // The traffic lights draw themselves.
    setTitleBarColors: () => {},
    resolveChildEnv: (base) => loginShellEnv('mac', base),
    setBadge: (count) => void app.setBadgeCount(count),
    quitWhenAllWindowsClosed: false,
  };
}
