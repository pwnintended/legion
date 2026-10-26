import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, type FakeScript } from '../engine/fake/index.ts';
import type { EngineKind } from '../engine/types.ts';
import { agent, gate, group, loop, parallel, sh, step, z } from '../sdk/index.ts';
import type { GateAnswer, Interaction, RunEvent, RunHost } from './host.ts';
import { Journal } from './journal.ts';
import { executeInRun, WorkflowCancelled } from './runtime.ts';

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
  engines: Map<EngineKind, FakeEngine>;
  shCalls: string[];
}

function testHost(
  opts: { script?: FakeScript; gate?: (i: Interaction) => GateAnswer; profile?: string } = {},
): TestHost {
  const engines = new Map<EngineKind, FakeEngine>();
  const host: TestHost = {
    repo: dir,
    dryRun: false,
    maxAgents: 4,
    approvals: 'ask',
    events: [],
    interactions: [],
    engines,
    shCalls: [],
    engine(kind) {
      let engine = engines.get(kind);
      if (!engine) {
        engine = new FakeEngine(kind, opts.script, opts.profile ?? `${kind}-1`);
        engines.set(kind, engine);
      }
      return engine;
    },
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
      await group('g', () => agent('b', { engine: 'codex', prompt: 'y' }));
    });
    const calls = host.engines.get('claude')?.calls ?? [];
    expect(calls[0]?.opts).toMatchObject({ model: 'haiku', effort: null });
    expect(host.engines.get('codex')?.calls[0]?.opts).toMatchObject({ model: 'opus', effort: 'max' });
    expect(seen).toEqual([
      { key: 'a', step: 'a', engine: 'claude', model: 'haiku', effort: null },
      { key: 'b', step: 'g/b', engine: 'codex', model: null, effort: null },
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

  it('resumes an interrupted agent session on the same profile', async () => {
    const journal = new Journal(dir);
    journal.append({
      key: 'code',
      kind: 'agent',
      status: 'started',
      ts: 1,
      meta: { sessionId: 's-123', profile: 'claude-1', engine: 'claude' },
    });
    const host = testHost();
    await exec(host, () => agent('code', { prompt: 'build it' }));
    const call = host.engines.get('claude')?.calls[0];
    expect(call?.resumed).toBe(true);
    expect(call?.sessionId).toBe('s-123');
    expect(call?.prompts[0]).toContain('You were interrupted');
  });

  it('restarts an interrupted agent when the profile changed', async () => {
    const journal = new Journal(dir);
    journal.append({
      key: 'code',
      kind: 'agent',
      status: 'started',
      ts: 1,
      meta: { sessionId: 's-123', profile: 'claude-1', engine: 'claude' },
    });
    const host = testHost({ profile: 'claude-2' });
    await exec(host, () => agent('code', { prompt: 'build it' }));
    expect(host.engines.get('claude')?.calls[0]?.resumed).toBe(false);
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
