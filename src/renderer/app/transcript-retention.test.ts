import type { Run } from '@shared/domain';
import type { AgentEvent, ServerEvent } from '@shared/events';
import type { TranscriptEntry } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../tiles/session/timeline';
import {
  applyEvents,
  applyRunList,
  applyTranscriptPage,
  beginTranscript,
  compactEntries,
  type DataState,
  initialData,
  MAX_TRANSCRIPT_ENTRIES,
  TRANSCRIPT_HEAD,
  transcriptEntries,
} from './data';

const entry = (seq: number, event: AgentEvent): TranscriptEntry => ({ seq, ts: seq, event });
const live = (seq: number, event: AgentEvent, attemptId = 'a', runId = 'run_a'): ServerEvent => ({
  seq,
  ts: seq,
  type: 'agent.event',
  runId,
  taskId: null,
  attemptId,
  event,
});

/** A long streaming session: a start, then many turns of streamed text with a tool call in between. */
function streamingSession(turns: number, deltasPerTurn: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [entry(1, { type: 'session_started', sessionId: 's', model: 'opus', version: '2' })];
  let seq = 2;
  for (let t = 0; t < turns; t++) {
    for (let d = 0; d < deltasPerTurn; d++) out.push(entry(seq++, { type: 'text_delta', text: `t${t}d${d} ` }));
    out.push(entry(seq++, { type: 'usage', inputTokens: t, outputTokens: t, costUsd: null }));
    out.push(
      entry(seq++, { type: 'tool_call', id: `c${t}`, name: 'Bash', input: { command: `step ${t}` }, kind: 'command' }),
    );
    out.push(entry(seq++, { type: 'tool_result', id: `c${t}`, ok: true, output: 'ok' }));
  }
  return out;
}

function feed(state: DataState, entries: readonly TranscriptEntry[]): DataState {
  let s = state;
  for (const e of entries) s = applyEvents(s, [live(e.seq, e.event)]);
  return s;
}

describe('transcript retention', () => {
  it('folds streamed text instead of dropping the start of a long session', () => {
    const session = streamingSession(200, 40); // ~8800 entries, well over the cap
    expect(session.length).toBeGreaterThan(MAX_TRANSCRIPT_ENTRIES);
    const s = feed(beginTranscript(initialData(), 'a'), session);
    const t = s.transcripts.a;
    if (!t) throw new Error('transcript missing');
    expect(t.count).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES);
    expect(t.dropped).toBe(0);
    // The session start survives, and the timeline reads exactly as it would from the full history.
    expect(transcriptEntries(t)[0]?.event.type).toBe('session_started');
    expect(buildTimeline(transcriptEntries(t)).rows).toEqual(buildTimeline(session).rows);
    expect(buildTimeline(transcriptEntries(t)).usage).toEqual(buildTimeline(session).usage);
  });

  it('trims only after the head when folding is not enough, and marks the gap', () => {
    const calls: TranscriptEntry[] = [];
    for (let seq = 1; seq <= MAX_TRANSCRIPT_ENTRIES + 1; seq++)
      calls.push(entry(seq, { type: 'tool_call', id: `c${seq}`, name: 'Read', input: {}, kind: 'other' }));
    const { entries, dropped, gap } = compactEntries(calls);
    expect(entries.length).toBeLessThan(MAX_TRANSCRIPT_ENTRIES);
    expect(entries.slice(0, TRANSCRIPT_HEAD).map((e) => e.seq)).toEqual(
      calls.slice(0, TRANSCRIPT_HEAD).map((e) => e.seq),
    );
    expect(entries.at(-1)?.seq).toBe(MAX_TRANSCRIPT_ENTRIES + 1);
    expect(dropped).toBe(MAX_TRANSCRIPT_ENTRIES + 1 - entries.length);
    expect(gap).toEqual({ from: TRANSCRIPT_HEAD + 1, to: TRANSCRIPT_HEAD + dropped });
  });

  it('does not re-add history it already holds in folded or trimmed form', () => {
    const session = streamingSession(200, 40);
    // Live events arrived first and were folded; then the history page (same seqs) lands.
    let s = feed(beginTranscript(initialData(), 'a'), session);
    const folded = s.transcripts.a;
    s = applyTranscriptPage(s, 'a', session.slice(0, 3000), false);
    s = applyTranscriptPage(s, 'a', session.slice(3000), true);
    const t = s.transcripts.a;
    if (!t || !folded) throw new Error('transcript missing');
    expect(t.status).toBe('ready');
    expect(buildTimeline(transcriptEntries(t)).rows).toEqual(buildTimeline(session).rows);
  });

  it('drops transcripts, activity and diff stats of runs that are gone', () => {
    const run = { id: 'run_b', status: 'done', createdAt: 1, updatedAt: 1 } as Run;
    let s = applyRunList(initialData(), [{ run, taskCounts: {}, openInbox: 0, costUsd: 0 }], 0);
    s = beginTranscript(s, 'b1');
    s = applyEvents(s, [
      live(1, { type: 'file_change', path: 'x.ts', added: 1, removed: 0 }, 'b1', 'run_b'),
      live(2, { type: 'message', text: 'hi' }, 'b1', 'run_b'),
    ]);
    expect(s.diffstats.b1).toBeDefined();
    expect(s.activity.b1).toBeDefined();
    // The run was archived elsewhere: the next run list no longer has it.
    s = applyRunList(s, [], 5);
    expect(s.diffstats.b1).toBeUndefined();
    expect(s.activity.b1).toBeUndefined();
    expect(s.transcripts.b1).toBeUndefined();
  });
});
