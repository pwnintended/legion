/**
 * Strict matching of agent shell commands against the human-approved verify/setup commands. Used by every
 * auto-allow path (Codex pre-approval, Claude `Bash(...)` rules): a request is covered only when it is
 * exactly an allowed command, or that command followed by plain arguments that cannot change how a shell
 * parses it (no operators, substitutions, redirections, globs, quotes or escapes).
 */

/** Characters that let a shell do more than run one command with literal arguments. */
const SHELL_META = /[;&|$`(){}<>*?!~#^[\]'"\\\n\r]/;

/** True when `text` contains a character with a special meaning to sh/bash/zsh. */
export function hasShellMeta(text: string): boolean {
  return SHELL_META.test(text);
}

/**
 * `script` is `allowed` itself, or `allowed` plus space-separated plain arguments. The allowed command
 * itself may contain anything (a human approved it verbatim); appended arguments may not.
 */
export function matchesAllowedCommand(script: string, allowed: string): boolean {
  const want = allowed.trim();
  const got = script.trim();
  if (want.length === 0 || got.length === 0) return false;
  if (got === want) return true;
  if (!got.startsWith(`${want} `)) return false;
  return !hasShellMeta(got.slice(want.length));
}

/** One POSIX shell word made of plain characters, `'single quoted'` runs and `\'`; null when anything else. */
function singleShellWord(text: string): string | null {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      out += text.slice(i + 1, end);
      i = end + 1;
    } else if (c === '\\' && text[i + 1] === "'") {
      out += "'";
      i += 2;
    } else if (/\s/.test(c) || hasShellMeta(c)) {
      return null;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SHELL_WRAPPER = /^(?:\/[\w./-]*\/)?(?:sh|bash|zsh|dash)\s+(?:-lc|-c|-l\s+-c)\s+(\S[\s\S]*)$/;

/**
 * The script a command line runs: the argument of a `<shell> -lc '<script>'` wrapper (how Codex reports
 * commands), else the command line itself. Null when the wrapper's argument is not one plain shell word.
 */
export function unwrapShellCommand(command: string): string | null {
  const trimmed = command.trim();
  const wrapped = SHELL_WRAPPER.exec(trimmed);
  if (!wrapped) return trimmed;
  return singleShellWord((wrapped[1] as string).trim());
}

/** True when `command` (possibly shell-wrapped) is covered by one of `allowed` (see {@link matchesAllowedCommand}). */
export function isAllowedCommand(command: string, allowed: readonly string[]): boolean {
  const script = unwrapShellCommand(command);
  if (script === null || script.length === 0) return false;
  return allowed.some((a) => matchesAllowedCommand(script, a));
}
