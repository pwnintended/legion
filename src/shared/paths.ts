/**
 * Absolute filesystem paths as each OS writes them, for code that can't use `node:path` (the renderer): POSIX
 * `/Users/me/app`, Windows `C:\Users\me\app` (or `C:/…`) and `\\server\share\…`. `~` means the home directory on
 * both. Pure; the engine resolves and compares paths with `node:path` and `realpath`.
 */
import type { Os } from './platform';

/** Is `path` absolute on `os`? */
export function isAbsolutePath(path: string, os: Os): boolean {
  if (os !== 'windows') return path.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
}

/** Is `path` the home shorthand (`~`, `~/…`, and `~\…` on Windows)? */
export function isHomePath(path: string, os: Os): boolean {
  return path === '~' || path.startsWith('~/') || (os === 'windows' && path.startsWith('~\\'));
}

/** The separator `os` writes paths with. */
export function separator(os: Os): '/' | '\\' {
  return os === 'windows' ? '\\' : '/';
}

/** The path's segments (Windows splits on both `\` and `/`; a backslash is an ordinary character elsewhere). */
export function pathSegments(path: string, os: Os): string[] {
  return path.split(os === 'windows' ? /[\\/]/ : '/').filter(Boolean);
}

/**
 * `path` in `os`'s canonical spelling: Windows turns `/` into `\` and keeps a drive root's or share's separator;
 * repeated and trailing separators go everywhere.
 */
export function normalizePath(path: string, os: Os): string {
  if (os !== 'windows') {
    const collapsed = path.replace(/\/{2,}/g, '/');
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  }
  const unc = /^[\\/]{2}(?=[^\\/])/.test(path);
  const body = path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  const joined = unc ? `\\${body}` : body;
  // `C:\` keeps its separator; anything longer loses a trailing one.
  return /^[A-Za-z]:\\$/.test(joined) ? joined : joined.replace(/\\+$/, '');
}

/** `/Users/me/src/app` → `~/src/app` (`C:\Users\me\src` → `~\src`) when under `home`. */
export function abbreviateHome(path: string, home: string | null | undefined, os: Os): string {
  if (!home) return path;
  const sep = separator(os);
  const h = normalizePath(home, os);
  const p = os === 'windows' ? normalizePath(path, os) : path;
  const same = (a: string, b: string) => (os === 'windows' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, h)) return '~';
  const prefix = h.endsWith(sep) ? h : h + sep;
  return same(p.slice(0, prefix.length), prefix) ? `~${sep}${p.slice(prefix.length)}` : path;
}

/** `~…` with the home directory put in; null when the home isn't known. Other paths come back unchanged. */
export function expandHome(path: string, home: string | null | undefined, os: Os): string | null {
  if (!isHomePath(path, os)) return path;
  if (!home) return null;
  return normalizePath(home, os) + (path.length > 1 ? separator(os) + path.slice(2) : '');
}

/** An example absolute path for hints and error messages. */
export function examplePath(os: Os, kind: 'folder' | 'binary'): string {
  const examples: Record<Os, Record<typeof kind, string>> = {
    mac: { folder: '/Users/me/src/app', binary: '/opt/homebrew/bin/claude' },
    linux: { folder: '/home/me/src/app', binary: '/home/me/.local/bin/claude' },
    windows: { folder: 'C:\\Users\\me\\src\\app', binary: 'C:\\Users\\me\\.local\\bin\\claude.exe' },
  };
  return examples[os][kind];
}
