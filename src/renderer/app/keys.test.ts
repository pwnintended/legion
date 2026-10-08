import { describe, expect, it } from 'vitest';
import {
  formatChord,
  type KeyEventLike,
  matchesChord,
  parseChord,
  terminalClipboardKey,
  yieldsToControlKeys,
} from './keys';

const key = (patch: Partial<KeyEventLike>): KeyEventLike => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe('keybindings', () => {
  it('parses chords', () => {
    expect(parseChord('Mod+Alt+Shift+h')).toEqual({ mod: true, alt: true, shift: true, ctrl: false, key: 'H' });
    expect(parseChord('Escape').key).toBe('Escape');
    expect(parseChord('Mod+left').key).toBe('ArrowLeft');
    expect(() => parseChord('Mod+')).toThrow();
  });

  it('matches letters by code so ⌥ does not change them', () => {
    const chord = parseChord('Mod+Alt+H');
    expect(matchesChord(chord, key({ key: '˙', code: 'KeyH', metaKey: true, altKey: true }), true)).toBe(true);
    expect(matchesChord(chord, key({ key: 'h', code: 'KeyH', metaKey: true }), true)).toBe(false);
    expect(matchesChord(chord, key({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }), false)).toBe(true);
  });

  it('matches digits, named keys and exact modifiers', () => {
    expect(matchesChord(parseChord('Mod+3'), key({ key: '3', code: 'Digit3', metaKey: true }), true)).toBe(true);
    expect(
      matchesChord(parseChord('Mod+3'), key({ key: '#', code: 'Digit3', metaKey: true, shiftKey: true }), true),
    ).toBe(false);
    expect(matchesChord(parseChord('Escape'), key({ key: 'Escape', code: 'Escape' }), true)).toBe(true);
    expect(matchesChord(parseChord('Mod+Tab'), key({ key: 'Tab', code: 'Tab', metaKey: true }), true)).toBe(true);
    expect(matchesChord(parseChord('H'), key({ key: 'h', code: 'KeyH' }), true)).toBe(true);
  });

  it('formats for macOS and others', () => {
    expect(formatChord('Mod+Alt+Shift+H', true)).toBe('⌥⇧⌘H');
    expect(formatChord('Mod+K', true)).toBe('⌘K');
    expect(formatChord('Mod+Enter', true)).toBe('⌘⏎');
    expect(formatChord('Mod+Alt+Left', false)).toBe('Ctrl+Alt+←');
  });

  it('off macOS, ⌘ is Ctrl, a lone Ctrl is Ctrl, and ⌘⌃ is Ctrl+Super', () => {
    const ctrlH = key({ key: 'h', code: 'KeyH', ctrlKey: true });
    expect(matchesChord(parseChord('Mod+H'), ctrlH, false)).toBe(true);
    expect(
      matchesChord(parseChord('Mod+H'), key({ key: 'h', code: 'KeyH', ctrlKey: true, metaKey: true }), false),
    ).toBe(false);
    expect(matchesChord(parseChord('Ctrl+Tab'), key({ key: 'Tab', code: 'Tab', ctrlKey: true }), false)).toBe(true);
    expect(matchesChord(parseChord('Mod+Ctrl+H'), ctrlH, false)).toBe(false);
    expect(
      matchesChord(parseChord('Mod+Ctrl+H'), key({ key: 'h', code: 'KeyH', ctrlKey: true, metaKey: true }), false),
    ).toBe(true);
    expect(formatChord('Mod+Ctrl+H', false)).toBe('Ctrl+Super+H');
    expect(formatChord('Ctrl+Tab', false)).toBe('Ctrl+⇥');
    expect(formatChord('Mod+Ctrl+H', true)).toBe('⌃⌘H');
  });

  it("off macOS, bare Ctrl+letter chords give way to terminals and vim; the rest stay Legion's", () => {
    const yields = (binding: string, mac = false) => yieldsToControlKeys(parseChord(binding), mac);
    expect(yields('Mod+U')).toBe(true);
    expect(yields('Mod+P')).toBe(true);
    expect(yields('Mod+[')).toBe(true);
    expect(yields('Mod+Shift+F')).toBe(false);
    expect(yields('Mod+Alt+H')).toBe(false);
    expect(yields('Mod+Ctrl+H')).toBe(false);
    expect(yields('Mod+3')).toBe(false);
    expect(yields('Mod+Enter')).toBe(false);
    expect(yields('Ctrl+Tab')).toBe(false);
    expect(yields('Escape')).toBe(false);
    expect(yields('Mod+U', true)).toBe(false);
  });

  it("maps the terminal's clipboard chords per OS", () => {
    const c = { key: 'c', code: 'KeyC' };
    const v = { key: 'v', code: 'KeyV' };
    expect(terminalClipboardKey(key({ ...c, metaKey: true }), true)).toBe('copy');
    expect(terminalClipboardKey(key({ ...v, metaKey: true }), true)).toBeNull();
    expect(terminalClipboardKey(key({ ...c, ctrlKey: true }), true)).toBeNull();
    expect(terminalClipboardKey(key({ ...c, ctrlKey: true, shiftKey: true }), false)).toBe('copy');
    expect(terminalClipboardKey(key({ ...v, ctrlKey: true, shiftKey: true }), false)).toBe('paste');
    expect(terminalClipboardKey(key({ ...c, ctrlKey: true }), false)).toBeNull();
    expect(terminalClipboardKey(key({ ...v, ctrlKey: true }), false)).toBeNull();
  });
});
