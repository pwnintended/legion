import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, AccountPool } from '../accounts/index.ts';
import { FakeEngine, type FakeScript } from '../engine/fake/index.ts';
import type { EngineKind } from '../engine/types.ts';
import { agent, gate, group, loop, parallel, sh, step, z } from '../sdk/index.ts';
import { Semaphore } from '../util/semaphore.ts';
import type { GateAnswer, Interaction, RunEvent, RunHost } from './host.ts';
import { Journal } from './journal.ts';
import { AccountsExhausted, executeInRun, isModelRejected, WorkflowCancelled } from './runtime.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-runtime-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface TestHost extends RunHost {
  events: RunEvent[];
  interactions: Interaction[];
  /** The first engine made per kind. */
  engines: Map<EngineKind, FakeEngine>;
  /** Every engine made, by `<kind>/<account>`. */
  accountEngines: Map<string, FakeEngine>;
  pool: AccountPool;
  /** Cooldowns the runtime asked for. */
  cooled: { kind: string; name: string; until: number; reason: string }[];
  shCalls: string[];
}

const account = (kind: 'claude' | 'codex', name: string): Account => ({
  kind,
  name,
  dir: null,
  token: null,
  env: {},
  remote: false,
  enabled: true,
  source: 'config',
});

function testHost(
  opts: { script?: FakeScript; gate?: (i: Interaction) => GateAnswer; accounts?: string[] } = {},
): TestHost {
  const engines = new Map<EngineKind, FakeEngine>();
  const accountEngines = new Map<string, FakeEngine>();
  const names = (kind: string) => opts.accounts ?? [`${kind}-1`];
  const pool = new AccountPool({
    file: join(dir, 'pool.json'),
    accounts: (kind) => names(kind).map((n) => account(kind, n)),
  });
  const host: TestHost = {
    repo: dir,
    dryRun: false,
    maxAgents: 4,
    approvals: 'ask',
    events: [],
    interactions: [],
    engines,
    accountEngines,
    pool,
    cooled: [],
    shCalls: [],
    engine(kind, name) {
      let engine = accountEngines.get(`${kind}/${name}`);
      if (!engine) {
        engine = new FakeEngine(kind, opts.script, name);
        accountEngines.set(`${kind}/${name}`, engine);
        if (!engines.has(kind)) engines.set(kind, engine);
      }
      return engine;
    },
    account: (kind, req) => pool.acquire(kind, req),
    cooldown(kind, name, until, reason) {
      host.cooled.push({ kind, name, until, reason });
      pool.cooldown(kind, name, until, reason);
    },
    earliestReset: (kind, where) => pool.earliestReset(kind, where),
    emit(event) {
      host.events.push(event);
    },
    async sh(command) {
      host.shCalls.push(command);
      return { code: command.includes('fail') ? 1 : 0, stdout: `ran ${command}`, stderr: '' };
    },
    async interact(interaction) {
      host.interactions.push(interaction);
      if (interaction.kind === 'gate') return (opts.gate?.(interaction) ?? { choice: 'approve', note: null }) as never;
      if (interaction.kind === 'ask') return { answer: 'yes' } as never;
      if (interaction.kind === 'questions')
        return { answers: Object.fromEntries(interaction.questions.map((q) => [q.id, ['picked']])) } as never;
      return { behavior: 'allow', scope: 'once', updatedInput: null } as never;
    },
    git: undefined as never,
  };
  return host;
}

function exec<T>(host: RunHost, fn: () => Promise<T>, signal = new AbortController().signal): Promise<T> {
  return executeInRun({ runId: 'r1', host, journal: new Journal(dir), signal }, fn);
}

describe('runtime', () => {
  it('returns text, or structured output validated by the schema', async () => {
    const host = testHost({
      script: (call) => (call.opts.outputSchema ? { output: { n: 3 } } : { text: 'hello' }),
    });
    const result = await exec(host, async () => {
      const text = await agent('a', { prompt: 'say hi' });
      const data = await agent('b', { prompt: 'count', output: z.object({ n: z.number() }) });
      return { text, n: data.n };
    });
    expect(result).toEqual({ text: 'hello', n: 3 });
  });

  it('asks once more when structured output does not validate, then fails', async () => {
    let turns = 0;
    const host = testHost({ script: () => ({ output: { n: turns++ === 0 ? 'nope' : 5 } }) });
    const n = await exec(host, async () => (await agent('a', { prompt: 'x', output: z.object({ n: z.number() }) })).n);
    expect(n).toBe(5);
    const call = host.engines.get('claude')?.calls[0];
    expect(call?.prompts[1]).toContain('did not match');

    const bad = testHost({ script: () => ({ output: { n: 'never' } }) });
    rmSync(dir, { recursive: true, force: true });
    await expect(exec(bad, () => agent('a', { prompt: 'x', output: z.object({ n: z.number() }) }))).rejects.toThrow(
      /did not match/,
    );
  });

  it("lets the host override the code's model and effort, and records what ran", async () => {
    const host = testHost({});
    const seen: unknown[] = [];
    host.agentModel = (req) => {
      seen.push(req);
      return req.key === 'b' ? { model: 'opus', effort: 'max' } : { model: req.model, effort: req.effort };
    };
    await exec(host, async () => {
      await agent('a', { prompt: 'x', model: 'haiku' });
      await group('g', () => agent('b', { engine: 'codex', tier: 'hard', prompt: 'y' }));
    });
    const calls = host.engines.get('claude')?.calls ?? [];
    expect(calls[0]?.opts).toMatchObject({ model: 'haiku', effort: null });
    expect(host.engines.get('codex')?.calls[0]?.opts).toMatchObject({ model: 'opus', effort: 'max' });
    expect(seen).toEqual([
      { key: 'a', step: 'a', engine: 'claude', tier: null, model: 'haiku', effort: null },
      { key: 'b', step: 'g/b', engine: 'codex', tier: 'hard', model: null, effort: null },
    ]);
    expect(new Journal(dir).get('g/b')?.meta).toMatchObject({ model: 'opus', effort: 'max' });
  });

  it('runs a step on the engine the host picks', async () => {
    const host = testHost({});
    host.agentModel = (req) => ({ engine: 'codex', model: null, effort: req.effort });
    await exec(host, () => agent('a', { prompt: 'x', engine: 'claude', model: 'haiku' }));
    expect(host.engines.get('claude')?.calls ?? []).toHaveLength(0);
    expect(host.engines.get('codex')?.calls).toHaveLength(1);
    expect(new Journal(dir).get('a')?.meta).toMatchObject({ engine: 'codex' });
    // Shown on it from the start, not on the one the code names.
    expect(host.events).toContainEqual(
      expect.objectContaining({ type: 'step', key: 'a', status: 'started', engine: 'codex' }),
    );
  });

  it('replays finished steps from the journal on resume', async () => {
    let failSecond = true;
    const workflow = async () => {
      const first = await agent('first', { prompt: 'one' });
      await sh('check', failSecond ? 'fail now' : 'ok now');
      return first;
    };
    const host1 = testHost();
    await expect(exec(host1, workflow)).rejects.toThrow(/exited with 1/);
    expect(host1.engines.get('claude')?.calls).toHaveLength(1);

    failSecond = false;
    const host2 = testHost();
    await exec(host2, workflow);
    // `first` came from the journal: no new session.
    expect(host2.engines.get('claude')?.calls ?? []).toHaveLength(0);
    expect(host2.events.some((e) => e.type === 'step' && e.key === 'first' && e.status === 'cached')).toBe(true);
    expect(host2.shCalls).toEqual(['ok now']);
  });

  it('resumes an interrupted agent session on its own account, and records the account', async () => {
    new Journal(dir).append({
      key: 'code',
      kind: 'agent',
      status: 'started',
      ts: 1,
      meta: { sessionId: 's-123', account: 'claude-2', engine: 'claude' },
    });
    // Another account would be next in the rotation: the interrupted step's own wins.
    const host = testHost({ accounts: ['claude-1', 'claude-2'] });
    await exec(host, () => agent('code', { prompt: 'build it' }));
    const call = host.accountEngines.get('claude/claude-2')?.calls[0];
    expect(call?.resumed).toBe(true);
    expect(call?.sessionId).toBe('s-123');
    expect(call?.prompts[0]).toContain('You were interrupted');
    expect(host.accountEngines.has('claude/claude-1')).toBe(false);
    expect(new Journal(dir).get('code')?.meta).toMatchObject({ account: 'claude-2', where: 'local' });
  });

  it('still resumes journals that recorded the account as `profile`', async () => {
    new Journal(dir).append({
      key: 'code',
      kind: 'agent',
      status: 'started',
      ts: 1,
      meta: { sessionId: 's-9', profile: 'claude-2', engine: 'claude' },
    });
    const host = testHost({ accounts: ['claude-1', 'claude-2'] });
    await exec(host, () => agent('code', { prompt: 'build it' }));
    expect(host.accountEngines.get('claude/claude-2')?.calls[0]).toMatchObject({ resumed: true, sessionId: 's-9' });
  });

  it('restarts an interrupted agent when its account is not the one chosen', async () => {
    new Journal(dir).append({
      key: 'code',
      kind: 'agent',
      status: 'started',
      ts: 1,
      meta: { sessionId: 's-123', account: 'claude-1', engine: 'claude' },
    });
    const host = testHost({ accounts: ['claude-2'] });
    await exec(host, () => agent('code', { prompt: 'build it' }));
    expect(host.engines.get('claude')?.calls[0]?.resumed).toBe(false);
    expect(host.engines.get('claude')?.calls[0]?.prompts[0]).toBe('build it');
  });

  it('restarts an interrupted agent that started in a box when it now runs locally', async () => {
    new Journal(dir).append({
      key: 'code',
      kind: 'agent',
      status: 'started',
      ts: 1,
      meta: { sessionId: 's-1', account: 'claude-1', where: 'box', engine: 'claude' },
    });
    const host = testHost();
    await exec(host, () => agent('code', { prompt: 'build it' }));
    expect(host.engines.get('claude')?.calls[0]?.resumed).toBe(false);
  });

  it("keeps the earlier step's output when `resume` cannot continue its session", async () => {
    const host = testHost({ accounts: ['a', 'b'] });
    // The earlier step ran on b; b is cooling, so the follow-up starts over on a.
    host.pool.cooldown('claude', 'b', Date.now() + 3_600_000, 'usage limit');
    new Journal(dir).append({
      key: 'review',
      kind: 'agent',
      status: 'done',
      ts: 1,
      output: 'issue-7 in foo.ts',
      meta: { sessionId: 's-1', account: 'b', where: 'local', engine: 'claude' },
    });
    await exec(host, () => agent('fix', { prompt: 'fix the issues you found', resume: 'review' }));
    const call = host.accountEngines.get('claude/a')?.calls[0];
    expect(call?.resumed).toBe(false);
    expect(call?.prompts[0]).toContain('issue-7 in foo.ts');
    // A different place also starts over, with the output.
    const box = testHost({ accounts: ['c'] });
    new Journal(dir).append({
      key: 'review2',
      kind: 'agent',
      status: 'done',
      ts: 2,
      output: 'box findings',
      meta: { sessionId: 's-2', account: 'c', where: 'box', engine: 'claude' },
    });
    await exec(box, () => agent('fix2', { prompt: 'fix', resume: 'review2' }));
    expect(box.engines.get('claude')?.calls[0]).toMatchObject({ resumed: false });
    expect(box.engines.get('claude')?.calls[0]?.prompts[0]).toContain('box findings');
  });

  describe('account limits', () => {
    const limited =
      (resetsAt: number | null = null): FakeScript =>
      (call) =>
        call.account === 'a' ? { limit: { resetsAt } } : { text: `done on ${call.account}` };

    it('cools the account down and finishes the step on the next one', async () => {
      const reset = Date.now() + 3_600_000;
      const host = testHost({ accounts: ['a', 'b'], script: limited(reset) });
      const out = await exec(host, () => agent('s', { prompt: 'work' }));
      expect(out).toBe('done on b');
      expect(host.cooled).toEqual([{ kind: 'claude', name: 'a', until: reset, reason: 'usage limit' }]);
      const retry = host.accountEngines.get('claude/b')?.calls[0];
      expect(retry?.resumed).toBe(false);
      expect(retry?.prompts[0]).toContain('stopped by a usage limit');
      expect(new Journal(dir).get('s')?.meta).toMatchObject({ account: 'b' });
      expect(
        host.events.some(
          (e) => e.type === 'log' && /account "a" hit its usage limit until \d\d:\d\d; retrying on "b"/.test(e.message),
        ),
      ).toBe(true);
      // The next step does not touch the cooling account.
      await exec(host, () => agent('t', { prompt: 'more' }));
      expect(host.accountEngines.get('claude/a')?.calls).toHaveLength(1);
    });

    it('rests an account for the configured time when the CLI gave no reset', async () => {
      const host = testHost({ accounts: ['a', 'b'], script: limited(null) });
      Object.assign(host, { cooldownMinutes: 5 });
      const before = Date.now();
      await exec(host, () => agent('s', { prompt: 'work' }));
      const until = host.cooled[0]?.until ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(until).toBeLessThan(before + 6 * 60_000);
    });

    it('fails with AccountsExhausted naming the earliest reset when every account is at its limit', async () => {
      const t1 = Date.now() + 2 * 3_600_000;
      const t2 = Date.now() + 3_600_000;
      const host = testHost({
        accounts: ['a', 'b'],
        script: (call) => ({ limit: { resetsAt: call.account === 'a' ? t1 : t2 } }),
      });
      const err = await exec(host, () => agent('s', { prompt: 'work' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AccountsExhausted);
      const clock = new Date(t2);
      const hm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
      expect((err as Error).message).toContain('all claude accounts are at their limits');
      expect((err as Error).message).toContain(hm);
      expect((err as Error).message).toContain('resume_run');
      expect(host.accountEngines.get('claude/a')?.calls).toHaveLength(1);
      expect(host.accountEngines.get('claude/b')?.calls).toHaveLength(1);
    });

    it('stops after one try per account, at most four attempts', async () => {
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const host = testHost({ accounts: names, script: () => ({ limit: { resetsAt: Date.now() + 60_000 } }) });
      const err = await exec(host, () => agent('s', { prompt: 'work' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AccountsExhausted);
      const tries = [...host.accountEngines.values()].map((e) => e.calls.length);
      expect(tries.every((n) => n === 1)).toBe(true);
      expect(tries.length).toBe(4);
    });

    it('at the attempt cap, names an account that was already cooling and resets sooner', async () => {
      const soon = Date.now() + 5 * 60_000;
      const host = testHost({
        accounts: ['a', 'b', 'c', 'd', 'e'],
        script: () => ({ limit: { resetsAt: Date.now() + 3_600_000 } }),
      });
      host.pool.cooldown('claude', 'e', soon, 'usage limit');
      const err = await exec(host, () => agent('s', { prompt: 'work' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AccountsExhausted);
      expect((err as AccountsExhausted).earliestReset).toBe(soon);
      expect(host.accountEngines.has('claude/e')).toBe(false);
    });

    it('does not move on for a failure that is not a limit', async () => {
      const host = testHost({ accounts: ['a', 'b'], script: () => ({ error: 'boom' }) });
      await expect(exec(host, () => agent('s', { prompt: 'work' }))).rejects.toThrow('boom');
      expect(host.cooled).toEqual([]);
    });
  });

  it("continues an earlier step's session with `resume`", async () => {
    const host = testHost();
    await exec(host, async () => {
      await agent('code', { prompt: 'build' });
      await agent('fix', { prompt: 'fix it', resume: 'code' });
    });
    const calls = host.engines.get('claude')?.calls ?? [];
    expect(calls[1]?.resumed).toBe(true);
    expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
  });

  it('scopes keys per loop round and stops when done', async () => {
    const host = testHost();
    const result = await exec(host, () =>
      loop('review', { max: 5 }, async (round) => {
        await step('look', async () => round);
        return round === 3 ? { done: true, value: round } : undefined;
      }),
    );
    expect(result).toEqual({ done: true, rounds: 3, value: 3 });
    const keys = new Journal(dir).all().map((e) => e.key);
    expect(keys).toEqual(['review/1/look', 'review/2/look', 'review/3/look']);
  });

  it('rejects duplicate keys and invalid keys', async () => {
    await expect(
      exec(testHost(), async () => {
        await step('x', async () => 1);
        await step('x', async () => 2);
      }),
    ).rejects.toThrow(/Duplicate step key "x"/);
    await expect(exec(testHost(), () => step('a b', async () => 1))).rejects.toThrow(/Invalid step key/);
  });

  it('runs parallel branches with a concurrency limit and groups keys', async () => {
    let live = 0;
    let peak = 0;
    const out = await exec(testHost(), () =>
      parallel(
        [1, 2, 3, 4].map(
          (n) => () =>
            group(`t${n}`, () =>
              step('work', async () => {
                live++;
                peak = Math.max(peak, live);
                await new Promise((r) => setTimeout(r, 5));
                live--;
                return n * 2;
              }),
            ),
        ),
        { concurrency: 2 },
      ),
    );
    expect(out).toEqual([2, 4, 6, 8]);
    expect(peak).toBe(2);
    expect(new Journal(dir).get('t3/work')?.output).toBe(6);
  });

  it('gates: approve, changes with a note, abort cancels', async () => {
    const answers: GateAnswer[] = [
      { choice: 'changes', note: 'smaller' },
      { choice: 'approve', note: null },
      { choice: 'abort', note: null },
    ];
    const host = testHost({ gate: () => answers.shift() as GateAnswer });
    await expect(
      exec(host, async () => {
        const a = await gate('g1', { title: 'Plan ok?', show: { plan: 1 } });
        expect(a).toEqual({ approved: false, note: 'smaller' });
        const b = await gate('g2', { title: 'Again?' });
        expect(b.approved).toBe(true);
        await gate('g3', { title: 'Last' });
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelled);
    expect(host.interactions[0]).toMatchObject({ kind: 'gate', title: 'Plan ok?', body: '{\n  "plan": 1\n}' });
  });

  it('routes agent tool approvals to the host', async () => {
    const host = testHost({
      script: () => ({ text: 'done', approval: { tool: 'Bash', input: { command: 'rm -rf build' } } }),
    });
    await exec(host, () => agent('a', { prompt: 'clean' }));
    expect(host.interactions[0]).toMatchObject({ kind: 'approval', tool: 'Bash', key: 'a' });
  });

  it("routes an agent's own questions to the host and returns the answers", async () => {
    const question = {
      id: 'q',
      header: null,
      question: 'Which?',
      options: [],
      multiSelect: false,
      allowOther: true,
      secret: false,
    };
    const host = testHost({ script: () => ({ questions: [question] }) });
    const text = await exec(host, () => agent('a', { prompt: 'ask me' }));
    expect(host.interactions[0]).toMatchObject({ kind: 'questions', key: 'a', questions: [question] });
    expect(host.engines.get('claude')?.calls[0]?.answers).toEqual([{ q: ['picked'] }]);
    expect(text).toContain('picked');
  });

  it('asks again in the same session when a turn ends without its structured output', async () => {
    const host = testHost({
      script: (_call, turn) => (turn === 0 ? { error: 'missing_structured_output' } : { output: { n: 3 } }),
    });
    const out = await exec(host, () => agent('a', { prompt: 'count', output: z.object({ n: z.number() }) }));
    expect(out).toEqual({ n: 3 });
    const call = host.engines.get('claude')?.calls[0];
    expect(call?.prompts[1]).toContain('without the structured result');
  });

  it('retries on the default model when the configured one is rejected', async () => {
    const host = testHost({
      script: (call) =>
        call.opts.model
          ? { error: "The 'sol-6.1' model is not supported when using Codex with a ChatGPT account." }
          : { text: 'done' },
    });
    const out = await exec(host, () => agent('a', { prompt: 'x', model: 'sol-6.1' }));
    expect(out).toBe('done');
    const calls = host.engines.get('claude')?.calls ?? [];
    expect(calls.map((c) => c.opts.model)).toEqual(['sol-6.1', null]);
    expect(host.events.some((e) => e.type === 'log' && e.message.includes('rejected model sol-6.1'))).toBe(true);
    expect(isModelRejected(new Error('rate limited'))).toBe(false);
    expect(isModelRejected(new Error('model_not_found'))).toBe(true);
  });

  it('tells writing agents how to run commands, not readers', async () => {
    const host = testHost();
    await exec(host, async () => {
      await agent('w', { prompt: 'x', system: 'Be brief.' });
      await agent('r', { prompt: 'y', mode: 'read' });
    });
    const [w, r] = host.engines.get('claude')?.calls ?? [];
    expect(w?.opts.systemPrompt).toContain('Never start them in the background');
    expect(w?.opts.systemPrompt).toContain('Be brief.');
    expect(r?.opts.systemPrompt ?? '').not.toContain('Running commands');
  });

  it('takes a slot from the session-wide agent limit for every agent', async () => {
    let active = 0;
    let peak = 0;
    const host = testHost();
    const slots = new Semaphore(2);
    host.acquireAgent = async () => {
      const release = await slots.acquire();
      active++;
      peak = Math.max(peak, active);
      return () => {
        active--;
        release();
      };
    };
    await exec(host, () => parallel([1, 2, 3, 4].map((n) => () => agent(`a${n}`, { prompt: 'x' }))));
    expect(peak).toBeLessThanOrEqual(2);
    expect(host.engines.get('claude')?.calls).toHaveLength(4);
  });

  it('cancellation stops before the next step', async () => {
    const controller = new AbortController();
    await expect(
      exec(
        testHost(),
        async () => {
          await step('one', async () => 1);
          controller.abort();
          await step('two', async () => 2);
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(WorkflowCancelled);
    expect(new Journal(dir).get('two')).toBeUndefined();
  });
});
