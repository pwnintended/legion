import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { RepoInspection } from '@shared/rpc';
import { execa } from 'execa';
import { z } from 'zod';

const LegionConfigFileSchema = z.object({
  setup: z.array(z.string()).optional(),
  verify: z.array(z.string()).optional(),
  copy: z.array(z.string()).optional(),
  symlink: z.array(z.string()).optional(),
  highRiskGlobs: z.array(z.string()).optional(),
  installCommand: z.string().optional(),
});

async function git(cwd: string, env: Readonly<Record<string, string>>, args: string[]): Promise<string | null> {
  const result = await execa('git', args, { cwd, env, extendEnv: false, reject: false, timeout: 10_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Parse `owner/name` from a GitHub remote URL (https or ssh). */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
}

export function parseRemotes(output: string): { name: string; url: string }[] {
  const remotes = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match?.[1] && match[2]) remotes.set(match[1], match[2]);
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
}

async function hasExecutable(name: string, env: Readonly<Record<string, string>>): Promise<boolean> {
  const result = await execa(name, ['--version'], { env, extendEnv: false, reject: false, timeout: 5000 });
  return result.exitCode === 0;
}

/** `gh auth token` only reads gh's local credential store (no network); exit 0 = logged in to github.com. */
async function ghLoggedIn(env: Readonly<Record<string, string>>): Promise<boolean> {
  const result = await execa('gh', ['auth', 'token', '--hostname', 'github.com'], {
    env,
    extendEnv: false,
    reject: false,
    timeout: 5000,
    stdout: 'ignore',
  });
  return result.exitCode === 0;
}

async function readLegionConfig(root: string): Promise<RepoInspection['legionConfig']> {
  const raw = await readFile(join(root, 'legion.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = LegionConfigFileSchema.parse(JSON.parse(raw));
    return {
      setup: parsed.setup ?? null,
      verify: parsed.verify ?? null,
      copy: parsed.copy ?? null,
      symlink: parsed.symlink ?? null,
      highRiskGlobs: parsed.highRiskGlobs ?? null,
      installCommand: parsed.installCommand ?? null,
    };
  } catch {
    return null;
  }
}

/** Read-only inspection of a directory as a candidate repo for a run (never modifies anything). */
export async function inspectRepo(path: string, env: Readonly<Record<string, string>>): Promise<RepoInspection> {
  const base: RepoInspection = {
    path,
    exists: false,
    isGitRepo: false,
    root: null,
    currentBranch: null,
    headSha: null,
    defaultBranch: null,
    remotes: [],
    github: null,
    dirty: false,
    hasGh: false,
    ghAuthenticated: null,
    legionConfig: null,
    error: null,
  };
  if (!isAbsolute(path)) return { ...base, error: 'path must be absolute' };
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return { ...base, error: 'not a directory' };

  const [toplevel, hasGh] = await Promise.all([
    git(path, env, ['rev-parse', '--show-toplevel']),
    hasExecutable('gh', env),
  ]);
  if (toplevel === null) return { ...base, exists: true, hasGh, error: 'not a git repository' };
  // git prints `C:/Users/…` on Windows; Legion stores and compares the OS's own form (`C:\Users\…`).
  const root = resolve(toplevel);

  const [currentBranch, headSha, remotesRaw, originHead, status, legionConfig, ghAuthenticated] = await Promise.all([
    git(root, env, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(root, env, ['rev-parse', '-q', '--verify', 'HEAD']),
    git(root, env, ['remote', '-v']),
    git(root, env, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
    git(root, env, ['status', '--porcelain', '--untracked-files=no']),
    readLegionConfig(root),
    hasGh ? ghLoggedIn(env) : Promise.resolve(null),
  ]);
  const remotes = parseRemotes(remotesRaw ?? '');

  let defaultBranch = originHead ? originHead.replace(/^origin\//, '') : null;
  if (!defaultBranch) {
    for (const candidate of ['main', 'master']) {
      if ((await git(root, env, ['rev-parse', '-q', '--verify', `refs/heads/${candidate}`])) !== null) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  defaultBranch ??= currentBranch || null;

  const githubRemote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  return {
    ...base,
    exists: true,
    isGitRepo: true,
    root,
    currentBranch: currentBranch || null,
    headSha: headSha || null,
    defaultBranch,
    remotes,
    github: githubRemote ? parseGithubRemote(githubRemote.url) : null,
    dirty: (status ?? '').length > 0,
    hasGh,
    ghAuthenticated,
    legionConfig,
  };
}
