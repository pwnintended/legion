/**
 * Keybinding strings: `Mod+Alt+H`, `Mod+Shift+Enter`, `Escape`, `H`. `Mod` = ⌘ on macOS (Ctrl elsewhere).
 * Letters, digits and brackets match on `event.code` (so ⌥ doesn't turn H into ˙, nor ⇧ [ into {); named
 * keys match on `event.key`.
 *
 * Off macOS, ⌘ and ⌃ are the same key (Ctrl), so a binding's `Ctrl` there means Ctrl, unless the binding also has
 * `Mod` (⌘⌃ on macOS): then it is Ctrl+Super. And Ctrl is what terminals and vim run on, so inside them a bare
 * Ctrl+<letter> is theirs, not Legion's (`yieldsToControlKeys`).
 */
import { IS_MAC, OS } from './platform';

export { IS_MAC };

export interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  /** Upper-case letter/digit or a named key (Enter, Escape, Tab, ArrowLeft, ...). */
  key: string;
}

export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  backspace: 'Backspace',
};

export function parseChord(binding: string): Chord {
  const parts = binding.split('+').map((p) => p.trim());
  const chord: Chord = { mod: false, alt: false, shift: false, ctrl: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'meta') chord.mod = true;
    else if (lower === 'alt' || lower === 'option' || lower === 'opt') chord.alt = true;
    else if (lower === 'shift') chord.shift = true;
    else if (lower === 'ctrl' || lower === 'control') chord.ctrl = true;
    else chord.key = ALIASES[lower] ?? (part.length === 1 ? part.toUpperCase() : part);
  }
  if (!chord.key) throw new Error(`keybinding without a key: ${binding}`);
  return chord;
}

function eventKey(event: KeyEventLike): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  // Brackets by position, so ⇧ (which makes them braces) doesn't change the key.
  if (event.code === 'BracketLeft') return '[';
  if (event.code === 'BracketRight') return ']';
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

export function matchesChord(chord: Chord, event: KeyEventLike, mac = IS_MAC): boolean {
  const { ctrl, meta } = physicalModifiers(chord, mac);
  return (
    ctrl === event.ctrlKey &&
    meta === event.metaKey &&
    chord.alt === event.altKey &&
    chord.shift === event.shiftKey &&
    chord.key === eventKey(event)
  );
}

/** Which of Ctrl and Meta (⌘ on macOS, Super elsewhere) a chord holds down. */
function physicalModifiers(chord: Chord, mac: boolean): { ctrl: boolean; meta: boolean } {
  if (mac) return { ctrl: chord.ctrl, meta: chord.mod };
  return { ctrl: chord.mod || chord.ctrl, meta: chord.mod && chord.ctrl };
}

const SYMBOLS: Record<string, string> = {
  Enter: '⏎',
  Escape: 'esc',
  Tab: '⇥',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: '⌫',
  ' ': 'Space',
};

/** The Meta key's name off macOS. */
const META_NAME = OS === 'windows' ? 'Win' : 'Super';

/**
 * Is AltGr held? Windows reports AltGr as Ctrl+Alt, so typing `@`, `{` or `ę` on many keyboards would otherwise
 * match Legion's Ctrl+Alt chords. Those keys are characters, never commands.
 */
export function isAltGraph(event: { getModifierState?: (key: string) => boolean }): boolean {
  return typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
}

/**
 * On macOS ⌥ types characters: ˙∆˚¬ for ⌥HJKL on a US layout, but `@` for ⌥L on a German one. A ⌥-chord (no ⌘
 * or ⌃) that types a plain ASCII character is that character, never a command.
 */
export function typesOptionCharacter(event: KeyEventLike, mac = IS_MAC): boolean {
  if (!mac || !event.altKey || event.metaKey || event.ctrlKey) return false;
  return event.key.length === 1 && event.key >= ' ' && event.key <= '~';
}

/**
 * Is a chord Legion's even inside a text field or terminal? ⌘/Ctrl chords are, and on macOS ⌥ ones too (only the
 * pane keys use a bare ⌥; the terminal doesn't use ⌥ as Meta).
 */
export function isCommandChord(chord: Chord, mac = IS_MAC): boolean {
  return chord.mod || chord.ctrl || (mac && chord.alt);
}

/** The modifiers that move between panes: ⌥ on macOS, Ctrl+Alt elsewhere (Alt+letter is the menu's and the shell's). */
export const PANE_MODIFIERS = IS_MAC ? 'Alt' : 'Mod+Alt';

/**
 * The bindings of a pane-navigation key (`H`, `Left`): ⌥H on macOS, plus ⌘⌥H as before. Arrows stay ⌘⌥ (⌥ arrows
 * move by word and line in a text field). `extra` adds modifiers: `Shift+` to move the tile instead.
 */
export function paneBindings(key: string, extra = '', mac = IS_MAC): string[] {
  const chords = [`Mod+Alt+${extra}${key}`];
  if (mac && key.length === 1) chords.unshift(`Alt+${extra}${key}`);
  return chords;
}

/** `Mod+Alt+H` → `⌘⌥H` (mac) / `Ctrl+Alt+H`;`Mod+Ctrl+H` → `⌃⌘H` / `Ctrl+Super+H` (`Ctrl+Win+H`). */
export function formatChord(binding: string, mac = IS_MAC): string {
  const chord = parseChord(binding);
  const key = SYMBOLS[chord.key] ?? chord.key;
  if (mac)
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`;
  const { ctrl, meta } = physicalModifiers(chord, mac);
  return [ctrl ? 'Ctrl' : '', meta ? META_NAME : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', key]
    .filter(Boolean)
    .join('+');
}

/** The modifiers of a binding as a prefix for hints: `Mod+Alt` → `⌘⌥` (mac) / `Ctrl+Alt+`. */
export function formatModifiers(modifiers: string, mac = IS_MAC): string {
  return formatChord(`${modifiers}+X`, mac).slice(0, -1);
}

/**
 * Off macOS, does a chord give way to a focused terminal or vim editor (`ownsControlKeys`)? A bare Ctrl+<letter or
 * symbol> does: readline and vim need Ctrl+U, Ctrl+P, Ctrl+W… Chords with Shift, Alt or Super, and Ctrl+<digit,
 * Enter, Tab, arrow> stay Legion's. On macOS nothing yields: Legion's chords are ⌘, the shell's are ⌃.
 */
export function yieldsToControlKeys(chord: Chord, mac = IS_MAC): boolean {
  if (mac || !(chord.mod || chord.ctrl) || chord.alt || chord.shift || (chord.mod && chord.ctrl)) return false;
  return chord.key.length === 1 && !/[0-9]/.test(chord.key);
}

/**
 * The terminal's clipboard chords: ⌘C copies on macOS (⌘V is the native paste); elsewhere Ctrl+C and Ctrl+V go
 * to the shell, so Ctrl+Shift+C copies and Ctrl+Shift+V pastes, as in every Linux terminal.
 */
export function terminalClipboardKey(event: KeyEventLike, mac = IS_MAC): 'copy' | 'paste' | null {
  const key = eventKey(event);
  if (mac) return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'C' ? 'copy' : null;
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null;
  return key === 'C' ? 'copy' : key === 'V' ? 'paste' : null;
}

/** Does the event target accept text (so plain keys must pass through)? */
export function isTextInput(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/** Is the target inside a terminal (xterm or anything marked `data-terminal`)? */
/**
 * Inside a popover that handles plain keys itself (a combobox list: Escape closes the list, not the overlay
 * around it). Mark its root with `data-local-keys`.
 */
export function ownsPlainKeys(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest('[data-local-keys]') !== null;
}

export function isTerminal(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest('[data-terminal], .xterm, [data-tile-kind="terminal"] [data-tile-body]') !== null;
}

/**
 * Does the target run on Ctrl keys of its own (see `yieldsToControlKeys`)? Terminals do, and anything marked
 * `data-ctrl-keys` (the code editor in vim mode).
 */
export function ownsControlKeys(target: EventTarget | null): boolean {
  if (isTerminal(target)) return true;
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest('[data-ctrl-keys]') !== null;
}
