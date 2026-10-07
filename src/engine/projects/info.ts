/**
 * What the project home shows about a checkout (`projects.info`), the rail's branch/dirty line
 * (`projects.status`) and open pull requests through gh (`prs.list`). All read-only.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '@shared/domain';
import { languageOfPath } from '@shared/languages';
import type { LanguageStat, PrList, ProjectInfo, ProjectStatus, PullRequestSummary } from '@shared/rpc';
import { z } from 'zod';
import { ANY_EXIT, git, runCommand } from '../git';
import { inspectRepo } from '../rpc/repo-inspect';
import type { FileIndex, FileIndexCache } from './file-index';
import { gitLog } from './history';

/** Files stat'ed for the language breakdown; beyond this, languages are counted by files only. */
const MAX_STAT_FILES = 25_000;
const README_NAMES = ['readme.md', 'readme.mdx', 'readme.markdown', 'readme', 'readme.txt', 'readme.rst'];

export function findReadme(index: FileIndex): string | null {
  const root = index.dirs.get('')?.files ?? [];
  for (const wanted of README_NAMES) {
    const hit = root.find((name) => name.toLowerCase() === wanted);
    if (hit) return hit;
  }
  return null;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function languageStats(
  root: string,
  index: FileIndex,
): Promise<{ languages: LanguageStat[]; totalBytes: number }> {
  const byBytes = index.files.length <= MAX_STAT_FILES;
  const sizes = byBytes
    ? await mapLimit(index.files, 64, async (path) => {
        const info = await lstat(join(root, path)).catch(() => null);
        return info?.isFile() ? info.size : 0;
      })
    : index.files.map(() => 0);
  const stats = new Map<string, LanguageStat>();
  let totalBytes = 0;
  index.files.forEach((path, i) => {
    const size = sizes[i] ?? 0;
    totalBytes += size;
    const name = languageOfPath(path);
    if (!name) return;
    const stat = stats.get(name) ?? { name, files: 0, bytes: 0 };
    stat.files += 1;
    stat.bytes += size;
    stats.set(name, stat);
  });
  const languages = [...stats.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files);
  return { languages, totalBytes };
}

export async function projectInfo(
  project: Project,
  cache: FileIndexCache,
  env: Readonly<Record<string, string>>,
): Promise<ProjectInfo> {
  const inspection = await inspectRepo(project.path, env);
  const empty: ProjectInfo = {
    project,
    exists: false,
    currentBranch: null,
    headSha: null,
    defaultBranch: null,
    remotes: [],
    github: null,
    dirty: false,
    hasGh: inspection.hasGh,
    ghAuthenticated: null,
    readme: null,
    fileCount: 0,
    totalBytes: 0,
    languages: [],
    lastCommit: null,
    commitCount: null,
  };
  if (!inspection.isGitRepo) return empty;
  const index = await cache.get(project.path);
  const [stats, last, count] = await Promise.all([
    languageStats(project.path, index),
    gitLog(project.path, 1, null).catch(() => []),
    inspection.headSha
      ? git(project.path, ['rev-list', '--count', 'HEAD'], { okExitCodes: ANY_EXIT, timeoutMs: 8000 }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const commitCount = count?.exitCode === 0 ? Number(count.stdout.trim()) : null;
  return {
    ...empty,
    exists: true,
    currentBranch: inspection.currentBranch,
    headSha: inspection.headSha,
    defaultBranch: inspection.defaultBranch,
    remotes: inspection.remotes,
    github: inspection.github,
    dirty: inspection.dirty,
    ghAuthenticated: inspection.ghAuthenticated ?? null,
    readme: findReadme(index),
    fileCount: index.files.length,
    totalBytes: stats.totalBytes,
    languages: stats.languages,
    lastCommit: last[0] ?? null,
    commitCount: Number.isFinite(commitCount) ? commitCount : null,
  };
}

/** Parse `git status --porcelain=v2 --branch` (branch header lines + one line per changed entry). */
export function parseStatusV2(output: string): Omit<ProjectStatus, 'projectId' | 'exists'> {
  let branch: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let dirty = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim();
      branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line && !line.startsWith('#')) dirty = true;
  }
  return { branch, dirty, ahead, behind };
}

export async function projectStatus(project: Project): Promise<ProjectStatus> {
  const out = await git(project.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'], {
    okExitCodes: ANY_EXIT,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (out?.exitCode !== 0) {
    return { projectId: project.id, exists: false, branch: null, dirty: false, ahead: null, behind: null };
  }
  return { projectId: project.id, exists: true, ...parseStatusV2(out.stdout) };
}

// ---------------------------------------------------------------------------------------------
// Pull requests (gh)
// ---------------------------------------------------------------------------------------------

const GhPrSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  headRefName: z.string().optional(),
  author: z.object({ login: z.string().optional() }).nullable().optional(),
  url: z.string(),
  updatedAt: z.string().nullable().optional(),
});

export const GH_PR_FIELDS = 'number,title,state,isDraft,headRefName,author,url,updatedAt';

export function parseGhPrs(stdout: string): PullRequestSummary[] {
  const parsed = z.array(GhPrSchema).safeParse(JSON.parse(stdout || '[]'));
  if (!parsed.success) return [];
  return parsed.data.map((pr) => {
    const state = pr.state.toLowerCase();
    const updated = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
    return {
      number: pr.number,
      title: pr.title,
      state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
      isDraft: pr.isDraft ?? false,
      branch: pr.headRefName ?? '',
      author: pr.author?.login ?? null,
      url: pr.url,
      updatedAt: Number.isFinite(updated) ? updated : null,
    };
  });
}

/** Why gh couldn't list PRs, in words for the activity tile. */
export function ghProblem(stderr: string): string {
  const text = stderr.toLowerCase();
  if (text.includes('auth login') || text.includes('not logged') || text.includes('authenticat')) {
    return 'gh is not signed in (run `gh auth login`)';
  }
  if (text.includes('none of the git remotes') || text.includes('no git remotes') || text.includes('not a git')) {
    return 'no GitHub remote';
  }
  return stderr.trim().split('\n')[0] || 'gh could not list pull requests';
}

export async function listPrs(project: Project, env: Readonly<Record<string, string>>): Promise<PrList> {
  const result = await runCommand(
    'gh',
    project.path,
    ['pr', 'list', '--state', 'open', '--limit', '30', '--json', GH_PR_FIELDS],
    { env, okExitCodes: ANY_EXIT, timeoutMs: 20_000 },
  ).catch(() => null);
  if (!result) return { available: false, reason: 'gh is not installed', prs: [] };
  if (result.exitCode !== 0) return { available: false, reason: ghProblem(result.stderr), prs: [] };
  try {
    return { available: true, reason: null, prs: parseGhPrs(result.stdout) };
  } catch {
    return { available: false, reason: 'gh returned something unexpected', prs: [] };
  }
}
