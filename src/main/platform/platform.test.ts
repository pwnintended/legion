import { titleBarFor } from '@shared/platform';
import { describe, expect, it } from 'vitest';
import { linuxPlatform } from './linux';
import { macPlatform } from './mac';
import { isHexColor } from './types';
import { badgeDotBitmap, windowsChildEnv, windowsPlatform } from './windows';

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

  it('Windows overlays the controls like Linux and quits with the last window', () => {
    const windows = windowsPlatform();
    expect(windows.windowOptions(colors)).toMatchObject({ titleBarStyle: 'hidden' });
    expect(windows.quitWhenAllWindowsClosed).toBe(true);
  });

  it("gives the Windows engine one PATH key, whatever Windows called it, and git's long paths", () => {
    const env = windowsChildEnv({ Path: 'C:\\Windows;C:\\Git\\cmd', USERPROFILE: 'C:\\Users\\me' });
    expect(env.PATH).toBe('C:\\Windows;C:\\Git\\cmd');
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.longpaths',
      GIT_CONFIG_VALUE_0: 'true',
    });
    expect(env.USERPROFILE).toBe('C:\\Users\\me');
  });

  it("appends long paths after the user's own GIT_CONFIG_* entries", () => {
    const env = windowsChildEnv({
      PATH: 'C:\\x',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c',
    });
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_KEY_1: 'core.longpaths' });
  });

  it('draws the taskbar badge as an opaque dot with transparent corners', () => {
    const bitmap = badgeDotBitmap(16, [10, 20, 30, 255]);
    const alpha = (x: number, y: number) => bitmap[(y * 16 + x) * 4 + 3];
    expect(bitmap.length).toBe(16 * 16 * 4);
    expect(alpha(8, 8)).toBe(255);
    expect(alpha(0, 0)).toBe(0);
    expect(bitmap[(8 * 16 + 8) * 4 + 2]).toBe(30);
  });
});
