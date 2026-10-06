import { GitError, git, runCommand } from './exec';

export interface PushOptions {
  remote?: string;
  /** Set upstream tracking (`-u`). Default true. */
  setUpstream?: boolean;
  forceWithLease?: boolean;
}

export function buildPushArgs(branch: string, opts: PushOptions = {}): string[] {
  return [
    'push',
    ...(opts.setUpstream === false ? [] : ['-u']),
    ...(opts.forceWithLease ? ['--force-with-lease'] : []),
    opts.remote ?? 'origin',
    `refs/heads/${branch}:refs/heads/${branch}`,
  ];
}

/** Push a local branch to the remote (never prompts; fails fast on auth problems). */
export async function push(repo: string, branch: string, opts: PushOptions = {}): Promise<void> {
  await git(repo, buildPushArgs(branch, opts), { timeoutMs: 300_000 });
}

export interface DraftPrInput {
  repo: string;
  base: string;
  head: string;
  title: string;
  bodyFile: string;
  labels?: readonly string[];
}

export function buildDraftPrArgs(input: Omit<DraftPrInput, 'repo'>): string[] {
  return [
    'pr',
    'create',
    '--draft',
    '--base',
    input.base,
    '--head',
    input.head,
    '--title',
    input.title,
    '--body-file',
    input.bodyFile,
    ...(input.labels ?? []).flatMap((l) => ['--label', l]),
  ];
}

export function parsePrUrl(stdout: string): { url: string; number: number | null } {
  const url = stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^https?:\/\/\S+\/pull\/\d+/.test(l));
  if (!url) throw new Error(`gh pr create did not print a PR URL: ${stdout.trim().slice(0, 300)}`);
  const m = /\/pull\/(\d+)/.exec(url);
  return { url, number: m ? Number(m[1]) : null };
}

/** `gh pr create --draft ...`; returns the PR URL. */
export async function createDraftPr(input: DraftPrInput): Promise<{ url: string; number: number | null }> {
  const r = await runCommand('gh', input.repo, buildDraftPrArgs(input), { timeoutMs: 120_000 });
  return parsePrUrl(r.stdout);
}

export interface PrStatus {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  number: number;
  isDraft: boolean;
  mergedAt: string | null;
}

export const PR_VIEW_FIELDS = 'state,url,number,isDraft,mergedAt';

export function buildPrViewArgs(branch: string): string[] {
  return ['pr', 'view', branch, '--json', PR_VIEW_FIELDS];
}

export function parsePrStatus(stdout: string): PrStatus {
  const j = JSON.parse(stdout) as Record<string, unknown>;
  const state = j.state;
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')
    throw new Error(`unexpected PR state: ${String(state)}`);
  return {
    state,
    url: String(j.url),
    number: Number(j.number),
    isDraft: j.isDraft === true,
    mergedAt: typeof j.mergedAt === 'string' && j.mergedAt ? j.mergedAt : null,
  };
}

/** Status of the PR whose head is `branch`; null when none exists. */
export async function prStatus(repo: string, branch: string): Promise<PrStatus | null> {
  try {
    const r = await runCommand('gh', repo, buildPrViewArgs(branch), { timeoutMs: 60_000 });
    return parsePrStatus(r.stdout);
  } catch (e) {
    if (e instanceof GitError && /no pull requests? found/i.test(e.stderr)) return null;
    throw e;
  }
}
