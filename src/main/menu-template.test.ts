import { COMMAND_IDS, type CommandId } from '@shared/bridge';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildMenuTemplate, MENU_ACCELERATORS } from './menu-template';

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

  const accelerators = (t: MenuItemConstructorOptions[]) => {
    const out: { accelerator: string; label: string | undefined }[] = [];
    walk(t, (item) => {
      if (typeof item.accelerator === 'string') out.push({ accelerator: item.accelerator, label: item.label });
    });
    return out;
  };

  it('does not bind accelerators that clash with text editing or the renderer', () => {
    const list = accelerators(template).map((a) => a.accelerator);
    expect(new Set(list).size).toBe(list.length);
    for (const bad of ['CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+X', 'CmdOrCtrl+A', 'CmdOrCtrl+Z']) {
      expect(list).not.toContain(bad);
    }
    // ⌘1–9 switch workspaces in the renderer.
    for (let n = 1; n <= 9; n++) expect(list).not.toContain(`CmdOrCtrl+${n}`);
  });

  it('mirrors the renderer command registry', () => {
    // Keep in sync with builtinCommands() in src/renderer/app/commands.ts.
    expect(MENU_ACCELERATORS).toEqual({
      'composer.open': 'CmdOrCtrl+N',
      'inbox.open': 'CmdOrCtrl+I',
      'palette.open': 'CmdOrCtrl+K',
      'layout.focus': 'CmdOrCtrl+Return',
      'layout.overview': 'CmdOrCtrl+Shift+O',
      'layout.pipeline': 'CmdOrCtrl+G',
      'focus.nextUrgent': 'CmdOrCtrl+U',
      'column.cycleMode': 'CmdOrCtrl+W',
      'mode.resize': 'CmdOrCtrl+R',
      'settings.open': 'CmdOrCtrl+,',
    });
  });

  it('puts Settings… (⌘,) in the app menu on macOS and in File elsewhere', () => {
    const settings = (t: MenuItemConstructorOptions[], menu: string) =>
      ((t.find((m) => m.label === menu)?.submenu ?? []) as MenuItemConstructorOptions[]).find(
        (i) => i.label === 'Settings…',
      );
    expect(settings(template, 'Legion')).toMatchObject({ accelerator: 'CmdOrCtrl+,' });
    const other = buildMenuTemplate({ appName: 'Legion', isMac: false, isDev: false, send: () => {} });
    expect(settings(other, 'File')).toMatchObject({ accelerator: 'CmdOrCtrl+,' });
  });

  it('routes ⌘W and ⌘R to Legion commands, not to close/reload', () => {
    for (const isDev of [false, true]) {
      const list = accelerators(buildMenuTemplate({ appName: 'Legion', isMac: true, isDev, send: () => {} }));
      expect(list.filter((a) => a.accelerator === 'CmdOrCtrl+W').map((a) => a.label)).toEqual([
        'Toggle Tabbed / Stacked Column',
      ]);
      expect(list.filter((a) => a.accelerator === 'CmdOrCtrl+R').map((a) => a.label)).toEqual(['Resize Mode']);
    }
    let roles: unknown[] = [];
    walk(template, (item) => {
      roles.push(item.role);
    });
    roles = roles.filter(Boolean);
    expect(roles).not.toContain('windowMenu');
    expect(roles).not.toContain('close');
  });
});
