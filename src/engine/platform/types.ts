/** The contract of an engine platform implementation (see index.ts). */
import type { Os } from '@shared/platform';

export type Env = Readonly<Record<string, string | undefined>>;

/** A program and its arguments, ready for `spawn` / node-pty. */
export interface Command {
  cmd: string;
  args: string[];
  /**
   * Windows only: `args` are already quoted for the command line (a `cmd.exe /c` fallback); pass it to `spawn` as
   * `windowsVerbatimArguments`.
   */
  verbatim?: boolean;
}

/** The part of a ChildProcess `kill` needs. */
export interface Killable {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface EnginePlatform {
  readonly os: Os;
  /** The user's interactive shell, as a terminal tile opens it in `env` (main puts the login shell in `SHELL`). */
  interactiveShell(env: Env): Command;
  /**
   * The absolute path of the executable `name`: `name` itself when it is an absolute path, else the first match
   * on `env`'s PATH (relative PATH entries are skipped). Null when there is none or it can't be run.
   */
  findExecutable(name: string, env: Env): string | null;
  /**
   * How to start the executable at `path` (from `findExecutable`) with `args`, with no shell in between: the
   * path itself on POSIX; on Windows an npm `.cmd` shim becomes `node <its script>` (cmd.exe would cut multi-line
   * arguments such as system prompts).
   */
  launch(path: string, args: readonly string[], env: Env): Command;
  /**
   * Stop a child process. POSIX sends `signal`; Windows has no signals, so it ends the process and everything it
   * started (`taskkill /T /F`), whatever the signal.
   */
  kill(child: Killable, signal: NodeJS.Signals): void;
  /**
   * The shell `legion.json` commands (setup, verify, install) run in, as execa's `shell` option: the system `sh`
   * on POSIX, Git Bash on Windows so the same commands work everywhere (cmd.exe when there is no Git Bash).
   */
  scriptShell(env: Env): string | true;
  /** A command that prints `text` and exits 0 (the packaged app's self-test). */
  echo(text: string): Command;
}
