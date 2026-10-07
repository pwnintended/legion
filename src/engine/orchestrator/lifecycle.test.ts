/**
 * End-to-end lifecycle on a real temp git repo with scripted fake engines (Claude and Codex stand-ins):
 * create → clarify → plan → approve → coders → verify → cross-engine review → merge queue → finalize →
 * PR. Also: conflicts resolved by the resolver, and an engine restart mid-run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxItem, Run, Task } from '@shared/domain';
import type { ServerEventOf } from '@shared/events';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeStep } from '../adapters/fake';
import { gitText } from '../git';
import {
  approve,
  type Harness,
  node,
  plannerKind,
  planOutput,
  report,
  requestChangesOutput,
  type Script,
  startHarness,
  taskIdIn,
} from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const tasksOf = (harness: Harness, runId: string): Task[] => harness.engine.store.listTasks(runId);
const openInbox = (harness: Harness, runId: string): InboxItem[] =>
  harness.engine.store.listInbox({ runId, includeResolved: false });
const runOf = (harness: Harness, runId: string): Run => harness.engine.store.requireRun(runId);

async function createRun(harness: Harness, skipClarify = false): Promise<Run> {
  return harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: null,
    title: null,
    issueText: '# Add the registry feature\n\nPlease add it.',
    issueUrl: 'https://github.com/acme/widgets/issues/42',
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify,
  });
}

async function approveLatestPlan(harness: Harness, runId: string): Promise<void> {
  await harness.waitFor(() => runOf(harness, runId).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(runId);
  if (!plan) throw new Error('no plan');
  await harness.client.call('runs.approvePlan', { runId, planId: plan.id });
}

describe('run lifecycle (fake engines, real git)', () => {
  it('takes an issue to a draft PR: clarify, plan, overlap serialization, fix rounds, retry, approval', async () => {
    const reviewedBy: Record<string, string[]> = {};
    const script: Script = (ctx, engine) => {
      const role = ctx.opts.role;
      const cwd = ctx.opts.cwd;
      if (role === 'planner') {
        if (plannerKind(ctx) === 'clarify') {
          return [
            { kind: 'usage', inputTokens: 1000, outputTokens: 100, costUsd: 0.01 },
            {
              kind: 'output',
              value: { questions: [{ id: 'q1', question: 'Include docs?', options: ['yes', 'no'] }] },
            },
          ];
        }
        return [
          { kind: 'usage', inputTokens: 3000, outputTokens: 400, costUsd: 0.05 },
          planOutput([
            node('T1', {
              title: 'Core',
              writes: ['src/core.txt'],
              verify: { commands: ['grep -q "^core$" src/core.txt'] },
            }),
            node('T2', {
              title: 'Feature',
              dependsOn: ['T1'],
              writes: ['src/feature.txt', 'shared/registry.txt'],
              verify: { commands: ['grep -q feature shared/registry.txt', 'test -f src/feature.txt'] },
            }),
            node('T3', {
              title: 'Extra registry entry',
              writes: ['shared/registry.txt'],
              verify: { commands: ['grep -q extra shared/registry.txt'] },
            }),
            node('T4', {
              title: 'Docs',
              kind: 'docs',
              writes: ['docs/**'],
              verify: { commands: ['test -f docs/notes.md'] },
            }),
          ]),
        ];
      }
      const id = taskIdIn(ctx.message);
      if (role === 'reviewer') {
        reviewedBy[id] = [...(reviewedBy[id] ?? []), engine];
        const firstReview = !ctx.message.includes('Re-review after fix round');
        if (id === 'T3' && firstReview) return [requestChangesOutput('Registry entry lacks a marker')];
        return [{ kind: 'usage', inputTokens: 500, outputTokens: 50, costUsd: 0.02 }, approve(ctx)];
      }
      if (role === 'finalizer') {
        return [
          approve(ctx, {
            findings: [
              {
                severity: 'minor',
                file: 'docs/notes.md',
                line: 1,
                title: 'Terse docs',
                body: 'Expand.',
                suggestedFix: null,
              },
            ],
            summary: 'The change hangs together.',
          }),
        ];
      }
      // coder (fresh attempt or fix round)
      const fix = ctx.message.startsWith('Fix round');
      const registry = () => readFileSync(join(cwd, 'shared/registry.txt'), 'utf8');
      const steps: FakeStep[] = [{ kind: 'usage', inputTokens: 2000, outputTokens: 300, costUsd: 0.1 }];
      switch (id) {
        case 'T1':
          // First turn writes a wrong value, so verification fails and a fix round corrects it.
          steps.push({ kind: 'write_file', path: 'src/core.txt', content: fix ? 'core\n' : 'cor\n' });
          break;
        case 'T2':
          steps.push(
            { kind: 'write_file', path: 'src/feature.txt', content: 'feature\n' },
            { kind: 'write_file', path: 'shared/registry.txt', content: `${registry()}feature\n` },
          );
          break;
        case 'T3':
          steps.push({
            kind: 'write_file',
            path: 'shared/registry.txt',
            content: fix ? `${registry().replace('extra\n', '')}extra (marked)\n` : `${registry()}extra\n`,
          });
          break;
        case 'T4':
          if (!ctx.message.includes('This is attempt 2')) {
            return [{ kind: 'fail', message: 'fake crash', retryable: true }];
          }
          steps.push(
            { kind: 'write_file', path: 'docs/notes.md', content: '# Notes\n' },
            {
              kind: 'approval',
              tool: 'Bash',
              input: { command: 'touch docs/approved.md' },
              reason: 'create a marker',
              onAllow: [{ kind: 'write_file', path: 'docs/approved.md', content: 'approved\n' }],
            },
          );
          break;
      }
      steps.push(report(`Implement ${id}`));
      return steps;
    };

    h = await startHarness({ script, files: { 'shared/registry.txt': 'registry:\n' } });
    const harness = h;
    const run = await createRun(harness);
    expect(run).toMatchObject({ status: 'clarifying', baseRef: 'main', title: 'Add the registry feature' });

    // Clarify → one question in the inbox, answered through the RPC.
    const question = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'question'),
      'clarify question',
    );
    expect(question.kind === 'question' && question.payload.source).toBe('clarify');
    await harness.client.call('runs.answerClarify', { runId: run.id, answers: [{ questionId: 'q1', answer: 'yes' }] });

    // Plan v1: validated, the T2/T3 write overlap got a serializing edge.
    await harness.waitFor(() => runOf(harness, run.id).status === 'awaiting_approval', 'plan');
    const plan = harness.engine.store.latestPlan(run.id);
    expect(plan?.version).toBe(1);
    expect(plan?.dag.nodes.find((n) => n.id === 'T2')?.dependsOn).toEqual(['T1', 'T3']);
    expect(plan?.dag.annotations).toContainEqual(
      expect.objectContaining({ kind: 'serializing_edge', nodeIds: ['T3', 'T2'] }),
    );
    expect(plan?.dag.annotations.some((a) => a.kind === 'cost_estimate')).toBe(true);
    expect(openInbox(harness, run.id).map((i) => i.kind)).toEqual(['plan_signoff']);
    // The planner session was resumed for the plan step.
    const plannerSessions = harness.claude.sessions.filter((s) => s.opts.role === 'planner');
    expect(plannerSessions.map((s) => s.resumed)).toEqual([false, true]);
    expect(plannerSessions[1]?.id).toBe(plannerSessions[0]?.id);
    expect(plannerSessions[1]?.opts.prompt).toContain('Include docs?');

    await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });

    // T4's second attempt asks for approval; resolve it through the inbox.
    const approval = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'approval'),
      'approval request',
    );
    await harness.client.call('inbox.resolve', {
      itemId: approval.id,
      resolution: { kind: 'approval', decision: { behavior: 'allow', scope: 'once', updatedInput: null } },
    });

    const prItem = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'pr_ready'),
      'pr_ready',
      30_000,
    );
    expect(runOf(harness, run.id).status).toBe('pr_ready');
    const tasks = new Map(tasksOf(harness, run.id).map((t) => [t.nodeId, t]));
    expect([...tasks.values()].every((t) => t.status === 'merged')).toBe(true);
    expect(tasks.get('T1')).toMatchObject({ fixRounds: 1, attemptCount: 1 });
    expect(tasks.get('T3')).toMatchObject({ fixRounds: 1, attemptCount: 1 });
    expect(tasks.get('T4')).toMatchObject({ fixRounds: 0, attemptCount: 2 });

    // Every coder ran on the coder role's engine (Claude); Codex reviewed them all.
    expect(reviewedBy).toEqual({ T1: ['codex'], T2: ['codex'], T3: ['codex', 'codex'], T4: ['codex'] });
    const snapshot = await harness.client.call('runs.get', { runId: run.id });
    const t3Reviews = snapshot.reviews.filter((r) => r.taskId === tasks.get('T3')?.id);
    expect(t3Reviews.map((r) => r.verdict)).toEqual(['request_changes', 'approve']);
    expect(snapshot.reviews.filter((r) => r.taskId === null)).toHaveLength(1);
    expect(snapshot.verifications.some((v) => v.phase === 'task' && v.exitCode !== 0)).toBe(true);
    expect(snapshot.verifications.filter((v) => v.phase === 'post_merge').every((v) => v.exitCode === 0)).toBe(true);
    expect(snapshot.verifications.some((v) => v.phase === 'final')).toBe(true);
    expect(snapshot.merges.map((m) => m.status)).toEqual(['merged', 'merged', 'merged', 'merged']);

    // The fix round resumed the coder's session; the reviewers were fresh sessions.
    const t3Coder = harness.claude.sessions.filter((s) => s.opts.role === 'coder' && taskIdIn(s.opts.prompt) === 'T3');
    expect(t3Coder.map((s) => s.resumed)).toEqual([false, true]);
    expect(t3Coder[1]?.opts.prompt).toContain('Registry entry lacks a marker');

    // Integration branch content and history.
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(integration).toMatch(/^legion\/[0-9a-z]{8}\/integration$/);
    const show = (path: string) => harness.repo.git('show', `${integration}:${path}`);
    expect(await show('src/core.txt')).toBe('core');
    expect(await show('src/feature.txt')).toBe('feature');
    expect(await show('shared/registry.txt')).toBe('registry:\nextra (marked)\nfeature');
    expect(await show('docs/approved.md')).toBe('approved');
    const log = (await harness.repo.git('log', '--format=%s', `main..${integration}`)).split('\n');
    expect(new Set(log)).toEqual(new Set(['T1: Core', 'T2: Feature', 'T3: Extra registry entry', 'T4: Docs']));
    // Newest first: T2 was merged after both of its dependencies.
    expect(log.indexOf('T2: Feature')).toBeLessThan(log.indexOf('T1: Core'));
    expect(log.indexOf('T2: Feature')).toBeLessThan(log.indexOf('T3: Extra registry entry'));
    // The user's checkout was never touched.
    expect(await harness.repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await harness.repo.git('status', '--porcelain')).toBe('');

    // PR text and the human PR gate.
    expect(prItem.kind === 'pr_ready' && prItem.payload.body).toContain(
      '| T3 | Extra registry entry | merged | claude | codex | approve | 1 |',
    );
    expect(prItem.kind === 'pr_ready' && prItem.payload.body).toContain('Closes acme/widgets#42');
    expect(prItem.kind === 'pr_ready' && prItem.payload.body).toContain('Terse docs');
    const pr = await harness.client.call('runs.createPr', { runId: run.id, title: null, body: null });
    expect(pr.url).toBe('https://github.invalid/legion/fake/pull/1');
    expect(pr.run).toMatchObject({ status: 'done', prUrl: pr.url });
    expect(harness.prHost.prs[0]).toMatchObject({ base: 'main', head: integration, title: 'Add the registry feature' });
    expect(await gitText(harness.origin, ['rev-parse', integration])).toBe(
      await harness.repo.git('rev-parse', integration),
    );

    // Inbox lifecycle: everything resolved, kinds in order of creation.
    const inbox = await harness.client.call('inbox.list', { runId: run.id, includeResolved: true });
    expect(inbox.every((i) => i.resolvedAt !== null)).toBe(true);
    expect(inbox.map((i) => i.kind)).toEqual(['question', 'plan_signoff', 'approval', 'pr_ready']);

    // Event stream: the run's status sequence, agent events, host messages.
    await harness.waitFor(
      () => harness.events.some((e) => e.type === 'run.updated' && e.run.status === 'done'),
      'done event pushed',
    );
    const statuses = harness.events
      .filter((e): e is ServerEventOf<'run.updated'> => e.type === 'run.updated' && e.from !== null)
      .map((e) => e.run.status);
    expect(statuses).toEqual([
      'clarifying',
      'planning',
      'awaiting_approval',
      'executing',
      'integrating',
      'finalizing',
      'pr_ready',
      'done',
    ]);
    expect(harness.events.some((e) => e.type === 'agent.event' && e.event.type === 'file_change')).toBe(true);
    const notifications = harness.host
      .filter((m) => m.type === 'notify')
      .map((m) => (m.type === 'notify' ? m.title : ''));
    expect(notifications).toEqual([
      'Clarifying questions',
      'Plan ready for review',
      'Approval needed',
      'Ready for a pull request',
    ]);
    expect(harness.host.filter((m) => m.type === 'badge').at(-1)).toEqual({ type: 'badge', count: 0 });
    expect(harness.host.filter((m) => m.type === 'power').map((m) => m.type === 'power' && m.preventSleep)).toEqual(
      expect.arrayContaining([true, false]),
    );
    expect(harness.host.filter((m) => m.type === 'power').at(-1)).toEqual({ type: 'power', preventSleep: false });

    // Usage is accounted per attempt; the run summary sums it.
    const summary = (await harness.client.call('runs.list', {})).find((s) => s.run.id === run.id);
    expect(summary?.costUsd).toBeGreaterThan(0.3);
    const transcript = await harness.client.call('attempts.transcript', {
      attemptId: snapshot.attempts[0]?.id as string,
      sinceSeq: 0,
      limit: 100,
    });
    expect(transcript.entries[0]?.event.type).toBe('session_started');

    // Diffs: run (base...integration) and a merged task (startSha..branch).
    const runDiff = await harness.client.call('diff.get', { target: { kind: 'run', runId: run.id }, contextLines: 3 });
    expect(runDiff.files.map((f) => f.path).sort()).toEqual([
      'docs/approved.md',
      'docs/notes.md',
      'shared/registry.txt',
      'src/core.txt',
      'src/feature.txt',
    ]);
    const taskDiff = await harness.client.call('diff.get', {
      target: { kind: 'task', taskId: tasks.get('T1')?.id as string },
      contextLines: 0,
    });
    expect(taskDiff.files).toEqual([expect.objectContaining({ path: 'src/core.txt', status: 'added', additions: 1 })]);
  });

  it('resolves a merge conflict with a resolver session', async () => {
    const script: Script = (ctx) => {
      if (ctx.opts.role === 'planner') {
        return [
          planOutput([
            node('T1', { writes: ['src/t1.txt'], verify: { commands: ['test -f src/t1.txt'] } }),
            node('T2', { writes: ['src/t2.txt'], verify: { commands: ['test -f src/t2.txt'] } }),
          ]),
        ];
      }
      if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
      if (ctx.opts.role === 'resolver') {
        // Both sides changed the shared line: keep both.
        return [{ kind: 'write_file', path: 'shared.txt', content: 'from T1\nfrom T2\n' }, report('Resolve the merge')];
      }
      const id = taskIdIn(ctx.message);
      // Both tasks (wrongly) rewrite the same file outside their declared touches.
      return [
        { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
        { kind: 'write_file', path: 'shared.txt', content: `from ${id}\n` },
        report(`Implement ${id}`),
      ];
    };
    h = await startHarness({ script, files: { 'shared.txt': 'base\n' } });
    const harness = h;
    const run = await createRun(harness, true);
    await approveLatestPlan(harness, run.id);
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const snapshot = await harness.client.call('runs.get', { runId: run.id });
    expect(snapshot.attempts.filter((a) => a.role === 'resolver')).toHaveLength(1);
    expect(snapshot.tasks.every((t) => t.status === 'merged')).toBe(true);
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('show', `${integration}:shared.txt`)).toBe('from T1\nfrom T2');
    // The scope check flagged the undeclared write for the reviewer.
    const reviewerPrompt = harness.codex.sessions.find((s) => s.opts.role === 'reviewer')?.opts.prompt ?? '';
    expect(reviewerPrompt).toContain('Out of scope: `shared.txt`');
  });

  it('parks the merge queue while the resolver engine is rate limited and wakes at the reset', async () => {
    let resolverStarts = 0;
    const script: Script = (ctx) => {
      if (ctx.opts.role === 'planner') return [planOutput([node('T1'), node('T2')])];
      if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
      if (ctx.opts.role === 'resolver') {
        resolverStarts++;
        return [{ kind: 'write_file', path: 'shared.txt', content: 'both\n' }, report('Resolve')];
      }
      const id = taskIdIn(ctx.message);
      return [
        { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
        { kind: 'write_file', path: 'shared.txt', content: `from ${id}\n` },
        report(`Implement ${id}`),
      ];
    };
    h = await startHarness({ script, files: { 'shared.txt': 'base\n' } });
    const harness = h;
    const o = harness.engine.orchestrator;
    const flows = o.flows;
    if (!flows) throw new Error('no flows');
    let queueStarts = 0;
    o.flows = {
      ...flows,
      mergeQueue: (id: string) => {
        queueStarts++;
        return flows.mergeQueue(id);
      },
    };
    const run = await createRun(harness, true);
    await approveLatestPlan(harness, run.id);
    await harness.waitFor(() => tasksOf(harness, run.id).some((t) => t.status === 'merged'), 'first merge', 30_000);
    const limitMs = 1_500;
    o.registerRateLimit('claude', Date.now() + limitMs);
    const waiting = tasksOf(harness, run.id).find((t) => t.status !== 'merged') as Task;
    await harness.waitFor(() => o.mergeParked.has(run.id), 'merge queue parked', 30_000);
    const parkedAt = queueStarts;
    const head = await harness.repo.git('rev-parse', waiting.branch as string);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // No restarts, no git merge into the task branch, no resolver while parked.
    expect(queueStarts).toBe(parkedAt);
    expect(await harness.repo.git('rev-parse', waiting.branch as string)).toBe(head);
    expect(existsSync(join(waiting.worktreePath as string, '.git'))).toBe(true);
    expect(resolverStarts).toBe(0);
    // The wake timer restarts the queue once the limit resets.
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready after the reset', 30_000);
    expect(resolverStarts).toBe(1);
  });

  describe('lockfile conflicts', () => {
    // A fake package manager: the lockfile is the sorted list of declared deps (deps/*.txt).
    const files = (lockfileCommand: string) => ({
      'deps/base.txt': 'base\n',
      'pnpm-lock.yaml': 'base\n',
      'bin/fakepm': 'set -e\n[ "$1" = lock ] || exit 64\ncat deps/*.txt | sort > pnpm-lock.yaml\n',
      'legion.json': JSON.stringify({ installCommand: 'true', lockfileCommand }),
    });
    const script: Script = (ctx) => {
      if (ctx.opts.role === 'planner') {
        // Lockfiles are not declared (always in scope with an install command), so the tasks run in parallel.
        const writes = (id: string) => [`src/${id}.txt`, `deps/${id}.txt`];
        return [planOutput([node('T1', { writes: writes('t1') }), node('T2', { writes: writes('t2') })])];
      }
      if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
      const id = taskIdIn(ctx.message).toLowerCase();
      return [
        { kind: 'write_file', path: `src/${id}.txt`, content: `${id}\n` },
        { kind: 'write_file', path: `deps/${id}.txt`, content: `${id}\n` },
        // Each task "installs" its dependency: the lockfiles conflict.
        { kind: 'write_file', path: 'pnpm-lock.yaml', content: `base\n${id}\n` },
        report(`Implement ${id}`),
      ];
    };

    it('regenerates the lockfile with the non-frozen command and commits it', async () => {
      h = await startHarness({ script, files: files('sh bin/fakepm lock') });
      const harness = h;
      const run = await createRun(harness, true);
      await approveLatestPlan(harness, run.id);
      await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready', 30_000);
      const snapshot = await harness.client.call('runs.get', { runId: run.id });
      expect(snapshot.attempts.filter((a) => a.role === 'resolver')).toHaveLength(0);
      const integration = runOf(harness, run.id).integrationBranch as string;
      expect(await harness.repo.git('show', `${integration}:pnpm-lock.yaml`)).toBe('base\nt1\nt2');
      const setup = harness.engine.store.listVerifications(run.id).filter((v) => v.command === 'sh bin/fakepm lock');
      expect(setup.map((v) => v.exitCode)).toEqual([0]);
    });

    it('escalates when the lockfile cannot be regenerated', async () => {
      h = await startHarness({ script, files: files('sh bin/fakepm broken') });
      const harness = h;
      const run = await createRun(harness, true);
      await approveLatestPlan(harness, run.id);
      const item = await harness.waitFor(
        () => openInbox(harness, run.id).find((i) => i.kind === 'escalation'),
        'lockfile escalation',
        30_000,
      );
      expect(item.kind === 'escalation' && item.payload.summary).toMatch(/regenerating the lockfile .* exited with 64/);
      expect(
        tasksOf(harness, run.id)
          .map((t) => t.status)
          .sort(),
      ).toEqual(['awaiting_human', 'merged']);
    });
  });

  it('recovers after an engine restart mid-run and completes', async () => {
    let phase: 'before' | 'after' = 'before';
    const script: Script = (ctx) => {
      if (ctx.opts.role === 'planner') {
        return [planOutput([node('T1'), node('T2', { dependsOn: ['T1'] })])];
      }
      if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
      const id = taskIdIn(ctx.message);
      if (id === 'T2' && phase === 'before') {
        // Blocks on an approval nobody answers: the engine is stopped meanwhile.
        return [
          { kind: 'write_file', path: 'src/t2.txt', content: 'partial\n' },
          { kind: 'approval', tool: 'Bash', input: { command: 'sleep 1000' }, reason: 'wait' },
        ];
      }
      if (ctx.resumed) {
        return [{ kind: 'write_file', path: 'src/t2.txt', content: 'T2 resumed\n' }, report('Finish T2')];
      }
      return [
        { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
        report(`Implement ${id}`),
      ];
    };
    h = await startHarness({ script });
    const harness = h;
    const run = await createRun(harness, true);
    await approveLatestPlan(harness, run.id);
    const approval = await harness.waitFor(
      () => openInbox(harness, run.id).find((i) => i.kind === 'approval'),
      'T2 blocked on approval',
    );
    const t2 = tasksOf(harness, run.id).find((t) => t.nodeId === 'T2') as Task;
    expect(t2.status).toBe('running');

    phase = 'after';
    await harness.restart();
    await harness.engine.ready;
    // The stale approval died with its session; the coder attempt was resumed in the same row.
    expect(harness.engine.store.getInboxItem(approval.id)?.resolvedAt).not.toBeNull();
    await harness.waitFor(() => runOf(harness, run.id).status === 'pr_ready', 'pr_ready after restart', 30_000);
    const attempts = harness.engine.store.listAttempts(run.id).filter((a) => a.taskId === t2.id && a.role === 'coder');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('succeeded');
    const resumed = harness.claude.sessions.find((s) => s.opts.role === 'coder');
    expect(resumed?.resumed).toBe(true);
    expect(resumed?.opts.prompt).toContain('Legion was restarted');
    const integration = runOf(harness, run.id).integrationBranch as string;
    expect(await harness.repo.git('show', `${integration}:src/t2.txt`)).toBe('T2 resumed');
  });
});
