/**
 * Links that work on every OS. A directory link is a junction on Windows (no privilege needed; the type is ignored
 * elsewhere). A file link is a symlink, or a copy where file symlinks are refused (Windows without Developer Mode
 * or admin rights).
 */

import { symlinkSync } from 'node:fs';
import { copyFile, stat, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Link the directory `path` to `target`. */
export function linkDirectorySync(target: string, path: string): void {
  symlinkSync(resolve(target), path, 'junction');
}

/** Link `path` to `target` (a file or a directory); copies a file when it can't be linked. */
export async function linkOrCopy(target: string, path: string): Promise<'linked' | 'copied'> {
  const info = await stat(target);
  if (info.isDirectory()) {
    await symlink(resolve(target), path, 'junction');
    return 'linked';
  }
  try {
    await symlink(target, path, 'file');
    return 'linked';
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await copyFile(target, path);
    return 'copied';
  }
}

/** The error a refused symlink raises (EPERM on Windows without the privilege). */
export function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}
