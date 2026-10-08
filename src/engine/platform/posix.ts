/** macOS and Linux: `$SHELL -l` for terminals, executables are files with an execute bit on PATH. */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Os } from '@shared/platform';
import type { EnginePlatform, Env } from './types';

export function posixPlatform(os: Exclude<Os, 'windows'>): EnginePlatform {
  return {
    os,
    interactiveShell: (env) => ({ cmd: env.SHELL || '/bin/sh', args: ['-l'] }),
    findExecutable(name, env) {
      if (isAbsolute(name)) return isExecutableFile(name) ? name : null;
      if (name.includes('/')) return null;
      for (const dir of pathEntries(env)) {
        const candidate = join(dir, name);
        if (isExecutableFile(candidate)) return candidate;
      }
      return null;
    },
  };
}

function pathEntries(env: Env): string[] {
  return (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && isAbsolute(dir));
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
