/**
 * Catppuccin Mocha hex → token name, for colours that arrive as literals (Shiki token colours, highlighted
 * HTML): mapping them onto `var(--name)` lets them follow the active flavour (Settings → Appearance).
 */
const MOCHA: Record<string, string> = {
  f5e0dc: 'rosewater',
  f2cdcd: 'flamingo',
  f5c2e7: 'pink',
  cba6f7: 'mauve',
  f38ba8: 'red',
  eba0ac: 'maroon',
  fab387: 'peach',
  f9e2af: 'yellow',
  a6e3a1: 'green',
  '94e2d5': 'teal',
  '89dceb': 'sky',
  '74c7ec': 'sapphire',
  '89b4fa': 'blue',
  b4befe: 'lavender',
  cdd6f4: 'text',
  bac2de: 'subtext1',
  a6adc8: 'subtext0',
  '9399b2': 'overlay2',
  '7f849c': 'overlay1',
  '6c7086': 'overlay0',
  '585b70': 'surface2',
  '45475a': 'surface1',
  '313244': 'surface0',
  '1e1e2e': 'base',
  '181825': 'mantle',
  '11111b': 'crust',
};

/** `#cba6f7` → `var(--mauve)`; anything else is returned unchanged. */
export function themedColor(hex: string): string {
  const name = MOCHA[hex.replace(/^#/, '').slice(0, 6).toLowerCase()];
  return name && hex.length <= 7 ? `var(--${name})` : hex;
}

/** Rewrite Mocha hex literals inside highlighted HTML (`style="color:#cba6f7"`). */
export function themeHtml(html: string): string {
  return html.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => themedColor(hex));
}
