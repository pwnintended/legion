import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinCommands, handleKeyDown, registerCommands } from './commands';
import { buildKeyRows, filterRows, rowsForKey, scopeOf, scopeOrder } from './key-reference';
import { formatChord, formatEvent } from './keys';
import { initialUi, uiStore } from './store';

vi.mock('./platform', async (importOriginal) => ({ ...(await importOriginal()), OS: 'mac', IS_MAC: true }));

const key = (spec: Partial<KeyboardEvent> & { key: string; code: string }) =>
  ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...spec }) as KeyboardEvent;

describe('key reference', () => {
  const rows = buildKeyRows(builtinCommands(), true);
  const row = (id: string) => rows.find((r) => r.id === id);

  it('puts each command in the view it works in', () => {
    expect(scopeOf('board.monocle')).toBe('chat');
    expect(scopeOf('view.agents')).toBe('chat');
    expect(scopeOf('view.agents.leave')).toBe('agents');
    expect(scopeOf('code.splitRight')).toBe('code');
    expect(scopeOf('palette.open')).toBe('global');
  });

  it('folds directions and numbers into one row with one cap', () => {
    expect(row('board.focus')?.caps).toEqual(['⌥HJKL']);
    expect(row('code.resize')?.caps).toEqual(['⌃⌘HJKL']);
    expect(row('workspace')?.caps).toEqual(['⌘1–9']);
    expect(row('code.workspace')?.caps).toEqual(['⌘1–9']);
    expect(rows.some((r) => r.id === 'board.focus.left' || r.id === 'workspace.3')).toBe(false);
    // Every alternate still finds the row.
    expect(
      rowsForKey(rows, key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true }), true).map(
        (r) => r.id,
      ),
    ).toContain('board.focus');
  });

  it('shows ? and ⌘? for the sheet itself, and leaves Esc-closes-overlay out', () => {
    expect(row('help.keys')?.caps).toEqual(['?', '⌘?']);
    expect(row('overlay.close')).toBeUndefined();
  });

  it('lists the keys tiles handle themselves', () => {
    expect(row('local.reply.now')).toMatchObject({ scope: 'chat', where: 'reply', caps: ['⌘⏎'] });
    expect(row('local.diff.hunk')?.caps).toEqual(['J/K']);
  });

  it('answers a pressed chord with every place it means something', () => {
    const ids = rowsForKey(rows, key({ key: 'f', code: 'KeyF', metaKey: true }), true).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['board.monocle', 'code.fullscreen', 'local.editor.find']));
    expect(rowsForKey(rows, key({ key: 'j', code: 'KeyJ', metaKey: true }), true)).toEqual([]);
  });

  it('filters on every word, in titles, places and caps', () => {
    expect(filterRows(rows, 'split').map((r) => r.id)).toContain('code.splitRight');
    expect(filterRows(rows, 'diff comment').map((r) => r.id)).toEqual(['local.diff.comment']);
    expect(filterRows(rows, 'hjkl').map((r) => r.id)).toContain('board.focus');
  });

  it('orders the view on screen first, then Everywhere, then the rest', () => {
    expect(scopeOrder('code')).toEqual(['code', 'global', 'chat', 'agents']);
  });
});

describe('formatting ?', () => {
  it('leaves ⇧ out of keys that are always shifted', () => {
    expect(formatChord('Shift+?', true)).toBe('?');
    expect(formatChord('Mod+Shift+?', true)).toBe('⌘?');
    expect(formatChord('Mod+Shift+?', false)).toBe('Ctrl+?');
  });

  it('writes a pressed key as its cap', () => {
    expect(formatEvent(key({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }), true)).toBe('⇧⌘K');
    expect(formatEvent(key({ key: '∆', code: 'KeyJ', altKey: true }), true)).toBe('⌥J');
    expect(formatEvent(key({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }), false)).toBe('Ctrl+Alt+H');
  });
});

describe('the sheet and the keyboard', () => {
  const ran: string[] = [];
  let dispose: (() => void) | null = null;
  const body = { tagName: 'BODY', isContentEditable: false, closest: () => null };
  const field = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
  const press = (spec: Partial<KeyboardEvent> & { key: string; code: string }, target: unknown = body) =>
    handleKeyDown({
      ...key(spec),
      defaultPrevented: false,
      isComposing: false,
      repeat: false,
      target,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyboardEvent);

  beforeEach(() => {
    ran.length = 0;
    uiStore.setState(initialUi());
    dispose = registerCommands(builtinCommands().map((c) => ({ ...c, run: () => void ran.push(c.id) })));
  });
  afterEach(() => {
    dispose?.();
    uiStore.setState(initialUi());
  });

  it('opens on ? only when nothing is being typed, and on ⌘? anywhere', () => {
    expect(press({ key: '?', code: 'Slash', shiftKey: true })).toBe(true);
    expect(press({ key: '?', code: 'Slash', shiftKey: true }, field)).toBe(false);
    expect(press({ key: '?', code: 'Slash', shiftKey: true, metaKey: true }, field)).toBe(true);
    // Chromium can report the unshifted key with ⌘ held.
    expect(press({ key: '/', code: 'Slash', shiftKey: true, metaKey: true }, field)).toBe(true);
    expect(ran).toEqual(['help.keys', 'help.keys', 'help.keys']);
  });

  it('owns every key while open, except its own toggle', () => {
    uiStore.setState({ overlay: 'keys' });
    expect(press({ key: 'k', code: 'KeyK', metaKey: true })).toBe(false);
    expect(press({ key: 'Escape', code: 'Escape' })).toBe(false);
    expect(press({ key: '?', code: 'Slash', shiftKey: true, metaKey: true })).toBe(true);
    expect(ran).toEqual(['help.keys']);
  });
});
