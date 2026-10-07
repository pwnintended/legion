import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentToasts } from '../overlays/nav';
import { builtinCommands, executeCommand, handleKeyDown, registerCommand, registerCommands } from './commands';
import { initialUi, uiStore } from './store';

interface FakeKey {
  key: string;
  code: string;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

/** A keydown event as far as handleKeyDown cares; records preventDefault. */
function keydown(spec: FakeKey) {
  const event = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    target: null,
    ...spec,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {},
  };
  return event;
}

/** A focused <button> inside the overlay (not a text input, not a terminal). */
const button = { tagName: 'BUTTON', isContentEditable: false, closest: () => null };

const cmdEnter = () => keydown({ key: 'Enter', code: 'Enter', metaKey: true, target: button });

describe('key dispatch', () => {
  const ran: string[] = [];
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    ran.length = 0;
    uiStore.setState(initialUi());
    const commands = builtinCommands().map((c) => ({ ...c, run: () => void ran.push(c.id) }));
    dispose = registerCommands(commands);
  });
  afterEach(() => {
    dispose?.();
    uiStore.setState(initialUi());
  });

  it('runs global layout bindings when no overlay is open', () => {
    const event = cmdEnter();
    expect(handleKeyDown(event as unknown as KeyboardEvent)).toBe(true);
    expect(ran).toEqual(['layout.focus']);
    expect(event.prevented).toBe(true);
  });

  it('leaves keys to an open overlay: ⌘⏎ on a button inside the composer is not layout.focus', () => {
    uiStore.setState({ overlay: 'composer' });
    const event = cmdEnter();
    expect(handleKeyDown(event as unknown as KeyboardEvent)).toBe(false);
    expect(ran).toEqual([]);
    // Not swallowed: the composer's own handler still sees it.
    expect(event.prevented).toBe(false);
    for (const key of [
      { key: 'l', code: 'KeyL', metaKey: true, altKey: true },
      { key: 'g', code: 'KeyG', metaKey: true },
      { key: '1', code: 'Digit1', metaKey: true },
    ])
      expect(handleKeyDown(keydown({ ...key, target: button }) as unknown as KeyboardEvent)).toBe(false);
    expect(ran).toEqual([]);
  });

  it('still lets overlay commands through (switch, close)', () => {
    uiStore.setState({ overlay: 'composer' });
    handleKeyDown(keydown({ key: 'k', code: 'KeyK', metaKey: true, target: button }) as unknown as KeyboardEvent);
    handleKeyDown(keydown({ key: 'Escape', code: 'Escape', target: button }) as unknown as KeyboardEvent);
    expect(ran).toEqual(['palette.open', 'overlay.close']);
  });

  it('tile-scoped commands that opt in win over global ones, and stay quiet under an overlay', () => {
    const off = registerCommand({
      id: 'test.approve',
      title: 'Approve',
      keybinding: 'Mod+Enter',
      priority: 10,
      run: () => void ran.push('test.approve'),
    });
    try {
      handleKeyDown(cmdEnter() as unknown as KeyboardEvent);
      expect(ran).toEqual(['test.approve']);
      uiStore.setState({ overlay: 'inbox' });
      handleKeyDown(cmdEnter() as unknown as KeyboardEvent);
      expect(ran).toEqual(['test.approve']);
    } finally {
      off();
    }
  });

  it('says so in a toast when a command fails (key or palette/menu)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = registerCommands([
      {
        id: 'test.pause',
        title: 'Pause run',
        keybinding: 'P',
        run: async () => {
          throw Object.assign(new Error('run is done'), { code: 'conflict' });
        },
      },
      {
        id: 'test.boom',
        title: 'Resume run',
        run: () => {
          throw new Error('nope');
        },
      },
    ]);
    try {
      handleKeyDown(keydown({ key: 'p', code: 'KeyP', target: button }) as unknown as KeyboardEvent);
      await new Promise((r) => setTimeout(r, 0));
      expect(currentToasts().at(-1)).toMatchObject({ tone: 'error', text: 'Pause run failed: run is done' });
      expect(await executeCommand('test.boom')).toBe(false);
      expect(currentToasts().at(-1)).toMatchObject({ tone: 'error', text: 'Resume run failed: nope' });
    } finally {
      off();
      vi.restoreAllMocks();
    }
  });

  it('runs action commands once per press: a held key (auto-repeat) is swallowed, navigation repeats', () => {
    const off = registerCommands([
      { id: 'test.approve', title: 'Approve', keybinding: 'A', run: () => void ran.push('test.approve') },
      { id: 'test.next', title: 'Next', keybinding: 'J', repeatable: true, run: () => void ran.push('test.next') },
    ]);
    try {
      const press = (key: string, repeat: boolean) =>
        keydown({ key, code: `Key${key.toUpperCase()}`, repeat, target: button });
      expect(handleKeyDown(press('a', false) as unknown as KeyboardEvent)).toBe(true);
      const held = press('a', true);
      expect(handleKeyDown(held as unknown as KeyboardEvent)).toBe(true);
      expect(held.prevented).toBe(true);
      handleKeyDown(press('a', true) as unknown as KeyboardEvent);
      handleKeyDown(press('j', false) as unknown as KeyboardEvent);
      handleKeyDown(press('j', true) as unknown as KeyboardEvent);
      expect(ran).toEqual(['test.approve', 'test.next', 'test.next']);
    } finally {
      off();
    }
  });
});
