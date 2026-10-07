/**
 * Confinement for read-only project browsing. Every path a renderer sends is repo-relative and checked twice:
 * lexically (no absolute paths, no `..`, nothing under `.git`) and after resolving symlinks (the real path must
 * stay inside the project's real root, and still not inside `.git`). Anything else is refused.
 */
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { RpcError } from '@shared/rpc-transport';

const refuse = (message: string) => new RpcError('bad_request', message);

/** Is this path segment git's own directory? (Case-insensitive: macOS volumes usually are.) */
function isGitDir(segment: string): boolean {
  return segment.toLowerCase() === '.git';
}

/**
 * A clean repo-relative path (`a/b.ts`; '' for the root) or a `bad_request`. Accepts `./a`, `a//b`, `a/`;
 * refuses absolute paths, `..` anywhere, `.git` anywhere, NUL bytes and backslashes.
 */
export function normalizeRel(input: string): string {
  if (input.includes('\0')) throw refuse('invalid path');
  if (input.includes('\\')) throw refuse('invalid path (use / separators)');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.startsWith('~')) {
    throw refuse('paths are relative to the project');
  }
  const segments = input.split('/').filter((s) => s !== '' && s !== '.');
  for (const segment of segments) {
    if (segment === '..') throw refuse('path leaves the project');
    if (isGitDir(segment)) throw refuse("git's own directory is not browsable");
  }
  return segments.join('/');
}

function inside(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The real absolute path of `rel` inside the project, after following symlinks. `not_found` when it doesn't
 * exist; `bad_request` when it (or a symlink on the way) leads outside the root or into `.git`.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const clean = normalizeRel(rel);
  const realRoot = await realpath(root).catch(() => {
    throw new RpcError('failed_precondition', 'the project folder is gone');
  });
  const target = clean ? `${realRoot}${sep}${clean}` : realRoot;
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new RpcError('not_found', `${clean || '.'} does not exist`);
  }
  if (!inside(realRoot, real)) throw refuse('path leads outside the project');
  const relative = real.slice(realRoot.length).split(sep).filter(Boolean);
  if (relative.some(isGitDir)) throw refuse("git's own directory is not browsable");
  return real;
}
