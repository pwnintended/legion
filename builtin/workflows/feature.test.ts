/**
 * The builtin `feature` workflow end to end on a real git repository: fake agents that really edit files, the
 * real git operations, a PR host that never touches GitHub.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountPool } from '../../src/accounts/index.ts';
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

function manager(gates: GateAnswer[], prHost: FakePrHost, agentScript: FakeScript = script) {
  const engines = new Map<EngineKind, FakeEngine>();
  return createGitOps({ repo: repo.path, worktreeRoot: worktrees.path, prHost }).then((gitOps) => {
    const runs = new RunManager({
      repo: repo.path,
      accounts: new AccountPool({
        file: join(tmp('legion-pool-').path, 'pool.json'),
        accounts: (kind) => [
          { kind, name: `${kind}-1`, dir: null, token: null, env: {}, remote: false, enabled: true, source: 'config' },
        ],
      }),
      engine: (kind) => {
        let e = engines.get(kind);
        if (!e) {
          e = new FakeEngine(kind, agentScript, `${kind}-1`);
          engines.set(kind, e);
        }
        return e;
      },
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

describe('tasks workflow', () => {
  it('runs one task with one review, then resolves a base that moved on instead of failing at the merge', async () => {
    const prHost = new FakePrHost({ push: false });
    const { runs, engines } = await manager([], prHost);
    // The resolver writes the merged file; everything else follows the shared script.
    const resolving: FakeScript = (call, turn) => {
      if (call.opts.prompt.includes('moved on')) {
        writeFileSync(join(call.opts.cwd, 'T1.txt'), 'T1 and main\n');
        return { text: 'resolved' };
      }
      return script(call, turn);
    };
    for (const kind of ['claude', 'codex'] as const) {
      const e = new FakeEngine(kind, resolving, `${kind}-1`);
      engines.set(kind, e);
    }
    // Meanwhile someone commits a conflicting T1.txt on main: right before the ship gate is approved.
    runs.removeAllListeners('interaction');
    runs.on('interaction', async ({ id, interaction }) => {
      if (interaction.kind === 'gate' && interaction.key === 'ship') {
        writeFileSync(join(repo.path, 'T1.txt'), 'main\n');
        await repo.git('add', 'T1.txt');
        await repo.git('commit', '-qm', 'main moves on');
      }
      runs.answer(id, { choice: 'approve', note: null });
    });
    const runId = await runs.start('tasks', {
      title: 'One file',
      summary: 'Writes T1.txt.',
      tasks: [{ id: 'T1', title: 'task T1', goal: 'write T1.txt', verify: ['test -f T1.txt'] }],
      finish: 'merge',
      verify: ['test -f README.md'],
    });
    const record = await runs.wait(runId);
    expect(record?.error).toBeNull();
    expect(record?.status).toBe('done');
    expect(readFileSync(join(repo.path, 'T1.txt'), 'utf8')).toBe('T1 and main\n');

    // One review (no fix rounds needed, no final review for a single task), on the other engine.
    expect(engines.get('codex')?.calls).toHaveLength(1);
    // The task ran its own check, the repository-wide one ran once on the result.
    const journal = readFileSync(join(repo.path, '.legion', 'runs', runId, 'journal.jsonl'), 'utf8');
    expect(journal).toContain('"T1/review/1/verify-1"');
    expect(journal).toContain('"final/1/verify-1"');
    expect(journal).not.toContain('"T1/review/1/verify-2"');
    // The run's worktrees are gone; its branches stay.
    expect(readdirSync(worktrees.path).flatMap((d) => readdirSync(join(worktrees.path, d)))).toEqual([]);
    expect(await repo.git('branch', '--list', `legion/${runId}/*`)).toContain('integration');
  });
});

const finding = (severity: 'blocker' | 'major' | 'minor' | 'nit') => ({
  severity,
  file: 'T1.txt',
  line: 1,
  title: 'Wrong file content',
  body: 'The file contains the wrong value.',
  suggestedFix: 'Write the required value.',
});

const oneTask = {
  title: 'One file',
  summary: 'Writes T1.txt.',
  tasks: [{ id: 'T1', title: 'task T1', goal: 'write T1.txt', verify: ['test -f T1.txt'] }],
};

describe.each(['implement', 'tasks'] as const)('%s review convergence', (workflow) => {
  const input = () => ({
    ...(workflow === 'tasks' ? oneTask : { task: 'write T1.txt', verify: ['test -f T1.txt'] }),
    finish: 'pr',
    maxFixRounds: 3,
  });

  it.each([{ findings: [] }, { findings: [finding('minor')] }, { findings: [finding('nit')] }])(
    'does not send a nonblocking request_changes verdict back to the coder: %j',
    async ({ findings }) => {
      const prHost = new FakePrHost({ push: false });
      const { runs, engines } = await manager([], prHost, (call) => {
        if (props(call).includes('verdict')) {
          return { output: { verdict: 'request_changes', findings, summary: 'Suggestions only' } };
        }
        writeFileSync(join(call.opts.cwd, 'T1.txt'), 'T1\n');
        return { output: { summary: 'wrote T1.txt', commitMessage: 'Add T1.txt' } };
      });
      const record = await runs.wait(await runs.start(workflow, input()));
      expect(record?.status).toBe('done');
      expect(engines.get('claude')?.calls).toHaveLength(1);
      expect(engines.get('codex')?.calls).toHaveLength(1);
      expect(prHost.prs).toHaveLength(1);
      if (findings.some((f) => f.severity === 'minor')) expect(prHost.prs[0]?.body).toContain('Wrong file content');
    },
  );

  it.each(['blocker', 'major'] as const)(
    'fixes a %s even with approve, then stops after a focused re-review',
    async (severity) => {
      let reviews = 0;
      let writes = 0;
      const { runs, engines } = await manager([], new FakePrHost({ push: false }), (call) => {
        if (props(call).includes('verdict')) {
          reviews++;
          return {
            output: {
              verdict: 'approve',
              findings: reviews === 1 ? [finding(severity), { ...finding('minor'), title: 'Optional cleanup' }] : [],
              summary: 'Review',
            },
          };
        }
        writes++;
        writeFileSync(join(call.opts.cwd, 'T1.txt'), writes === 1 ? 'wrong\n' : 'fixed\n');
        return {
          output: {
            summary: writes === 1 ? 'Initial implementation' : 'Corrected the value; checked the regression',
            commitMessage: 'Add T1.txt',
          },
        };
      });
      const record = await runs.wait(await runs.start(workflow, input()));
      expect(record?.error).toBeNull();
      expect(record?.status).toBe('done');
      expect(writes).toBe(2);
      expect(reviews).toBe(2);
      const reviewCalls = engines.get('codex')?.calls ?? [];
      expect(reviewCalls[1]?.resumed).toBe(true);
      expect(reviewCalls[1]?.sessionId).toBe(reviewCalls[0]?.sessionId);
      expect(reviewCalls[1]?.opts.prompt).toContain('Corrected the value');
      expect(reviewCalls[1]?.opts.prompt).toContain('follow-up review');
      const fix = engines.get('claude')?.calls[1];
      expect(fix?.resumed).toBe(true);
      expect(fix?.opts.prompt).toContain('Wrong file content');
      expect(fix?.opts.prompt).not.toContain('Optional cleanup');
    },
  );

  it('fixes a failing configured check even when review has no findings', async () => {
    let writes = 0;
    const { runs, engines } = await manager([], new FakePrHost({ push: false }), (call) => {
      if (props(call).includes('verdict')) return { output: { verdict: 'approve', findings: [], summary: 'fine' } };
      writes++;
      writeFileSync(join(call.opts.cwd, 'T1.txt'), writes === 1 ? 'wrong\n' : 'fixed\n');
      return { output: { summary: 'Wrote file', commitMessage: 'Add T1.txt' } };
    });
    const verify = ['grep -q fixed T1.txt'];
    const record = await runs.wait(
      await runs.start(workflow, {
        ...input(),
        ...(workflow === 'tasks' ? { tasks: [{ ...oneTask.tasks[0], verify }] } : { verify }),
      }),
    );
    expect(record?.status).toBe('done');
    expect(writes).toBe(2);
    expect(engines.get('claude')?.calls[1]?.opts.prompt).toContain('Failing checks');
  });

  it('retains the fix-round cap and escalates unresolved blockers', async () => {
    let unresolved = 0;
    const { runs, engines } = await manager([], new FakePrHost({ push: false }), (call) => {
      if (props(call).includes('verdict'))
        return { output: { verdict: 'request_changes', findings: [finding('blocker')], summary: 'Still broken' } };
      writeFileSync(join(call.opts.cwd, 'T1.txt'), 'wrong\n');
      return { output: { summary: 'Attempted fix', commitMessage: 'Add T1.txt' } };
    });
    runs.removeAllListeners('interaction');
    runs.on('interaction', ({ id, interaction }) => {
      if (interaction.kind === 'ask') {
        unresolved++;
        runs.answer(id, { answer: 'abort the run' });
      } else if (interaction.kind === 'gate') runs.answer(id, { choice: 'approve', note: null });
      else runs.answer(id, { behavior: 'allow', scope: 'once', updatedInput: null });
    });
    const record = await runs.wait(await runs.start(workflow, { ...input(), maxFixRounds: 1 }));
    expect(record?.status).toBe('cancelled');
    expect(unresolved).toBe(1);
    expect(engines.get('claude')?.calls).toHaveLength(2);
    expect(engines.get('codex')?.calls).toHaveLength(2);
  });
});

describe('feature task budget', () => {
  it.each([undefined, 1, 4])('enforces the task ceiling %s before asking for plan approval', async (maxTasks) => {
    let drafts = 0;
    let approvals = 0;
    const ceiling = maxTasks ?? 3;
    const { runs, engines } = await manager([], new FakePrHost({ push: false }), async (call, turn) => {
      if (props(call).includes('tasks')) {
        drafts++;
        const tasks = Array.from({ length: drafts === 1 ? ceiling + 1 : 1 }, (_, i) => ({
          id: `T${i + 1}`,
          title: 'One file',
          goal: 'write file',
          dependsOn: [],
          acceptanceCriteria: [],
          touches: [`T${i + 1}.txt`],
          verify: [],
          notes: '',
        }));
        return { output: { markdown: '# Write a file', tasks } };
      }
      return script(call, turn);
    });
    runs.on('interaction', ({ interaction }) => {
      if (interaction.kind === 'gate' && interaction.key.endsWith('/approve')) approvals++;
    });
    const record = await runs.wait(
      await runs.start('feature', {
        task: 'write a file',
        clarify: false,
        finish: 'branch',
        ...(maxTasks === undefined ? {} : { maxTasks }),
      }),
    );
    expect(record?.error).toBeNull();
    expect(record?.status).toBe('done');
    expect(drafts).toBe(2);
    expect(approvals).toBe(1);
    const draftCalls = engines.get('claude')?.calls.filter((c) => props(c).includes('tasks')) ?? [];
    expect(draftCalls[0]?.opts.prompt).toContain(`at most ${ceiling} tasks`);
    expect(draftCalls[1]?.opts.prompt).toContain(`consolidate into at most ${ceiling}`);
    expect(engines.get('codex')?.calls).toHaveLength(1);
  });
});

describe('final integration review', () => {
  it('fixes only blockers and resumes the final reviewer with the previous findings', async () => {
    let finalReviews = 0;
    const { runs, engines } = await manager([], new FakePrHost({ push: false }), (call, turn) => {
      if (call.opts.prompt.startsWith('Review the combined change')) {
        finalReviews++;
        return {
          output: {
            verdict: 'request_changes',
            findings:
              finalReviews === 1
                ? [finding('blocker'), { ...finding('major'), title: 'Nonblocking final suggestion' }]
                : [],
            summary: 'Integration review',
          },
        };
      }
      if (call.opts.prompt.startsWith('A reviewer looked at your work')) {
        writeFileSync(join(call.opts.cwd, 'T1.txt'), 'fixed\n');
        return { text: 'Fixed integration' };
      }
      return script(call, turn);
    });
    const record = await runs.wait(
      await runs.start('feature', { task: 'add files', clarify: false, finish: 'branch' }),
    );
    expect(record?.error).toBeNull();
    expect(record?.status).toBe('done');
    expect(finalReviews).toBe(2);
    const reviews =
      engines.get('codex')?.calls.filter((c) => c.opts.prompt.startsWith('Review the combined change')) ?? [];
    expect(reviews[1]?.resumed).toBe(true);
    expect(reviews[1]?.sessionId).toBe(reviews[0]?.sessionId);
    expect(reviews[1]?.opts.prompt).toContain('Wrong file content');
    const fix = engines.get('claude')?.calls.find((c) => c.opts.prompt.startsWith('A reviewer looked at your work'));
    expect(fix?.opts.prompt).toContain('Wrong file content');
    expect(fix?.opts.prompt).not.toContain('Nonblocking final suggestion');
  });
});
