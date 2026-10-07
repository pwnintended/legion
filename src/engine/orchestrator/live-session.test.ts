import { type AgentEngine, type AgentSession, permissionProfileFor, type SessionOptions } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import { describe, expect, it } from 'vitest';
import { AsyncQueue, deferred } from '../util/async-queue';
import { AgentRun, type AgentRunHooks } from './live-session';

class StubSession implements AgentSession {
  readonly engine = 'claude' as const;
  readonly queue = new AsyncQueue<AgentEvent>();
  closed = false;
  constructor(readonly id: string) {}
  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }
  async send(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.push({ type: 'exited', code: 0 });
    this.queue.end();
  }
  async respond(): Promise<void> {}
}

const opts: SessionOptions = {
  role: 'coder',
  cwd: '/tmp',
  prompt: 'go',
  permission: permissionProfileFor('coder'),
  mcp: null,
  env: {},
};

function setup(canHandBack: () => boolean) {
  const first = new StubSession('s1');
  const resumed = new StubSession('s1');
  const gate = deferred<void>();
  const resumes: string[] = [];
  const engine: AgentEngine = {
    kind: 'claude',
    probe: async () => {
      throw new Error('unused');
    },
    start: async () => first,
    resume: async (id) => {
      resumes.push(id);
      await gate.promise;
      return resumed;
    },
  };
  const ended: AgentRun[] = [];
  const hooks: AgentRunHooks = {
    onEvent: () => undefined,
    onEnd: (run) => ended.push(run),
    onTakeover: () => undefined,
    canHandBack,
  };
  const run = new AgentRun(
    { id: 'a1', runId: 'r1', taskId: 't1', role: 'coder' },
    'claude',
    engine,
    first,
    opts,
    hooks,
  );
  run.start();
  return { run, first, resumed, gate, resumes, ended };
}

describe('takeover hand-back (review finding: race with cancel/archive)', () => {
  it('closes the resumed process when the run is closed while the resume is in flight', async () => {
    const { run, resumed, gate, resumes, ended } = setup(() => true);
    await run.beginTakeover();
    run.endTakeover();
    await new Promise((r) => setTimeout(r, 5));
    expect(resumes).toEqual(['s1']);
    await run.close(); // cancel / archive
    gate.resolve();
    expect(await run.nextTurn()).toMatchObject({ kind: 'exited' });
    expect(resumed.closed).toBe(true);
    expect(run.session).not.toBe(resumed);
    expect(ended).toEqual([run]);
  });

  it('does not resume when the run or task is no longer active, and flags the attempt', async () => {
    let active = true;
    const { run, resumes, gate, ended } = setup(() => active);
    await run.beginTakeover();
    active = false; // cancelled while the human was in the terminal
    run.endTakeover();
    gate.resolve();
    expect(await run.nextTurn()).toMatchObject({ kind: 'exited' });
    expect(resumes).toEqual([]);
    expect(run.handBackRefused).toBe(true);
    expect(ended).toEqual([run]);
  });

  it('re-checks after the resume resolves', async () => {
    let active = true;
    const { run, resumed, gate } = setup(() => active);
    await run.beginTakeover();
    run.endTakeover();
    await new Promise((r) => setTimeout(r, 5));
    active = false;
    gate.resolve();
    expect(await run.nextTurn()).toMatchObject({ kind: 'exited' });
    expect(resumed.closed).toBe(true);
    expect(run.handBackRefused).toBe(true);
  });
});
