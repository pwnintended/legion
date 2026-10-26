import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, gitText } from './exec.ts';
import { FakePrHost, prNumberOf } from './pr-host.ts';
import { type FixtureRepo, makeBare, makeRepo } from './test-helpers.ts';

let repo: FixtureRepo;
beforeEach(async () => {
  repo = await makeRepo();
});
afterEach(() => repo.cleanup());

describe('FakePrHost', () => {
  it('pushes for real to a local origin and records draft PRs whose state tests can change', async () => {
    const bare = await makeBare(repo.scratch);
    await git(repo.path, ['remote', 'add', 'origin', bare]);
    const host = new FakePrHost();
    await host.push(repo.path, 'main');
    expect(await gitText(bare, ['rev-parse', 'refs/heads/main'])).toBe(await repo.head());
    expect(host.pushes).toEqual([{ repoPath: repo.path, branch: 'main' }]);

    expect(await host.prStatus(repo.path, 'feature')).toBeNull();
    const pr = await host.createDraftPr({ repoPath: repo.path, base: 'main', head: 'feature', title: 't', body: 'b' });
    expect(pr).toEqual({ url: 'https://github.invalid/legion/fake/pull/1', number: 1, state: 'open', isDraft: true });
    host.setState('feature', { state: 'merged', isDraft: false });
    expect(await host.prStatus(repo.path, 'feature')).toMatchObject({ state: 'merged', isDraft: false });
    expect(prNumberOf(pr.url)).toBe(1);
    expect(prNumberOf('https://example.com')).toBe(0);
  });

  it('records pushes without effects when push is false', async () => {
    const host = new FakePrHost({ push: false });
    await host.push(repo.path, 'main'); // no origin: would fail for real
    expect(host.pushesForReal).toBe(false);
    expect(host.pushes).toHaveLength(1);
  });
});
