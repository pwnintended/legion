import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../engine/types.ts';
import { TRANSCRIPT_ITEMS, Transcript, transcriptFromJournal } from './transcript.ts';

const complete: AgentEvent = { type: 'turn_complete', structuredOutput: null, isError: false, reason: null };
const call: AgentEvent = { type: 'tool_call', id: 'a', name: 'Read', input: { file_path: 'x.ts' }, kind: 'read' };
const contents = (transcript: Transcript) => transcript.items.map(({ id: _, ...item }) => item);
const journal = (event: AgentEvent) => JSON.stringify({ ts: 123, event });

describe('Transcript', () => {
  it('folds calls and accumulated file changes before the next reply', () => {
    const transcript = new Transcript();
    transcript.push({ type: 'text_delta', text: 'Looking.' });
    transcript.push(call);
    expect(transcript.streaming).toBe('');
    expect(transcript.activity).toBe('Read x.ts');
    transcript.push({ type: 'tool_result', id: 'a', ok: false, output: 'failed\nmore' });
    transcript.push({ type: 'file_change', path: 'x.ts', added: 2, removed: 1 });
    transcript.push({ type: 'file_change', path: 'x.ts', added: 3, removed: 0 });
    transcript.push({ type: 'message', text: ' Done. ' });
    transcript.push(complete);
    expect(contents(transcript)).toEqual([
      { type: 'assistant', text: 'Looking.' },
      {
        type: 'tools',
        calls: [{ tool: 'Read', line: 'Read x.ts', ok: false, error: 'failed' }],
        files: [{ path: 'x.ts', added: 5, removed: 1 }],
      },
      { type: 'assistant', text: 'Done.' },
    ]);
    expect(transcript.activity).toBeNull();
  });

  it('keeps only the latest items with unique increasing ids', () => {
    const transcript = new Transcript();
    for (let i = 0; i < TRANSCRIPT_ITEMS + 5; i++) transcript.push({ type: 'message', text: String(i) });
    expect(transcript.items).toHaveLength(TRANSCRIPT_ITEMS);
    expect(transcript.items[0]).toEqual({ id: 6, type: 'assistant', text: '5' });
    expect(new Set(transcript.items.map((item) => item.id)).size).toBe(TRANSCRIPT_ITEMS);
  });

  it('shows reasoning and replaces streamed text with the final message', () => {
    const transcript = new Transcript();
    expect(transcript.push({ type: 'reasoning', text: 'Considering.' })).toBe(true);
    expect(transcript.push({ type: 'text_delta', text: 'Draft' })).toBe(true);
    expect(transcript.streaming).toBe('Draft');
    transcript.push({ type: 'message', text: 'Final' });
    transcript.push(complete);
    expect(transcript.streaming).toBe('');
    expect(contents(transcript)).toEqual([
      { type: 'reasoning', text: 'Considering.' },
      { type: 'assistant', text: 'Final' },
    ]);
  });

  it('flushes unfinished streaming and tools at turn completion and shows failures', () => {
    const transcript = new Transcript();
    transcript.push(call);
    transcript.push({ type: 'text_delta', text: 'Partial' });
    transcript.push(complete);
    expect(transcript.items.map((item) => item.type)).toEqual(['tools', 'assistant']);
    expect(transcript.push({ type: 'error', message: 'retry', retryable: true })).toBe(false);
    transcript.push({ type: 'error', message: 'broken', retryable: false });
    transcript.push({ ...complete, isError: true, reason: 'failed' });
    expect(contents(transcript).slice(-2)).toEqual([
      { type: 'error', text: 'broken' },
      { type: 'error', text: 'Turn failed: failed' },
    ]);
  });

  it('ignores envelopes and reports changes to activity', () => {
    const transcript = new Transcript();
    expect(transcript.push({ type: 'subagent_event', id: 'child', event: { type: 'message', text: 'hidden' } })).toBe(
      false,
    );
    const activity = { type: 'activity', activity: 'thinking', tool: null, chars: 0 } as const;
    expect(transcript.push(activity)).toBe(true);
    expect(transcript.push(activity)).toBe(false);
    expect(transcript.items).toEqual([]);
  });

  it('displays tool input activity live and from a journal', () => {
    const event: AgentEvent = {
      type: 'activity',
      activity: 'tool_input',
      tool: 'mcp__legion__run_workflow',
      chars: 12,
    };
    const transcript = new Transcript();
    expect(transcript.push(event)).toBe(true);
    expect(transcript.activity).toBe('writing legion.run_workflow');
    expect(transcript.push(event)).toBe(false);
    expect(transcriptFromJournal(journal(event)).activity).toBe('writing legion.run_workflow');
  });

  it('replays only the owner or selected subagent, skipping malformed records', () => {
    const text = [
      journal({ type: 'message', text: 'Parent' }),
      journal({ type: 'subagent_event', id: 'child', event: call }),
      'null',
      '{"ts":1,"event":{"type":"message","text":42}}',
      journal({ type: 'subagent_event', id: 'other', event: { type: 'message', text: 'Other' } }),
      journal({ type: 'subagent_event', id: 'child', event: { type: 'message', text: 'Child' } }),
      journal(complete),
      '{"ts":',
    ].join('\n');
    expect(contents(transcriptFromJournal(text))).toEqual([{ type: 'assistant', text: 'Parent' }]);
    expect(contents(transcriptFromJournal(text, 'child'))).toEqual([
      { type: 'tools', calls: [{ tool: 'Read', line: 'Read x.ts', ok: null, error: null }], files: [] },
      { type: 'assistant', text: 'Child' },
    ]);
    expect(transcriptFromJournal(text, 'missing').items).toEqual([]);
  });
});
