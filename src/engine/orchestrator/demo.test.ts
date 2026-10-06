/**
 * Fake-engine mode (`LEGION_FAKE_ENGINES=1`) end to end over RPC: the scripted demo agent exercises every
 * human touch point once and the PR step has no external effects (no push, no GitHub).
 */
import { MessageChannel } from 'node:worker_threads';
import type { InboxItem, Run } from '@shared/domain';
import type { ServerEvent } from '@shared/events';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient, type RpcClient } from '@shared/rpc-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../context';
import { gitText } from '../git';
import { type FixtureRepo, makeBare, makeRepo } from '../git/test-helpers';
import { type EngineHandle, startEngine } from '../index';
import { DEMO_APPROVAL_TASK, DEMO_FIX_TASK } from './demo';
import { FakePrHost } from './pr-host';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('fake-engine demo mode', () => {
  it('runs clarify → plan → approval → review fix round → PR without pushing or calling GitHub', async () => {
    const repo: FixtureRepo = await makeRepo({ 'README.md': '# demo\n' });
    const origin = await makeBare(repo.scratch);
    await repo.git('remote', 'add', 'origin', origin);
    await repo.git('push', '-q', '-u', 'origin', 'main');
    const engine: EngineHandle = await startEngine({
      dataDir: `${repo.scratch}/legion-home`,
      env: { ...process.env, LEGION_FAKE_ENGINES: '1' },
      log: silentLogger,
      fakeStepDelayMs: 0,
      probeOnStart: false,
    });
    const channel = new MessageChannel();
    engine.connect(channel.port1);
    const client: RpcClient<RpcContract, ServerEvent> = createRpcClient(channel.port2, { timeoutMs: 30_000 });
    cleanup = async () => {
      client.close({ closePort: true });
      await engine.close();
      repo.cleanup();
    };
    expect(engine.registry.fakeMode).toBe(true);
    expect(engine.orchestrator.prHost).toBeInstanceOf(FakePrHost);
    expect((engine.orchestrator.prHost as FakePrHost).pushesForReal).toBe(false);

    const open = (runId: string, kind: InboxItem['kind']) =>
      engine.store.listInbox({ runId, includeResolved: false }).find((i) => i.kind === kind);
    const runOf = (runId: string): Run => engine.store.requireRun(runId);

    const run = await client.call('runs.create', {
      repoPath: repo.path,
      baseRef: null,
      title: null,
      issueText: 'Add the demo feature',
      issueUrl: null,
      plannerEngine: 'claude',
      plannerModel: null,
      skipClarify: false,
    });

    // One clarify question.
    const question = await waitFor(() => open(run.id, 'question'), 'clarify question');
    expect(question.kind === 'question' && question.payload.questions).toHaveLength(1);
    await client.call('runs.answerClarify', {
      runId: run.id,
      answers: [{ questionId: 'q1', answer: 'Yes, add docs' }],
    });

    // A 3-task plan with a dependency.
    const signoff = await waitFor(() => open(run.id, 'plan_signoff'), 'plan sign-off');
    const plan = engine.store.latestPlan(run.id);
    expect(plan?.dag.nodes.map((n) => [n.id, n.dependsOn])).toEqual([
      ['T1', []],
      ['T2', ['T1']],
      ['T3', []],
    ]);
    expect(signoff.kind === 'plan_signoff' && signoff.payload.planId).toBe(plan?.id);
    await client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });

    // One approval request (T3's coder wants to run a linter).
    const approval = await waitFor(() => open(run.id, 'approval'), 'approval request');
    const tasks = () => new Map(engine.store.listTasks(run.id).map((t) => [t.nodeId, t]));
    expect(approval.taskId).toBe(tasks().get(DEMO_APPROVAL_TASK)?.id);
    await client.call('inbox.resolve', {
      itemId: approval.id,
      resolution: { kind: 'approval', decision: { behavior: 'allow', scope: 'once', updatedInput: null } },
    });

    // T2's first review has a major finding; the fix round resolves it.
    const prReady = await waitFor(() => open(run.id, 'pr_ready'), 'pr_ready', 60_000);
    expect(runOf(run.id).status).toBe('pr_ready');
    const fixTask = tasks().get(DEMO_FIX_TASK);
    expect(fixTask).toMatchObject({ status: 'merged', fixRounds: 1 });
    const reviews = engine.store.listReviews(run.id).filter((r) => r.taskId === fixTask?.id);
    expect(reviews.map((r) => r.verdict)).toEqual(['request_changes', 'approve']);
    expect(reviews[0]?.findings.map((f) => f.severity)).toEqual(['major']);
    expect(fixTask?.report?.summary).toContain('usage example');
    expect([...tasks().values()].every((t) => t.status === 'merged')).toBe(true);
    const integration = runOf(run.id).integrationBranch as string;
    expect(await repo.git('show', `${integration}:legion-demo/feature.md`)).toContain('## Usage');

    // PR ready → a fake PR; nothing left the machine.
    expect(prReady.kind).toBe('pr_ready');
    const created = await client.call('runs.createPr', { runId: run.id, title: null, body: null });
    expect(created.run).toMatchObject({
      status: 'done',
      pr: { url: 'https://github.invalid/legion/fake/pull/1', number: 1, state: 'open', isDraft: true },
    });
    expect(await gitText(origin, ['branch', '--list', '--format=%(refname:short)'])).toBe('main');
    expect(await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await repo.git('status', '--porcelain')).toBe('');
  });
});
