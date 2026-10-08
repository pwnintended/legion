/**
 * Final review blockers go back to a coder: a final fix round in the integration worktree, committed onto the
 * integration branch, verified and reviewed again. Out of rounds → `final_review` escalation, whose retry is
 * another fix round (fresh budget, the human's note, same session).
 */
import type { InboxItem, Run } from '@shared/domain';
import type { ReviewOutput } from '@shared/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeStep } from '../adapters/fake';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);
const escalation = (harness: Harness, runId: string) =>
  harness.engine.store
    .listInbox({ runId, includeResolved: false })
    .find((i): i is Extract<InboxItem, { kind: 'escalation' }> => i.kind === 'escalation');
const finalFixers = (harness: Harness) =>
  harness.claude.sessions.filter((s) => s.opts.role === 'coder' && s.opts.prompt.startsWith('Final fix round'));
const finalizers = (harness: Harness) =>
  [...harness.claude.sessions, ...harness.codex.sessions].filter((s) => s.opts.role === 'finalizer');

function blocker(title: string): FakeStep {
  const value: ReviewOutput = {
    verdict: 'request_changes',
    criteria: [{ id: 'R1', status: 'unmet', evidence: 'The exporter is never registered.' }],
    findings: [
      { severity: 'blocker', file: 'src/t1.txt', line: 1, title, body: 'Not wired.', suggestedFix: 'Wire it.' },
      { severity: 'minor', file: null, line: null, title: 'Wording', body: 'Meh.', suggestedFix: null },
    ],
    summary: 'Not wired up.',
  };
  return { kind: 'output', value };
}

/** One task; the finalizer behaves as `finalReview()` says; the final fixer writes `src/wired.txt`. */
function script(finalReview: (ctx: Parameters<Script>[0]) => FakeStep[]): Script {
  return (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
    if (ctx.opts.role === 'reviewer') return [approve(ctx)];
    if (ctx.opts.role === 'finalizer') return finalReview(ctx);
    if (ctx.message.startsWith('Final fix round')) {
      return [{ kind: 'write_file', path: 'src/wired.txt', content: 'wired\n' }, report('Wire the exporter')];
    }
    const id = taskIdIn(ctx.message);
    return [{ kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` }, report(`Implement ${id}`)];
  };
}

async function startRun(harness: Harness): Promise<Run> {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Final fix',
    issueText: 'Add the exporter.',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
  await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  return run;
}

describe('final review → final fix round', () => {
  it('sends blockers to a coder on the integration branch, then verifies and reviews again', async () => {
    h = await startHarness({
      script: script((ctx) =>
        ctx.message.includes('Re-review after final fix round 1') ? [approve(ctx)] : [blocker('Exporter not wired')],
      ),
    });
    const harness = h;
    const run = await startRun(harness);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);

    const [fixer] = finalFixers(harness);
    expect(finalFixers(harness)).toHaveLength(1);
    expect(fixer?.opts.cwd).toBe(finalizers(harness)[0]?.opts.cwd); // the integration worktree
    expect(fixer?.opts.prompt).toContain('Exporter not wired');
    expect(fixer?.opts.prompt).toContain('The exporter is never registered.');
    expect(fixer?.opts.prompt).not.toContain('Wording'); // minor findings are not sent back

    // The fix is a commit on the integration branch, and verification ran again before the second review.
    const branch = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('log', '-1', '--format=%s', branch)).toBe('Wire the exporter');
    expect(await harness.repo.git('show', `${branch}:src/wired.txt`)).toBe('wired');
    const finals = harness.engine.store.listVerifications(run.id).filter((v) => v.phase === 'final');
    expect(finals).toHaveLength(2);

    const reviews = harness.engine.store.listReviews(run.id).filter((r) => r.taskId === null);
    expect(reviews.map((r) => r.verdict)).toEqual(['request_changes', 'approve']);
    expect(finalizers(harness)[1]?.opts.prompt).toContain('Exporter not wired');
    expect(escalation(harness, run.id)).toBeUndefined();
    const fixerAttempt = harness.engine.store.listAttempts(run.id).find((a) => a.role === 'coder' && a.taskId === null);
    expect(fixerAttempt?.status).toBe('succeeded');
  });

  it('escalates when the fix rounds run out; retry is another round with the note, in the same session', async () => {
    let approveNow = false;
    h = await startHarness({
      settings: { limits: { maxFixRounds: 1 } },
      script: script((ctx) => (approveNow ? [approve(ctx)] : [blocker('Still not wired')])),
    });
    const harness = h;
    const run = await startRun(harness);
    const item = await harness.waitFor(() => escalation(harness, run.id), 'final_review escalation', 30_000);
    expect(item.payload).toMatchObject({ reason: 'final_review', actions: ['retry', 'skip', 'abort'], resume: 'fix' });
    expect(item.payload.summary).toContain('after 1 fix round(s)');
    expect(finalFixers(harness)).toHaveLength(1);
    expect(runOf(harness, run.id).status).toBe('finalizing');

    approveNow = true;
    await harness.client.call('inbox.resolve', {
      itemId: item.id,
      resolution: { kind: 'escalation', action: 'retry', note: 'Register it in the menu' },
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const fixers = finalFixers(harness);
    expect(fixers).toHaveLength(2);
    expect(fixers[1]?.resumed).toBe(true);
    expect(fixers[1]?.id).toBe(fixers[0]?.id);
    expect(fixers[1]?.opts.prompt).toContain('Register it in the menu');
    expect(fixers[1]?.opts.prompt).toContain('Final fix round 1 of 1');
  });

  it('with no fix rounds allowed, blockers escalate straight away', async () => {
    h = await startHarness({
      settings: { limits: { maxFixRounds: 0 } },
      script: script(() => [blocker('Exporter not wired')]),
    });
    const harness = h;
    const run = await startRun(harness);
    const item = await harness.waitFor(() => escalation(harness, run.id), 'final_review escalation', 30_000);
    expect(item.payload.reason).toBe('final_review');
    expect(item.payload.summary).not.toContain('fix round(s)');
    expect(finalFixers(harness)).toHaveLength(0);

    await harness.client.call('inbox.resolve', {
      itemId: item.id,
      resolution: { kind: 'escalation', action: 'skip', note: null },
    });
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    expect(finalFixers(harness)).toHaveLength(0);
  });
});
