import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, gitText } from './exec';

// Hermetic git: ignore the developer's global/system config and identity.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

export function tmp(prefix = 'legion-git-'): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export interface FixtureRepo {
  /** Main checkout (real path). */
  path: string;
  /** Scratch directory next to it for worktrees / remotes / legion home. */
  scratch: string;
  /** Write files, `git add -A`, commit; returns the new sha. */
  commit(files: Record<string, string | Buffer>, message?: string): Promise<string>;
  /** Run git in the main checkout. */
  git(...args: string[]): Promise<string>;
  head(): Promise<string>;
  cleanup(): void;
}

/** A repo on branch `main` with an initial commit containing `files`. */
export async function makeRepo(
  files: Record<string, string | Buffer> = { 'README.md': '# fixture\n' },
): Promise<FixtureRepo> {
  const { path: scratch, cleanup } = tmp();
  const path = join(scratch, 'repo');
  mkdirSync(path);
  await git(path, ['init', '-q', '-b', 'main']);
  const repo: FixtureRepo = {
    path,
    scratch,
    async commit(f, message = 'commit') {
      writeFiles(path, f);
      await git(path, ['add', '-A']);
      await git(path, ['commit', '-q', '-m', message]);
      return gitText(path, ['rev-parse', 'HEAD']);
    },
    git: (...args) => gitText(path, args),
    head: () => gitText(path, ['rev-parse', 'HEAD']),
    cleanup,
  };
  await repo.commit(files, 'initial');
  return repo;
}

/** A bare repository usable as `origin`. */
export async function makeBare(scratch: string, name = 'origin.git'): Promise<string> {
  const path = join(scratch, name);
  mkdirSync(path);
  await git(path, ['init', '-q', '--bare', '-b', 'main']);
  return path;
}
