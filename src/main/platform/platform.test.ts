import { titleBarFor } from '@shared/platform';
import { describe, expect, it } from 'vitest';
import { linuxPlatform } from './linux';
import { macPlatform } from './mac';
import { isHexColor } from './types';

const colors = { background: '#181825', symbols: '#cdd6f4' };

describe('main platforms', () => {
  it('macOS insets the traffic lights, centred in the title bar, and stays alive without windows', () => {
    const mac = macPlatform();
    expect(mac.windowOptions(colors)).toMatchObject({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
      vibrancy: 'under-window',
    });
    expect(mac.quitWhenAllWindowsClosed).toBe(false);
  });

  it('Linux overlays themed window controls as tall as the title bar and quits with the last window', () => {
    const linux = linuxPlatform();
    expect(linux.windowOptions(colors)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#181825', symbolColor: '#cdd6f4', height: titleBarFor('linux').height },
    });
    expect(linux.quitWhenAllWindowsClosed).toBe(true);
  });

  it('accepts only hex colours from the renderer', () => {
    expect(isHexColor('#e6e9ef')).toBe(true);
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('rgb(0, 0, 0)')).toBe(false);
    expect(isHexColor('#e6e9ef; x')).toBe(false);
    expect(isHexColor(undefined)).toBe(false);
  });
});
