import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childEnv as claudeEnv } from '../engine/claude/args.ts';
import { childEnv as codexEnv } from '../engine/codex/config.ts';
import { type Attention, attention, HerdrReporter } from './herdr.ts';
import type { TeamRow, UiInteraction } from './store.ts';

const idle = { interactions: [] as UiInteraction[], team: [] as TeamRow[] };

describe('attention', () => {
  it('is blocked on what waits for the user, working while anything runs, idle otherwise', () => {
    const question: UiInteraction = {
      source: 'question',
      id: 'q',
      questions: [
        {
          id: 'a',
          header: null,
          question: 'Which branch?',
          options: [],
          multiSelect: false,
          allowOther: true,
          secret: false,
        },
      ],
    };
    expect(attention({ ...idle, interactions: [question] }, true, 2)).toEqual({
      state: 'blocked',
      message: 'Which branch?',
    });
    expect(attention(idle, true, 0).state).toBe('working');
    expect(attention(idle, false, 1).state).toBe('working');
    const lead = { status: 'working' } as TeamRow;
    expect(attention({ ...idle, team: [lead] }, false, 0).state).toBe('working');
    expect(attention(idle, false, 0)).toEqual({ state: 'idle', message: null });
  });
});

describe('HerdrReporter', () => {
  let now: Attention;
  let sent: [string, Record<string, unknown>][];
  let reporter: HerdrReporter;

  beforeEach(() => {
    vi.useFakeTimers();
    now = { state: 'idle', message: null };
    sent = [];
    reporter = new HerdrReporter(
      'w1:p1',
      async (method, params) => {
        sent.push([method, params]);
      },
      () => now,
      100,
    );
  });
  afterEach(() => vi.useRealTimers());

  const states = () => sent.map(([m, p]) => (m === 'pane.report_agent' ? p.state : m));

  it('reports changes only, and idle once it has settled', async () => {
    reporter.changed();
    now = { state: 'working', message: null };
    reporter.changed();
    reporter.changed();
    // A run finishes and the assistant picks it up right away: Herdr never sees the gap.
    now = { state: 'idle', message: null };
    reporter.changed();
    now = { state: 'working', message: null };
    reporter.changed();
    await vi.advanceTimersByTimeAsync(200);
    expect(states()).toEqual(['idle', 'working']);
    now = { state: 'idle', message: null };
    reporter.changed();
    await vi.advanceTimersByTimeAsync(200);
    expect(states()).toEqual(['idle', 'working', 'idle']);
    expect(sent[0]?.[1]).toMatchObject({ pane_id: 'w1:p1', source: 'legion', agent: 'legion' });
  });

  it('reports blocked at once with what is asked', async () => {
    now = { state: 'blocked', message: 'Approve the plan' };
    reporter.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([
      ['pane.report_agent', expect.objectContaining({ state: 'blocked', message: 'Approve the plan' })],
    ]);
  });

  it('releases the pane while paused and on close', async () => {
    now = { state: 'working', message: null };
    reporter.changed();
    reporter.pause();
    reporter.changed();
    reporter.resume();
    await reporter.close();
    expect(states()).toEqual(['working', 'pane.release_agent', 'working', 'pane.release_agent']);
    const seqs = sent.map(([, p]) => p.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('is only made inside a Herdr pane', () => {
    const read = () => now;
    expect(HerdrReporter.fromEnv(read, {})).toBeNull();
    expect(HerdrReporter.fromEnv(read, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })).toBeNull();
    expect(
      HerdrReporter.fromEnv(read, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/h.sock' }),
    ).toBeInstanceOf(HerdrReporter);
  });
});

describe('worker env', () => {
  it('leaves out Herdr pane variables so workers cannot claim the pane', () => {
    const parent = { PATH: '/bin', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/h.sock' };
    expect(claudeEnv(parent)).toEqual({ PATH: '/bin' });
    expect(codexEnv(parent, null, '/codex')).toEqual({ PATH: '/bin', CODEX_HOME: '/codex' });
  });
});
