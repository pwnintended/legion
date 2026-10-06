/**
 * Live smoke test of a whole run against the real CLIs (`pnpm test:live`, LEGION_LIVE=1): a throwaway
 * repo, a trivial issue, Claude haiku as planner and coders, Codex (low effort) as reviewer and
 * finalizer. The plan and every approval are accepted through the RPC; the run must reach `pr_ready`.
 * No PR is created (nothing is pushed). Expect a few minutes and well under $1.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { InboxItem, Run } from '@shared/domain';
import type { ServerEvent } from '@shared/events';
import type { RpcContract } from '@shared/rpc';
import { createRpcClient, type RpcClient } from '@shared/rpc-transport';
import { describe, expect, it } from 'vitest';
import { consoleLogger } from '../context';
import { startEngine } from '../index';

const LIVE = process.env.LEGION_LIVE === '1';
const TIMEOUT_MS = 20 * 60_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(root: string): string {
  const repo = join(root, 'tiny');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# tiny\n\nA tiny ES module package. Tests run with `node --test`.\n');
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'tiny', version: '0.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'src', 'index.js'), 'export const name = "tiny";\n');
  writeFileSync(join(repo, 'legion.json'), `${JSON.stringify({ verify: ['node --test'] }, null, 2)}\n`);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Legion Live', '-c', 'user.email=live@legion.test', 'commit', '-q', '-m', 'initial');
  return repo;
}

/** Answer whatever the run asks, like an agreeable human. Throws on escalations (the run went wrong). */
async function answer(client: RpcClient<RpcContract, ServerEvent>, item: InboxItem): Promise<void> {
  switch (item.kind) {
    case 'question':
      await client.call('inbox.resolve', {
        itemId: item.id,
        resolution: {
          kind: 'question',
          answers: item.payload.questions.map((q) => ({
            questionId: q.id,
            answer: q.options[0] ?? 'Use your judgement; keep it minimal.',
          })),
        },
      });
      return;
    case 'approval':
      await client.call('inbox.resolve', {
        itemId: item.id,
        resolution: { kind: 'approval', decision: { behavior: 'allow', scope: 'once', updatedInput: null } },
      });
      return;
    case 'plan_signoff': {
      // Pin every task to Claude haiku so the reviewers are Codex.
      const snapshot = await client.call('runs.get', { runId: item.runId });
      const plan = snapshot.plans.find((p) => p.id === item.payload.planId);
      if (!plan) throw new Error('plan not found');
      const pinned = await client.call('runs.updatePlan', {
        runId: item.runId,
        basePlanId: plan.id,
        markdown: plan.markdown,
        nodes: plan.dag.nodes.map((n) => ({ ...n, agent: { engine: 'claude', model: 'haiku', effort: 'low' } })),
      });
      await client.call('runs.approvePlan', { runId: item.runId, planId: pinned.id });
      return;
    }
    case 'escalation':
    case 'conflict':
    case 'budget':
      throw new Error(`the run escalated: ${JSON.stringify(item.payload)}`);
    case 'pr_ready':
      return;
  }
}

describe.skipIf(!LIVE)('a tiny real run (live)', () => {
  it(
    'plans, codes with Claude haiku, reviews with Codex and reaches pr_ready',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'legion-run-live-'));
      const repo = makeRepo(root);
      const engine = await startEngine({ dataDir: join(root, 'home'), env: process.env, log: consoleLogger });
      const channel = new MessageChannel();
      engine.connect(channel.port1);
      const client = createRpcClient<RpcContract, ServerEvent>(channel.port2, { timeoutMs: 120_000 });
      try {
        const engines = await client.call('engines.probe', { kind: null });
        for (const kind of ['claude', 'codex'] as const) {
          const info = engines.find((e) => e.kind === kind);
          expect(info?.installed, `${kind}: ${info?.error}`).toBe(true);
          expect(info?.loggedIn, `${kind}: ${info?.error}`).not.toBe(false);
        }
        await client.call('settings.set', {
          concurrency: { global: 2 },
          budget: { perRunUsd: 3 },
          roles: {
            planner: { models: { claude: 'haiku' }, effort: 'low' },
            coder: { engine: 'claude', models: { claude: 'haiku' }, effort: 'low' },
            resolver: { models: { claude: 'haiku' }, effort: 'low' },
            reviewer: { models: { codex: null }, effort: 'low' },
            finalizer: { models: { codex: null }, effort: 'low' },
          },
        });

        const run = await client.call('runs.create', {
          repoPath: repo,
          baseRef: null,
          title: 'Add greet(name)',
          issueText:
            'Add a `greet(name)` function in `src/greet.js` (ES module, named export) that returns `Hello, <name>!`. ' +
            'Add a test for it in `test/greet.test.js` using `node:test` and `node:assert`, runnable with `node --test`. ' +
            'Keep it to one small task.',
          issueUrl: null,
          plannerEngine: 'claude',
          plannerModel: 'haiku',
          skipClarify: false,
        });

        const answered = new Set<string>();
        const deadline = Date.now() + TIMEOUT_MS - 30_000;
        let current: Run = run;
        while (current.status !== 'pr_ready') {
          if (Date.now() > deadline) throw new Error(`timed out in ${current.status}`);
          if (current.status === 'failed' || current.status === 'cancelled') {
            throw new Error(`run ${current.status}: ${current.error}`);
          }
          for (const item of await client.call('inbox.list', { runId: run.id, includeResolved: false })) {
            if (answered.has(item.id)) continue;
            answered.add(item.id);
            await answer(client, item);
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          current = (await client.call('runs.get', { runId: run.id })).run;
        }

        const snapshot = await client.call('runs.get', { runId: run.id });
        expect(snapshot.tasks.length).toBeGreaterThan(0);
        expect(snapshot.tasks.every((t) => t.status === 'merged' || t.status === 'skipped')).toBe(true);
        const reviewers = snapshot.attempts.filter((a) => a.role === 'reviewer' && a.status === 'succeeded');
        expect(reviewers.length).toBeGreaterThan(0);
        expect(reviewers.every((a) => a.engine === 'codex')).toBe(true);
        expect(snapshot.attempts.filter((a) => a.role === 'coder').every((a) => a.engine === 'claude')).toBe(true);
        expect(snapshot.verifications.filter((v) => v.phase === 'final').every((v) => v.exitCode === 0)).toBe(true);
        const branch = current.integrationBranch as string;
        expect(git(repo, 'show', `${branch}:src/greet.js`)).toContain('greet');
        const summary = (await client.call('runs.list', {})).find((s) => s.run.id === run.id);
        consoleLogger.info(`live run ${run.id} reached pr_ready, ~$${summary?.costUsd.toFixed(3)} (Claude estimate)`);
      } finally {
        client.close({ closePort: true });
        await engine.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
