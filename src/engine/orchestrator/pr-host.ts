/**
 * The GitHub side of §8 step 8 behind an interface, so tests (and the fake-engine demo) never touch a
 * real remote: the app uses `ghPrHost` (`git push` + `gh pr create --draft`).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftPr, push } from '../git';

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
  createDraftPr(request: DraftPrRequest): Promise<{ url: string }>;
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
      return { url: pr.url };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

/**
 * Pushes for real (to whatever `origin` is, e.g. a local bare repo in tests) but never calls GitHub;
 * records the PR requests. Used by tests and the fake-engine demo.
 */
export class FakePrHost implements PrHost {
  readonly pushes: { repoPath: string; branch: string }[] = [];
  readonly prs: DraftPrRequest[] = [];

  constructor(private readonly options: { push?: boolean } = {}) {}

  async push(repoPath: string, branch: string): Promise<void> {
    this.pushes.push({ repoPath, branch });
    if (this.options.push !== false) await push(repoPath, branch);
  }

  async createDraftPr(request: DraftPrRequest): Promise<{ url: string }> {
    this.prs.push(request);
    return { url: `https://github.invalid/legion/fake/pull/${this.prs.length}` };
  }
}
