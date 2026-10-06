import { realpath } from 'node:fs/promises';
import { ANY_EXIT, GitError, git, gitSucceeds, gitText, runCommand } from './exec';

export async function isRepo(path: string): Promise<boolean> {
  try {
    return (await gitText(path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

/** Working-tree root (the worktree's own root when `path` is inside a linked worktree). */
export async function toplevel(path: string): Promise<string> {
  return realpath(await gitText(path, ['rev-parse', '--show-toplevel']));
}

/** Absolute shared `.git` directory (same for the main checkout and all linked worktrees). */
export async function commonDir(path: string): Promise<string> {
  return realpath(await gitText(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(path: string): Promise<string | null> {
  const r = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okExitCodes: [0, 1] });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return gitSucceeds(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

/** origin/HEAD target, else `main` / `master` if present locally, else the current branch, else null. */
export async function defaultBranch(repo: string): Promise<string | null> {
  const r = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    okExitCodes: [0, 1],
  });
  if (r.exitCode === 0) {
    const name = r.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const candidate of ['main', 'master']) {
    if (await branchExists(repo, candidate)) return candidate;
  }
  return currentBranch(repo);
}

/** Resolve any rev to a full commit sha; throws GitError if it does not exist. */
export async function resolveSha(repo: string, rev: string): Promise<string> {
  return gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]);
}

export function headSha(repo: string): Promise<string> {
  return resolveSha(repo, 'HEAD');
}

export interface Remote {
  name: string;
  url: string;
}

export async function remotes(repo: string): Promise<Remote[]> {
  const names = (await gitText(repo, ['remote'])).split('\n').filter(Boolean);
  const out: Remote[] = [];
  for (const name of names) {
    out.push({ name, url: await gitText(repo, ['remote', 'get-url', name]) });
  }
  return out;
}

/** True when there are staged, unstaged, or untracked (non-ignored) changes. */
export async function isDirty(path: string): Promise<boolean> {
  return (await git(path, ['status', '--porcelain', '-z'])).stdout.length > 0;
}

export function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitSucceeds(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

export interface GhStatus {
  available: boolean;
  /** `gh auth status` exited 0. Always false when gh is unavailable. */
  authenticated: boolean;
}

export async function ghStatus(cwd: string = process.cwd()): Promise<GhStatus> {
  const probe = await runCommand('gh', cwd, ['--version'], { okExitCodes: ANY_EXIT, timeoutMs: 10_000 }).catch(
    () => null,
  );
  if (probe?.exitCode !== 0) return { available: false, authenticated: false };
  const auth = await runCommand('gh', cwd, ['auth', 'status'], { okExitCodes: ANY_EXIT, timeoutMs: 15_000 }).catch(
    () => null,
  );
  return { available: true, authenticated: auth?.exitCode === 0 };
}
