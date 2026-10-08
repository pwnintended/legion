/**
 * Windows: executables are found through PATHEXT (`claude.exe`, `codex.cmd`), npm's `.cmd` shims are run as
 * `node <script>`, processes are stopped as a tree, `legion.json` commands run in Git Bash, terminals open PowerShell.
 *
 * Written with `path.win32` and injected filesystem access, so its tests run on any OS.
 */
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { Command, EnginePlatform, Env } from './types';

export interface WindowsDeps {
  isFile(path: string): boolean;
  /** A small text file's contents (a `.cmd` shim), or null. */
  readText(path: string): string | null;
  /** End `pid` and its descendants; `onFail` when that couldn't be done. */
  killTree(pid: number, onFail: () => void): void;
}

const nodeDeps: WindowsDeps = {
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8').slice(0, 64 * 1024);
    } catch {
      return null;
    }
  },
  killTree: (pid, onFail) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) onFail();
    });
  },
};

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export function windowsPlatform(deps: WindowsDeps = nodeDeps): EnginePlatform {
  const findExecutable = (name: string, env: Env): string | null => {
    const extensions = pathExtensions(env);
    const candidates = (base: string): string[] =>
      extensions.includes(win32.extname(base).toUpperCase())
        ? [base]
        : extensions.map((ext) => base + ext.toLowerCase());
    if (win32.isAbsolute(name)) return candidates(name).find((c) => deps.isFile(c)) ?? null;
    if (/[\\/]/.test(name)) return null;
    for (const dir of pathEntries(env)) {
      const found = candidates(win32.join(dir, name)).find((c) => deps.isFile(c));
      if (found) return found;
    }
    return null;
  };

  return {
    os: 'windows',
    interactiveShell(env) {
      const shell = findExecutable('pwsh', env) ?? findExecutable('powershell', env);
      return shell ? { cmd: shell, args: ['-NoLogo'] } : { cmd: comspec(env), args: [] };
    },
    findExecutable,
    launch(path, args, env) {
      const ext = win32.extname(path).toLowerCase();
      if (ext !== '.cmd' && ext !== '.bat') return { cmd: path, args: [...args] };
      const script = shimScript(deps.readText(path), win32.dirname(path));
      if (script && deps.isFile(script)) {
        const bundled = win32.join(win32.dirname(path), 'node.exe');
        const node = deps.isFile(bundled) ? bundled : (findExecutable('node', env) ?? 'node');
        return { cmd: node, args: [script, ...args] };
      }
      return cmdFallback(path, args, env);
    },
    kill(child, signal) {
      if (child.pid === undefined) child.kill(signal);
      else deps.killTree(child.pid, () => child.kill(signal));
    },
    scriptShell(env) {
      const configured = envValue(env, 'CLAUDE_CODE_GIT_BASH_PATH');
      if (configured && deps.isFile(configured)) return configured;
      const git = findExecutable('git', env);
      if (!git) return true;
      // Git for Windows puts git.exe in cmd\ (on PATH), bin\ or mingw64\bin\; bash.exe lives in bin\.
      const dir = win32.dirname(git);
      const bash = [
        win32.join(dir, '..', 'bin', 'bash.exe'),
        win32.join(dir, 'bash.exe'),
        win32.join(dir, '..', '..', 'bin', 'bash.exe'),
      ]
        .map((p) => win32.normalize(p))
        .find((p) => deps.isFile(p));
      return bash ?? true;
    },
    echo: (text) => ({ cmd: comspec({}), args: ['/d', '/c', 'echo', text] }),
  };
}

/** An environment variable by name, ignoring case (Windows keeps `Path`, not `PATH`). */
export function envValue(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

function pathEntries(env: Env): string[] {
  return (envValue(env, 'PATH') ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && win32.isAbsolute(dir));
}

function pathExtensions(env: Env): string[] {
  return (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toUpperCase())
    .filter((ext) => ext.startsWith('.'));
}

function comspec(env: Env): string {
  return envValue(env, 'ComSpec') || envValue(process.env, 'ComSpec') || 'cmd.exe';
}

/**
 * The JavaScript file an npm / pnpm `.cmd` shim runs (`"%dp0%\node_modules\…\cli.js" %*`, or `%~dp0\…`), as an
 * absolute path; null when the file isn't such a shim.
 */
export function shimScript(text: string | null, shimDir: string): string | null {
  if (!text) return null;
  const match = /"%~?dp0%?\\?([^"%]+?\.[cm]?js)"/i.exec(text);
  return match?.[1] ? win32.resolve(shimDir, match[1]) : null;
}

// cmd.exe quoting, as cross-spawn does it: quote each argument for the C runtime, then ^-escape cmd's metacharacters
// (twice for node_modules\.bin shims, which pass `%*` through a second cmd parse). Arguments can't hold newlines.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeArgument(arg: string, twice: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`.replace(CMD_META, '^$1');
  return twice ? quoted.replace(CMD_META, '^$1') : quoted;
}

function cmdFallback(path: string, args: readonly string[], env: Env): Command {
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(path);
  const line = [win32.normalize(path).replace(CMD_META, '^$1'), ...args.map((a) => escapeArgument(a, twice))].join(' ');
  return { cmd: comspec(env), args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
