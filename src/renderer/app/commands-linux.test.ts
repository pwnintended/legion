/** Key dispatch off macOS: Ctrl is Mod, and a focused terminal or vim editor keeps its bare Ctrl keys. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleKeyDown, registerCommands } from './commands';
import { initialUi, uiStore } from './store';

vi.mock('./platform', async (importOriginal) => ({ ...(await importOriginal()), OS: 'linux', IS_MAC: false }));

/** An element whose `closest` matches the given selector fragment (`.xterm`, `[data-ctrl-keys]`) or nothing. */
const element = (inside: string | null) => ({
  tagName: 'DIV',
  isContentEditable: false,
  closest: (selector: string) => (inside && selector.includes(inside) ? {} : null),
});
const plain = element(null);
const terminal = element('.xterm');
const vimEditor = element('[data-ctrl-keys]');

function keydown(spec: {
  key: string;
  code: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target: unknown;
}) {
  const event = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    ...spec,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {},
  };
  return event as unknown as KeyboardEvent & { prevented: boolean };
}

const ctrl = (letter: string, target: unknown, shiftKey = false) =>
  keydown({ key: letter.toLowerCase(), code: `Key${letter}`, ctrlKey: true, shiftKey, target });

describe('key dispatch off macOS', () => {
  const ran: string[] = [];
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    ran.length = 0;
    uiStore.setState(initialUi());
    dispose = registerCommands(
      [
        { id: 'test.next', keybinding: 'Mod+U' },
        { id: 'test.find', keybinding: 'Mod+Shift+F' },
        { id: 'test.save', keybinding: 'Mod+S', overControlKeys: true },
        { id: 'test.stations', keybinding: 'Mod+Alt+J' },
      ].map((c) => ({ ...c, title: c.id, run: () => void ran.push(c.id) })),
    );
  });
  afterEach(() => {
    dispose?.();
    uiStore.setState(initialUi());
  });

  it('runs Mod chords on Ctrl', () => {
    expect(handleKeyDown(ctrl('U', plain))).toBe(true);
    expect(ran).toEqual(['test.next']);
  });

  it('lets a terminal and a vim editor keep bare Ctrl+letter, unpressed and unprevented', () => {
    for (const target of [terminal, vimEditor]) {
      const event = ctrl('U', target);
      expect(handleKeyDown(event)).toBe(false);
      expect(event.prevented).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it('still runs Ctrl+Shift and Ctrl+Alt chords, and commands that opt over Ctrl keys, in a terminal', () => {
    expect(handleKeyDown(ctrl('F', terminal, true))).toBe(true);
    expect(handleKeyDown(keydown({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true, target: terminal }))).toBe(
      true,
    );
    expect(handleKeyDown(ctrl('S', vimEditor))).toBe(true);
    expect(ran).toEqual(['test.find', 'test.stations', 'test.save']);
  });
});
