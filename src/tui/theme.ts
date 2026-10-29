/**
 * Colors and glyphs. Hex colors are mid-tones that read on dark and light terminals; Ink downgrades them on
 * terminals without truecolor.
 */
export const theme = {
  accent: '#a78bfa',
  user: '#7dd3fc',
  claude: '#e0875f',
  codex: '#5eb8a4',
  ok: '#4ade80',
  warn: '#facc15',
  error: '#f87171',
  info: '#60a5fa',
  code: '#e5c07b',
  muted: 'gray',
} as const;

export type ThemeColor = keyof typeof theme;

/** A theme name, or any Ink color as is. */
export function color(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return name in theme ? theme[name as ThemeColor] : name;
}

export function engineColor(engine: string | null | undefined): string {
  return engine === 'codex' ? theme.codex : engine === 'claude' ? theme.claude : theme.muted;
}

/** The busy mark: a block that dithers up to solid and back, like the startup art. */
export const BUSY_FRAMES = ['░', '░', '▒', '▓', '█', '█', '▓', '▒'];
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const glyph = {
  brand: '◆',
  user: '›',
  assistant: '⏺',
  tool: '⏺',
  result: '⎿',
  ok: '✓',
  fail: '✗',
  cached: '↺',
  gate: '⏸',
  ask: '?',
  pending: '○',
  dot: '·',
} as const;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** `/Users/me/x` → `~/x`. */
export function tildify(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
