/**
 * The builtin `feature` workflow end to end on a real git repository: fake agents that really edit files, the
 * real git operations, a PR host that never touches GitHub.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, type FakeScript } from '../../src/engine/fake/index.ts';
import type { EngineKind } from '../../src/engine/types.ts';
import { FakePrHost } from '../../src/git/index.ts';
import { type FixtureRepo, makeRepo, tmp } from '../../src/git/test-helpers.ts';
import { createGitOps } from '../../src/workflow/git-ops.ts';
import type { GateAnswer } from '../../src/workflow/host.ts';
import { RunManager } from '../../src/workflow/manager.ts';

let repo: FixtureRepo;
let worktrees: { path: string; cleanup: () => void };

beforeEach(async () => {
  repo = await makeRepo({ 'README.md': '# app\n' });
  worktrees = tmp('legion-wt-');
});

afterEach(() => {
  repo.cleanup();
  worktrees.cleanup();
});

const props = (call: Parameters<FakeScript>[0]) =>
  Object.keys(((call.opts.outputSchema as { properties?: object } | null)?.properties ?? {}) as object);

/** Planner → two independent tasks and one that depends on both; coders write `<id>.txt`; reviewers approve. */
const script: FakeScript = (call) => {
  const keys = props(call);
  if (keys.includes('questions'))
    return { output: { questions: [{ id: 'q1', question: 'Which color?', options: ['red', 'blue'] }] } };
  if (keys.includes('tasks')) {
    const task = (id: string, dependsOn: string[]) => ({
      id,
      title: `task ${id}`,
      goal: `write ${id}.txt`,
      dependsOn,
      acceptanceCriteria: [`${id}.txt exists`],
      touches: [`${id}.txt`],
      verify: [`test -f ${id}.txt`],
      notes: '',
    });
    return {
      output: {
        markdown: '# Add the files\n\n## Summary\nWrites files.',
        tasks: [task('T1', []), task('T2', []), task('T3', ['T1', 'T2'])],
      },
    };
  }
  if (keys.includes('commitMessage')) {
    const id = /Your task: (T\d)/.exec(call.opts.prompt)?.[1] ?? 'X';
    writeFileSync(join(call.opts.cwd, `${id}.txt`), `${id}\n`);
    return { output: { summary: `wrote ${id}.txt`, commitMessage: `Add ${id}.txt` } };
  }
  if (keys.includes('verdict')) return { output: { verdict: 'approve', findings: [], summary: 'fine' } };
  return { text: 'ok' };
};

function manager(gates: GateAnswer[], prHost: FakePrHost) {
  const engines = new Map<EngineKind, FakeEngine>();
  return createGitOps({ repo: repo.path, worktreeRoot: worktrees.path, prHost }).then((gitOps) => {
    const runs = new RunManager({
      repo: repo.path,
      engine: (kind) => {
        let e = engines.get(kind);
        if (!e) {
          e = new FakeEngine(kind, script, `${kind}-1`);
          engines.set(kind, e);
        }
        return e;
      },
      profiles: () => ({ claude: 'claude-1', codex: 'codex-1' }),
      git: gitOps,
    });
    runs.on('interaction', ({ id, interaction }) => {
      if (interaction.kind === 'gate') runs.answer(id, gates.shift() ?? { choice: 'approve', note: null });
      else if (interaction.kind === 'ask') runs.answer(id, { answer: 'red' });
      else runs.answer(id, { behavior: 'allow', scope: 'once', updatedInput: null });
    });
    return { runs, engines };
  });
}

describe('feature workflow', () => {
  it('plans, implements tasks in worktrees, merges them and opens a draft PR', async () => {
    const prHost = new FakePrHost({ push: false });
    const { runs, engines } = await manager([{ choice: 'changes', note: 'more tests' }], prHost);
    const runId = await runs.start('feature', { task: 'add three files' });
    const record = await runs.wait(runId);

    expect(record?.error).toBeNull();
    expect(record?.status).toBe('done');
    expect(record?.result).toMatchObject({ pr: 'https://github.invalid/legion/fake/pull/1' });

    // The human asked for plan changes once: a second draft resumed the first draft's session.
    const claude = engines.get('claude');
    const drafts = claude?.calls.filter((c) => props(c).includes('tasks')) ?? [];
    expect(drafts).toHaveLength(2);
    expect(drafts[1]?.resumed).toBe(true);
    expect(drafts[1]?.prompts[0]).toContain('more tests');

    // Reviews ran on the other engine, read-only.
    const reviews = engines.get('codex')?.calls ?? [];
    expect(reviews.length).toBe(4); // three tasks + final
    expect(reviews.every((c) => c.opts.permission.mode === 'read_only' && c.opts.untrustedWorkdir)).toBe(true);

    // The integration branch has all three files; the PR targets main.
    const files = await repo.git('ls-tree', '--name-only', '-r', prHost.prs[0]?.head ?? '');
    expect(files.split('\n').sort()).toEqual(['README.md', 'T1.txt', 'T2.txt', 'T3.txt']);
    expect(prHost.prs[0]).toMatchObject({ base: 'main' });
    expect(prHost.prs[0]?.head).toContain('integration');

    // Task worktrees were removed; the user's checkout is untouched.
    expect(existsSync(join(repo.path, 'T1.txt'))).toBe(false);
    expect(readFileSync(join(repo.path, 'README.md'), 'utf8')).toBe('# app\n');
  });

  it('resumes a cancelled run without redoing finished steps', async () => {
    const prHost = new FakePrHost({ push: false });
    const first = await manager([], prHost);
    // Cancel at the ship gate.
    first.runs.removeAllListeners('interaction');
    first.runs.on('interaction', ({ id, interaction }) => {
      if (interaction.kind === 'gate' && interaction.key === 'ship') first.runs.cancel(interaction.runId);
      else if (interaction.kind === 'gate') first.runs.answer(id, { choice: 'approve', note: null });
      else if (interaction.kind === 'ask') first.runs.answer(id, { answer: 'red' });
    });
    const runId = await first.runs.start('feature', { task: 'add three files' });
    expect((await first.runs.wait(runId))?.status).toBe('cancelled');
    const agentCalls = [...first.engines.values()].reduce((n, e) => n + e.calls.length, 0);
    expect(agentCalls).toBeGreaterThan(0);

    const second = await manager([], prHost);
    await second.runs.resume(runId);
    const record = await second.runs.wait(runId);
    expect(record?.status).toBe('done');
    // Every agent step came from the journal.
    expect([...second.engines.values()].reduce((n, e) => n + e.calls.length, 0)).toBe(0);
    expect(prHost.prs).toHaveLength(1);
  });
});
