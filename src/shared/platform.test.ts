import { describe, expect, it } from 'vitest';
import { OPERATING_SYSTEMS, osOf, titleBarFor } from './platform';

describe('platform', () => {
  it('maps process.platform to an Os, other Unixes to Linux', () => {
    expect(osOf('darwin')).toBe('mac');
    expect(osOf('win32')).toBe('windows');
    expect(osOf('linux')).toBe('linux');
    expect(osOf('freebsd')).toBe('linux');
  });

  it('insets the traffic lights on macOS and overlays the window controls elsewhere', () => {
    expect(titleBarFor('mac')).toMatchObject({ style: 'inset', startInset: 84 });
    for (const os of OPERATING_SYSTEMS.filter((o) => o !== 'mac'))
      expect(titleBarFor(os)).toMatchObject({ style: 'overlay', startInset: 0 });
    const heights = new Set(OPERATING_SYSTEMS.map((os) => titleBarFor(os).height));
    expect(heights.size).toBe(1);
  });
});
