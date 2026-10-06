import { COMMAND_IDS, type CommandId } from '@shared/bridge';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildMenuTemplate } from './menu-template';

function walk(items: MenuItemConstructorOptions[], visit: (item: MenuItemConstructorOptions) => void): void {
  for (const item of items) {
    visit(item);
    if (Array.isArray(item.submenu)) walk(item.submenu, visit);
  }
}

describe('menu template', () => {
  const sent: CommandId[] = [];
  const template = buildMenuTemplate({ appName: 'Legion', isMac: true, isDev: false, send: (c) => sent.push(c) });

  it('has the standard macOS structure', () => {
    expect(template.map((m) => m.label)).toEqual(['Legion', 'File', 'Edit', 'Run', 'View', 'Window', 'Help']);
  });

  it('exposes every command id and sends it on click', () => {
    walk(template, (item) => item.click?.(item as never, undefined, {} as never));
    expect([...new Set(sent)].sort()).toEqual([...COMMAND_IDS].sort());
  });

  it('does not bind accelerators that clash with text editing or the renderer', () => {
    const accelerators: string[] = [];
    walk(template, (item) => {
      if (typeof item.accelerator === 'string') accelerators.push(item.accelerator);
    });
    expect(new Set(accelerators).size).toBe(accelerators.length);
    for (const bad of ['CmdOrCtrl+W', 'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+X', 'CmdOrCtrl+A', 'CmdOrCtrl+Z']) {
      expect(accelerators).not.toContain(bad);
    }
  });
});
