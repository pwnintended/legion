/** The contract of an engine platform implementation (see index.ts). */
import type { Os } from '@shared/platform';

export type Env = Readonly<Record<string, string | undefined>>;

/** A program and its arguments, ready for `spawn` / node-pty. */
export interface Command {
  cmd: string;
  args: string[];
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
}
