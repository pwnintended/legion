import { describe, expect, it } from 'vitest';
import { formatChord, type KeyEventLike, matchesChord, parseChord } from './keys';

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
});
