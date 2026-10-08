/**
 * Task gates end to end (fake engines, real git): command gates, the built-in scope and secret-scan gates,
 * structured verification rows, and blocking failures feeding the coder's next fix round.
 */
import { randomBytes } from 'node:crypto';
import type { Run, Verification } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeStep } from '../adapters/fake';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** A run with one task T1 (writes `src/t1.txt`, verify `test -f src/t1.txt`), its plan approved. */
async function startRun(harness: Harness): Promise<Run> {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: null,
    title: null,
    issueText: '# Gates\n\nRun the gates.',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
  await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  if (!plan) throw new Error('no plan');
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan.id });
  return run;
}

/** Plans T1, approves every review, and lets `coder(fixRound)` write T1's files; records the fix prompts. */
function scriptFor(coder: (fix: boolean) => FakeStep[], fixPrompts: string[], reviewerPrompts: string[]): Script {
  return (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
    if (ctx.opts.role === 'reviewer') {
      reviewerPrompts.push(ctx.message);
      return [approve(ctx)];
    }
    if (ctx.opts.role === 'finalizer') return [approve(ctx)];
    const fix = ctx.message.startsWith('Fix round');
    if (fix) fixPrompts.push(ctx.message);
    return [...coder(fix), report(`Implement ${taskIdIn(ctx.message)}`)];
  };
}

async function finished(harness: Harness, run: Run): Promise<void> {
  await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
}

/** The task-phase gate rows of the run's first verify (the first coder attempt). */
function taskRows(harness: Harness, run: Run): Verification[] {
  return harness.engine.store.listVerifications(run.id).filter((v) => v.phase === 'task');
}

const t1 = (harness: Harness, run: Run) => harness.engine.store.listTasks(run.id)[0];

describe('task gates', () => {
  it('runs every command gate and feeds a failing blocking gate into the next fix round', async () => {
    const fixPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const legion = {
      gates: {
        commands: {
          marker: `grep -q '^ok$' src/t1.txt || { echo 'checking marker'; echo 'MARKER MISSING in src/t1.txt'; exit 3; }`,
          other: 'echo other-ran',
        },
      },
    };
    h = await startHarness({
      script: scriptFor(
        (fix) => [{ kind: 'write_file', path: 'src/t1.txt', content: fix ? 'ok\n' : 'nope\n' }],
        fixPrompts,
        reviewerPrompts,
      ),
      files: { 'legion.json': JSON.stringify(legion) },
    });
    const harness = h;
    const run = await startRun(harness);
    await finished(harness, run);

    expect(t1(harness, run)?.fixRounds).toBe(1);
    // The fix brief names the failing gate and carries its output.
    expect(fixPrompts).toHaveLength(1);
    expect(fixPrompts[0]).toContain('marker');
    expect(fixPrompts[0]).toContain('MARKER MISSING in src/t1.txt');
    expect(fixPrompts[0]).not.toContain('other-ran');

    // First verify: every gate ran (no fail-fast), each recorded as a structured row.
    const rows = taskRows(harness, run);
    // Rows of one verify may share a timestamp (then they list by id): compare them by gate.
    const first = rows.slice(0, 5).sort((a, b) => (a.gate ?? '').localeCompare(b.gate ?? ''));
    expect(first.map((r) => [r.gate, r.kind, r.command, r.status, r.blocking])).toEqual([
      ['marker', 'command', legion.gates.commands.marker, 'fail', true],
      ['other', 'command', 'echo other-ran', 'pass', true],
      ['scope', 'scope', 'legion:scope', 'pass', true],
      ['secrets', 'secrets', 'legion:secrets', 'pass', true],
      ['test', 'command', 'test -f src/t1.txt', 'pass', true],
    ]);
    const marker = first[0] as Verification;
    expect(marker.exitCode).toBe(3);
    expect(marker.summary).toBe('MARKER MISSING in src/t1.txt');
    const { output } = await harness.client.call('verifications.output', { verificationId: marker.id });
    expect(output).toContain('checking marker');
    // Second verify (after the fix): all green, then review.
    expect(rows.slice(5).every((r) => r.status === 'pass')).toBe(true);
    expect(reviewerPrompts).toHaveLength(1);
    // The coder may run the resolved gate commands.
    const coder = harness.claude.sessions.find((s) => s.opts.role === 'coder');
    expect(coder?.opts.permission.allowedCommands).toEqual([
      legion.gates.commands.marker,
      'echo other-ran',
      'test -f src/t1.txt',
    ]);
  }, 60_000);

  it('passes to review when every blocking gate is green, even with a non-blocking failure', async () => {
    const fixPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    h = await startHarness({
      script: scriptFor(
        () => [{ kind: 'write_file', path: 'src/t1.txt', content: 'ok\n' }],
        fixPrompts,
        reviewerPrompts,
      ),
      files: {
        'legion.json': JSON.stringify({
          gates: { commands: { flaky: { run: 'echo flaky; exit 1', blocking: false } } },
        }),
      },
    });
    const harness = h;
    const run = await startRun(harness);
    await finished(harness, run);

    expect(t1(harness, run)?.fixRounds).toBe(0);
    expect(fixPrompts).toEqual([]);
    expect(reviewerPrompts).toHaveLength(1);
    const rows = taskRows(harness, run).sort((a, b) => (a.gate ?? '').localeCompare(b.gate ?? ''));
    expect(rows.map((r) => [r.gate, r.status, r.blocking])).toEqual([
      ['flaky', 'fail', false],
      ['scope', 'pass', true],
      ['secrets', 'pass', true],
      ['test', 'pass', true],
    ]);
  }, 60_000);

  it('blocks an out-of-scope change by default and sends it back for a fix round', async () => {
    const fixPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    h = await startHarness({
      script: scriptFor(
        (fix) => [
          { kind: 'write_file', path: 'src/t1.txt', content: 'ok\n' },
          // README.md is outside T1's touches; the fix round restores it.
          { kind: 'write_file', path: 'README.md', content: fix ? '# fixture\n' : '# fixture\n\nstray edit\n' },
        ],
        fixPrompts,
        reviewerPrompts,
      ),
    });
    const harness = h;
    const run = await startRun(harness);
    await finished(harness, run);

    expect(t1(harness, run)?.fixRounds).toBe(1);
    expect(fixPrompts).toHaveLength(1);
    expect(fixPrompts[0]).toContain('scope');
    expect(fixPrompts[0]).toContain('README.md');
    const scope = taskRows(harness, run).filter((r) => r.gate === 'scope');
    expect(scope.map((r) => [r.command, r.status, r.blocking])).toEqual([
      ['legion:scope', 'fail', true],
      ['legion:scope', 'pass', true],
    ]);
  }, 60_000);

  it("only warns about an out-of-scope change under scope: 'warn'", async () => {
    const fixPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    h = await startHarness({
      script: scriptFor(
        () => [
          { kind: 'write_file', path: 'src/t1.txt', content: 'ok\n' },
          { kind: 'write_file', path: 'README.md', content: '# fixture\n\nstray edit\n' },
        ],
        fixPrompts,
        reviewerPrompts,
      ),
      files: { 'legion.json': JSON.stringify({ gates: { scope: 'warn' } }) },
    });
    const harness = h;
    const run = await startRun(harness);
    await finished(harness, run);

    expect(t1(harness, run)?.fixRounds).toBe(0);
    expect(fixPrompts).toEqual([]);
    expect(reviewerPrompts).toHaveLength(1);
    expect(reviewerPrompts[0]).toContain('README.md');
    const scope = taskRows(harness, run).find((r) => r.gate === 'scope');
    expect(scope).toMatchObject({ status: 'fail', blocking: false });
  }, 60_000);

  it('blocks a diff that adds a secret and briefs the coder with file:line', async () => {
    // Built at runtime so no token-shaped literal lives in the source.
    const secret = `${'gh'}p_${randomBytes(18).toString('hex')}`;
    const fixPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    h = await startHarness({
      script: scriptFor(
        (fix) => [
          {
            kind: 'write_file',
            path: 'src/t1.txt',
            content: fix ? 'ok\ntoken = process.env.GITHUB_TOKEN\n' : `ok\ntoken = ${secret}\n`,
          },
        ],
        fixPrompts,
        reviewerPrompts,
      ),
    });
    const harness = h;
    const run = await startRun(harness);
    await finished(harness, run);

    expect(t1(harness, run)?.fixRounds).toBe(1);
    expect(fixPrompts).toHaveLength(1);
    expect(fixPrompts[0]).toContain('secrets');
    expect(fixPrompts[0]).toContain('src/t1.txt:2');
    expect(fixPrompts[0]).not.toContain(secret);
    const secrets = taskRows(harness, run).filter((r) => r.gate === 'secrets');
    expect(secrets.map((r) => [r.command, r.status, r.blocking])).toEqual([
      ['legion:secrets', 'fail', true],
      ['legion:secrets', 'pass', true],
    ]);
    for (const row of taskRows(harness, run)) {
      expect(JSON.stringify(row)).not.toContain(secret);
      const { output } = await harness.client.call('verifications.output', { verificationId: row.id });
      expect(output ?? '').not.toContain(secret);
    }
  }, 60_000);
});
