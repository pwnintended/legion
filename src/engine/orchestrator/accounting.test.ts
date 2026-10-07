/** Usage accounting, live task diffs, the fake-engine demo mode, the registry and small helpers. */
import { MessageChannel } from 'node:worker_threads';
import { DEFAULT_SETTINGS } from '@shared/domain';
import type { ServerEvent } from '@shared/events';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient } from '@shared/rpc-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../adapters/fake';
import { silentLogger } from '../context';
import { makeRepo } from '../git/test-helpers';
import { startEngine } from '../index';
import { trackPtyExits } from './index';
import { classifyFailure } from './orchestrator';
import { EngineRegistry } from './registry';
import {
  approve,
  type Harness,
  node,
  planOutput,
  report,
  requestChangesOutput,
  startHarness,
  taskIdIn,
} from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function startExecuting(harness: Harness) {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: null,
    title: null,
    issueText: 'Usage',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
  await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  return run;
}

describe('usage accounting', () => {
  it('treats usage as cumulative per session: a resumed session is charged only the difference', async () => {
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
        if (ctx.opts.role === 'reviewer') {
          return ctx.message.includes('Re-review') ? [approve(ctx)] : [requestChangesOutput('Not yet')];
        }
        if (ctx.opts.role === 'finalizer') return [approve(ctx)];
        // Claude-style cumulative totals: 0.10 after the first turn, 0.25 after the resumed fix round.
        const cost = ctx.resumed ? 0.25 : 0.1;
        return [
          { kind: 'usage', inputTokens: cost * 10_000, outputTokens: cost * 1_000, costUsd: cost },
          { kind: 'write_file', path: 'src/t1.txt', content: `${cost}\n` },
          report(`Implement ${taskIdIn(ctx.message)}`),
        ];
      },
    });
    const harness = h;
    const run = await startExecuting(harness);
    await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
    const coders = harness.engine.store.listAttempts(run.id).filter((a) => a.role === 'coder');
    expect(coders).toHaveLength(2);
    expect(coders[0]?.sessionId).toBe(coders[1]?.sessionId);
    expect(coders.map((a) => a.costUsd)).toEqual([0.1, 0.15]);
    expect(coders.map((a) => a.inputTokens)).toEqual([1000, 1500]);
    const summary = (await harness.client.call('runs.list', {})).find((s) => s.run.id === run.id);
    expect(summary?.costUsd).toBeCloseTo(0.25);
  });
});

describe('live task diff', () => {
  it('shows uncommitted and untracked changes of a running task without touching its index', async () => {
    h = await startHarness({
      script: (ctx) => {
        if (ctx.opts.role === 'planner') return [planOutput([node('T1', { writes: ['src/**', 'README.md'] })])];
        return [
          { kind: 'write_file', path: 'src/new.txt', content: 'new\n' },
          { kind: 'write_file', path: 'README.md', content: '# changed\n' },
          { kind: 'delay', ms: 60_000 },
        ];
      },
    });
    const harness = h;
    const run = await startExecuting(harness);
    const task = await harness.waitFor(() => {
      const t = harness.engine.store.listTasks(run.id)[0];
      return t?.status === 'running' &&
        harness.events.some(
          (e) => e.type === 'agent.event' && e.event.type === 'file_change' && e.event.path === 'README.md',
        )
        ? t
        : undefined;
    }, 'coder edits');
    const diff = await harness.client.call('diff.get', { target: { kind: 'task', taskId: task.id }, contextLines: 1 });
    expect(diff.to).toBe('WORKTREE');
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ['README.md', 'modified'],
      ['src/new.txt', 'added'],
    ]);
    const status = await harness.repo.git('-C', task.worktreePath as string, 'status', '--porcelain');
    expect(status.split('\n').sort()).toEqual([' M README.md', '?? src/']);
    await harness.client.call('runs.cancel', { runId: run.id });
  });
});

describe('fake-engine demo mode', () => {
  it('runs the scripted demo from issue to pr_ready with LEGION_FAKE_ENGINES=1', async () => {
    const repo = await makeRepo();
    const engine = await startEngine({
      dataDir: `${repo.scratch}/home`,
      env: { ...process.env, LEGION_FAKE_ENGINES: '1' },
      log: silentLogger,
      probeOnStart: false,
      fakeStepDelayMs: 0,
    });
    const channel = new MessageChannel();
    engine.connect(channel.port1);
    const client = createRpcClient<RpcContract, ServerEvent>(channel.port2);
    try {
      expect(engine.registry.fakeMode).toBe(true);
      const engines = await client.call('engines.list', {});
      expect(engines.map((e) => [e.kind, e.account])).toEqual([
        ['claude', 'scripted fake (LEGION_FAKE_ENGINES=1)'],
        ['codex', 'scripted fake (LEGION_FAKE_ENGINES=1)'],
        ['fake', 'fake@legion.test'],
      ]);
      const run = await client.call('runs.create', {
        repoPath: repo.path,
        baseRef: null,
        title: null,
        issueText: 'Demo issue',
        issueUrl: null,
        plannerEngine: 'claude',
        plannerModel: null,
        skipClarify: false,
      });
      const waitFor = async <T>(probe: () => T | undefined) => {
        for (let i = 0; i < 2000; i++) {
          const value = probe();
          if (value !== undefined) return value;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('timeout');
      };
      const question = await waitFor(() =>
        engine.store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'question'),
      );
      await client.call('inbox.resolve', {
        itemId: question.id,
        resolution: { kind: 'question', answers: [{ questionId: 'q1', answer: 'Yes, add docs' }] },
      });
      const signoff = await waitFor(() =>
        engine.store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'plan_signoff'),
      );
      await client.call('inbox.resolve', {
        itemId: signoff.id,
        resolution: { kind: 'plan_signoff', approved: true, feedback: null },
      });
      // The demo's one tool approval (see demo.test.ts for the whole script).
      const approval = await waitFor(() =>
        engine.store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'approval'),
      );
      await client.call('inbox.resolve', {
        itemId: approval.id,
        resolution: { kind: 'approval', decision: { behavior: 'allow', scope: 'once', updatedInput: null } },
      });
      const prReady = await waitFor(() =>
        engine.store.listInbox({ runId: run.id, includeResolved: false }).find((i) => i.kind === 'pr_ready'),
      );
      await client.call('inbox.resolve', {
        itemId: prReady.id,
        resolution: { kind: 'pr_ready', approved: true, title: null, body: null },
      });
      const done = engine.store.requireRun(run.id);
      expect(done.status).toBe('done');
      expect(done.prUrl).toMatch(/^https:\/\/github\.invalid\//);
      expect(engine.store.listTasks(run.id).map((t) => t.status)).toEqual(['merged', 'merged', 'merged']);
      // The demo never pushes.
      expect(await repo.git('remote')).toBe('');
    } finally {
      client.close({ closePort: true });
      await engine.close();
      repo.cleanup();
    }
  });
});

describe('engine registry', () => {
  it('reports disabled and not-logged-in engines as unusable', async () => {
    let settings = DEFAULT_SETTINGS;
    const claude = new FakeEngine({ info: { loggedIn: false, error: 'not logged in' } });
    const registry = new EngineRegistry({
      dataDir: '/tmp/legion-registry',
      env: {},
      version: 'test',
      log: silentLogger,
      settings: () => settings,
      fake: false,
      overrides: { claude, codex: new FakeEngine() },
    });
    expect(registry.usable('claude')).toEqual({ ok: true });
    await registry.probe('claude');
    expect(registry.usable('claude')).toEqual({ ok: false, reason: 'not logged in' });
    settings = {
      ...DEFAULT_SETTINGS,
      engines: { ...DEFAULT_SETTINGS.engines, codex: { ...DEFAULT_SETTINGS.engines.codex, enabled: false } },
    };
    expect(registry.usable('codex')).toEqual({ ok: true }); // a fake stands in: settings do not disable it
    expect(registry.isFake('codex')).toBe(true);
    expect((await registry.list()).map((i) => i.kind)).toEqual(['claude', 'codex']);
  });

  it('turns a throwing probe into an error entry', async () => {
    const broken = new FakeEngine();
    broken.probe = () => Promise.reject(new Error('spawn EACCES'));
    const registry = new EngineRegistry({
      dataDir: '/tmp/legion-registry',
      env: {},
      version: 'test',
      log: silentLogger,
      settings: () => DEFAULT_SETTINGS,
      fake: false,
      overrides: { claude: broken, codex: new FakeEngine() },
    });
    const [info] = await registry.probe('claude');
    expect(info).toMatchObject({ kind: 'claude', installed: false, error: 'probe failed: spawn EACCES' });
    expect(registry.usable('claude')).toEqual({ ok: false, reason: 'probe failed: spawn EACCES' });
  });
});

describe('helpers', () => {
  it('classifies failures', () => {
    expect(classifyFailure('API error 429 Too Many Requests').kind).toBe('rate_limited');
    expect(classifyFailure('You have hit your usage limit').kind).toBe('rate_limited');
    expect(classifyFailure('Claude Code is not logged in (run `claude auth login`)').kind).toBe('auth');
    expect(classifyFailure('401 Unauthorized').kind).toBe('auth');
    expect(classifyFailure('invalid structured output: verdict: required').kind).toBe('agent_error');
  });

  it('tracks PTY exits by pid without stealing the exit listener', async () => {
    const listeners: ((e: { exitCode: number }) => void)[] = [];
    const tracked = trackPtyExits(() => ({
      pid: 77,
      onData: () => {},
      onExit: (l) => {
        listeners.splice(0, listeners.length, l); // keeps only the last listener, like a naive PTY
      },
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
    }));
    const proc = tracked.spawn('sh', [], { cwd: '/', env: {}, cols: 80, rows: 24 });
    const seen: number[] = [];
    proc.onExit((e) => seen.push(e.exitCode));
    const exit = tracked.exitOf(77);
    expect(tracked.exitOf(78)).toBeNull();
    listeners[0]?.({ exitCode: 3 });
    await expect(exit).resolves.toBe(3);
    expect(seen).toEqual([3]);
  });
});
