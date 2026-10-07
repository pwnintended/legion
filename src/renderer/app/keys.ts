/**
 * Keybinding strings: `Mod+Alt+H`, `Mod+Shift+Enter`, `Escape`, `H`. `Mod` = ⌘ on macOS (Ctrl elsewhere).
 * Letters and digits match on `event.code` (so ⌥ doesn't turn H into ˙); named keys match on `event.key`.
 */

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

export const IS_MAC = typeof navigator === 'undefined' || /Mac|iPhone|iPad/.test(navigator.platform ?? '');

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
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

export function matchesChord(chord: Chord, event: KeyEventLike, mac = IS_MAC): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const ctrl = mac ? event.ctrlKey : false;
  return (
    chord.mod === mod &&
    chord.alt === event.altKey &&
    chord.shift === event.shiftKey &&
    chord.ctrl === ctrl &&
    chord.key === eventKey(event)
  );
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

/** `Mod+Alt+H` → `⌘⌥H` (mac) / `Ctrl+Alt+H`. */
export function formatChord(binding: string, mac = IS_MAC): string {
  const chord = parseChord(binding);
  const key = SYMBOLS[chord.key] ?? chord.key;
  if (mac)
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`;
  return [chord.ctrl || chord.mod ? 'Ctrl' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', key]
    .filter(Boolean)
    .join('+');
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
