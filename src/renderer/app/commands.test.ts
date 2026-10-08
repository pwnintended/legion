import type { Plan, Run } from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentToasts } from '../overlays/nav';
import {
  builtinCommands,
  executeCommand,
  handleAgentsEscape,
  handleKeyDown,
  registerCommand,
  registerCommands,
} from './commands';
import { initialData } from './data';
import { actions, dataStore, initialUi, uiStore } from './store';

// The key events here are macOS ones (⌘ = metaKey): pin the OS so the suite means the same on every host.
// commands-linux.test.ts covers Ctrl as Mod.
vi.mock('./platform', async (importOriginal) => ({ ...(await importOriginal()), OS: 'mac', IS_MAC: true }));

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

  it("runs a view's bindings only in that view, when no overlay is open", () => {
    const off = registerCommand({
      id: 'test.codeOnly',
      title: 'Code only',
      keybinding: 'Mod+Enter',
      when: (ctx) => ctx.ui.view === 'code',
      run: () => void ran.push('test.codeOnly'),
    });
    try {
      expect(handleKeyDown(cmdEnter() as unknown as KeyboardEvent)).toBe(false);
      uiStore.setState({ view: 'agents' });
      expect(handleKeyDown(cmdEnter() as unknown as KeyboardEvent)).toBe(false);
      expect(ran).toEqual([]);
      uiStore.setState({ view: 'code' });
      const event = cmdEnter();
      expect(handleKeyDown(event as unknown as KeyboardEvent)).toBe(true);
      expect(ran).toEqual(['test.codeOnly']);
      expect(event.prevented).toBe(true);
    } finally {
      off();
    }
  });

  it('leaves keys to an open overlay: ⌘⏎ on a button inside the composer runs no command', () => {
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

  it('a popover marked data-local-keys owns Esc (the picker closes, not the composer); ⌘ chords still pass', () => {
    uiStore.setState({ overlay: 'composer' });
    const input = {
      tagName: 'INPUT',
      type: 'text',
      isContentEditable: false,
      closest: (selector: string) => (selector === '[data-local-keys]' ? {} : null),
    };
    const esc = keydown({ key: 'Escape', code: 'Escape', target: input });
    expect(handleKeyDown(esc as unknown as KeyboardEvent)).toBe(false);
    expect(esc.prevented).toBe(false);
    handleKeyDown(keydown({ key: 'k', code: 'KeyK', metaKey: true, target: input }) as unknown as KeyboardEvent);
    expect(ran).toEqual(['palette.open']);
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
      uiStore.setState({ overlay: 'palette' });
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

  it('⌥ HJKL is a command chord on macOS: it reaches Legion from a text field or terminal, unless it types ASCII', () => {
    const off = registerCommand({
      id: 'test.pane',
      title: 'Pane left',
      keybinding: ['Alt+H', 'Mod+Alt+H'],
      run: () => void ran.push('test.pane'),
    });
    try {
      const textarea = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
      const terminal = {
        tagName: 'TEXTAREA',
        isContentEditable: false,
        closest: (selector: string) => (selector.includes('.xterm') ? {} : null),
      };
      const optH = (target: unknown, key = '˙') => keydown({ key, code: 'KeyH', altKey: true, target });
      expect(handleKeyDown(optH(textarea) as unknown as KeyboardEvent)).toBe(true);
      expect(handleKeyDown(optH(terminal) as unknown as KeyboardEvent)).toBe(true);
      const ascii = optH(textarea, '@');
      expect(handleKeyDown(ascii as unknown as KeyboardEvent)).toBe(false);
      expect(ascii.prevented).toBe(false);
      expect(ran).toEqual(['test.pane', 'test.pane']);
    } finally {
      off();
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

describe("a conversation's agents (⌘E in, ⌘E or Esc out)", () => {
  const ran: string[] = [];
  let dispose: (() => void) | null = null;
  const cmdE = () => keydown({ key: 'e', code: 'KeyE', metaKey: true, target: button }) as unknown as KeyboardEvent;
  const esc = (target: unknown = button) => keydown({ key: 'Escape', code: 'Escape', target });
  const withRun = (status: Run['status']) =>
    dataStore.setState({ ...initialData(), runs: { r1: { id: 'r1', status } as unknown as Run } });
  const withPlan = () =>
    dataStore.setState({
      ...initialData(),
      runs: { r1: { id: 'r1', status: 'awaiting_approval' } as unknown as Run },
      plans: { p1: { id: 'p1', runId: 'r1', version: 1 } as unknown as Plan },
    });

  beforeEach(() => {
    ran.length = 0;
    dataStore.setState(initialData());
    uiStore.setState({ ...initialUi(), view: 'chat', activeRunId: 'r1' });
    dispose = registerCommands(builtinCommands().map((c) => ({ ...c, run: () => void ran.push(c.id) })));
  });
  afterEach(() => {
    dispose?.();
    dataStore.setState(initialData());
    uiStore.setState(initialUi());
  });

  it('⌘E does nothing on a conversation still with the assistant, and never falls through to the code', () => {
    withRun('chatting');
    expect(handleKeyDown(cmdE())).toBe(false);
    uiStore.setState({ activeRunId: null });
    expect(handleKeyDown(cmdE())).toBe(false);
    expect(ran).toEqual([]);
    actions.setView('agents');
    expect(uiStore.getState().view).toBe('chat');
  });

  it("⌘E opens the focused conversation's agents once the planner is at work, or there is a plan", () => {
    withRun('clarifying');
    expect(handleKeyDown(cmdE())).toBe(true);
    withPlan();
    expect(handleKeyDown(cmdE())).toBe(true);
    expect(ran).toEqual(['view.agents', 'view.agents']);
  });

  it('⌘E is not available from the code view', () => {
    withPlan();
    uiStore.setState({ view: 'code' });
    expect(handleKeyDown(cmdE())).toBe(false);
    expect(ran).toEqual([]);
  });

  it('inside the agents, ⌘E and Esc go back to the board', () => {
    withPlan();
    uiStore.setState({ view: 'agents' });
    expect(handleKeyDown(cmdE())).toBe(true);
    expect(handleAgentsEscape(esc() as unknown as KeyboardEvent)).toBe(true);
    expect(ran).toEqual(['view.agents.leave', 'view.agents.leave']);
  });

  it('Esc stays with a field, an overlay or a handler that already took it', () => {
    withPlan();
    uiStore.setState({ view: 'agents' });
    const input = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
    expect(handleAgentsEscape(esc(input) as unknown as KeyboardEvent)).toBe(false);
    const taken = { ...esc(), defaultPrevented: true };
    expect(handleAgentsEscape(taken as unknown as KeyboardEvent)).toBe(false);
    uiStore.setState({ overlay: 'palette' });
    expect(handleAgentsEscape(esc() as unknown as KeyboardEvent)).toBe(false);
    expect(ran).toEqual([]);
  });
});
