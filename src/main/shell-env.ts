import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { delimiter } from 'node:path';
import type { Os } from '@shared/platform';

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

/** Directories where CLIs commonly live on `os`, appended as a safety net. */
export function fallbackPathEntries(os: Os, home = homedir()): string {
  const user = [`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.npm-global/bin`];
  const system = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const byOs: Record<Os, string[]> = {
    mac: ['/opt/homebrew/bin', ...user, ...system],
    linux: [...user, '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', ...system],
    // Windows doesn't ask a login shell (its GUI apps get the user's Path); nothing to add.
    windows: [],
  };
  return byOs[os].join(delimiter);
}

/** The user's login shell: `$SHELL`, else the account's (passwd) shell, else `/bin/sh`. */
export function loginShell(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.SHELL) return env.SHELL;
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // no passwd entry (containers)
  }
  return '/bin/sh';
}

/** `base` with the login shell's PATH and the login shell itself in `SHELL` (POSIX `resolveChildEnv`). */
export async function loginShellEnv(os: Os, base: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  return { ...base, PATH: await resolveLoginShellPath(os), SHELL: loginShell(base) };
}

/**
 * GUI-launched apps (macOS Finder/Dock, a Linux `.desktop` launcher) don't inherit the user's shell PATH. Ask the
 * login shell for it (`$SHELL -ilc`), with a timeout, and fall back to well-known locations for `os`.
 */
export function resolveLoginShellPath(os: Os, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      loginShell(),
      ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      { timeout: timeoutMs, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        const fromShell = error ? null : parseMarkedPath(String(stdout));
        resolve(mergePaths(fromShell, process.env.PATH, fallbackPathEntries(os)));
      },
    );
  });
}
