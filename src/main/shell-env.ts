import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';

const MARKER = '__LEGION_PATH__';

/** Extract the PATH printed between markers (rc files may print noise around it). */
export function parseMarkedPath(output: string): string | null {
  const start = output.indexOf(MARKER);
  const end = output.lastIndexOf(MARKER);
  if (start === -1 || end <= start) return null;
  const value = output.slice(start + MARKER.length, end).trim();
  return value.length > 0 ? value : null;
}

/** Merge PATH lists, keeping the first occurrence of each entry. */
export function mergePaths(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const entry of (list ?? '').split(delimiter)) {
      if (entry) seen.add(entry);
    }
  }
  return [...seen].join(delimiter);
}

/** Directories where CLIs commonly live, appended as a safety net. */
export function fallbackPathEntries(home = homedir()): string {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(delimiter);
}

/**
 * GUI-launched apps on macOS don't inherit the user's shell PATH. Ask the login shell for it
 * (`$SHELL -ilc`), with a timeout, and fall back to well-known locations.
 */
export function resolveLoginShellPath(timeoutMs = 5000): Promise<string> {
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      { timeout: timeoutMs, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        const fromShell = error ? null : parseMarkedPath(String(stdout));
        resolve(mergePaths(fromShell, process.env.PATH, fallbackPathEntries()));
      },
    );
  });
}
