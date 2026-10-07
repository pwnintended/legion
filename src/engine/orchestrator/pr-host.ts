/**
 * The GitHub side of §8 step 8 behind an interface, so tests (and the fake-engine demo) never touch a
 * real remote: the app uses `ghPrHost` (`git push` + `gh pr create --draft` / `gh pr view`).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrState, PullRequest } from '@shared/domain';
import { createDraftPr, prStatus, push } from '../git';

export interface DraftPrRequest {
  repoPath: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface PrHost {
  /** Push the local branch to `origin` (setting upstream). */
  push(repoPath: string, branch: string): Promise<void>;
  createDraftPr(request: DraftPrRequest): Promise<PullRequest>;
  /** The PR whose head is `branch`, or null when there is none. */
  prStatus(repoPath: string, branch: string): Promise<PullRequest | null>;
}

/** PR number from a GitHub PR URL (0 when it cannot be parsed). */
export function prNumberOf(url: string): number {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? Number(match[1]) : 0;
}

export const ghPrHost: PrHost = {
  push: (repoPath, branch) => push(repoPath, branch),
  async createDraftPr(request) {
    const dir = await mkdtemp(join(tmpdir(), 'legion-pr-'));
    try {
      const bodyFile = join(dir, 'body.md');
      await writeFile(bodyFile, request.body);
      const pr = await createDraftPr({
        repo: request.repoPath,
        base: request.base,
        head: request.head,
        title: request.title,
        bodyFile,
      });
      return { url: pr.url, number: pr.number ?? prNumberOf(pr.url), state: 'open', isDraft: true };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  async prStatus(repoPath, branch) {
    const status = await prStatus(repoPath, branch);
    if (!status) return null;
    const state: PrState = status.state === 'MERGED' ? 'merged' : status.state === 'CLOSED' ? 'closed' : 'open';
    return { url: status.url, number: status.number, state, isDraft: status.isDraft };
  },
};

/**
 * Never calls GitHub: records the PR requests and answers with `https://github.invalid/...` PRs whose
 * state tests can change (`setState`). Pushes for real to whatever `origin` is (e.g. a local bare repo in
 * tests) unless constructed with `{ push: false }` (fake-engine mode: no external effects at all).
 */
export class FakePrHost implements PrHost {
  readonly pushes: { repoPath: string; branch: string }[] = [];
  readonly prs: DraftPrRequest[] = [];
  /** Branch → PR. */
  private readonly byBranch = new Map<string, PullRequest>();

  constructor(private readonly options: { push?: boolean } = {}) {}

  get pushesForReal(): boolean {
    return this.options.push !== false;
  }

  async push(repoPath: string, branch: string): Promise<void> {
    this.pushes.push({ repoPath, branch });
    if (this.pushesForReal) await push(repoPath, branch);
  }

  async createDraftPr(request: DraftPrRequest): Promise<PullRequest> {
    this.prs.push(request);
    const number = this.prs.length;
    const pr: PullRequest = {
      url: `https://github.invalid/legion/fake/pull/${number}`,
      number,
      state: 'open',
      isDraft: true,
    };
    this.byBranch.set(request.head, pr);
    return pr;
  }

  async prStatus(_repoPath: string, branch: string): Promise<PullRequest | null> {
    return this.byBranch.get(branch) ?? null;
  }

  /** Simulate a change on the host (merge, close, ready for review). */
  setState(branch: string, patch: Partial<Pick<PullRequest, 'state' | 'isDraft'>>): void {
    const pr = this.byBranch.get(branch);
    if (pr) this.byBranch.set(branch, { ...pr, ...patch });
  }
}
