import type { AgentEvent } from '@shared/events';
import type { TranscriptEntry } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { buildTimeline, commandText, splitMcpName } from './timeline';

const entries = (events: AgentEvent[]): TranscriptEntry[] =>
  events.map((event, i) => ({ seq: 10 + i, ts: 1000 + i, event }));

describe('buildTimeline', () => {
  it('streams text deltas into one row and replaces them with the final message', () => {
    const streaming = buildTimeline(
      entries([
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
      ]),
    );
    expect(streaming.rows).toEqual([{ kind: 'text', key: 10, text: 'Hello', streaming: true }]);
    expect(streaming.streaming).toBe(true);

    const done = buildTimeline(
      entries([
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'message', text: 'Hello.' },
      ]),
    );
    expect(done.rows).toEqual([{ kind: 'text', key: 10, text: 'Hello.', streaming: false }]);
    expect(done.streaming).toBe(false);
  });

  it('collapses consecutive reads and keeps keys stable', () => {
    const t = buildTimeline(
      entries([
        { type: 'tool_call', id: 'a', name: 'Read', input: { file_path: 'a.ts' }, kind: 'read' },
        { type: 'tool_result', id: 'a', ok: true, output: null },
        { type: 'tool_call', id: 'b', name: 'Read', input: { file_path: 'b.ts' }, kind: 'read' },
        { type: 'tool_call', id: 'c', name: 'Grep', input: { pattern: 'useX' }, kind: 'read' },
        { type: 'tool_result', id: 'c', ok: false, output: 'boom' },
        { type: 'message', text: 'ok' },
        { type: 'tool_call', id: 'd', name: 'Read', input: { file_path: 'd.ts' }, kind: 'read' },
      ]),
    );
    expect(t.rows.map((r) => r.kind)).toEqual(['reads', 'text', 'reads']);
    expect(t.rows[0]).toEqual({ kind: 'reads', key: 10, paths: ['a.ts', 'b.ts', 'useX'], failed: 1 });
  });

  it('attaches results to commands and file changes to edits', () => {
    const t = buildTimeline(
      entries([
        { type: 'tool_call', id: 'e', name: 'Edit', input: { file_path: 'x.ts' }, kind: 'edit' },
        { type: 'file_change', path: 'x.ts', added: 3, removed: 1 },
        { type: 'file_change', path: 'y.ts', added: 5, removed: 0 },
        { type: 'tool_call', id: 'c', name: 'Bash', input: { command: 'pnpm test' }, kind: 'command' },
        { type: 'tool_result', id: 'c', ok: false, output: '1 failed' },
      ]),
    );
    expect(t.rows).toEqual([
      { kind: 'edit', key: 10, path: 'x.ts', added: 3, removed: 1, status: 'ok' },
      { kind: 'edit', key: 12, path: 'y.ts', added: 5, removed: 0, status: 'ok' },
      { kind: 'command', key: 13, command: 'pnpm test', status: 'failed', output: '1 failed' },
    ]);
  });

  it('keeps only the latest todo snapshot and summarizes usage', () => {
    const t = buildTimeline(
      entries([
        { type: 'todo', items: [{ text: 'a', status: 'in_progress' }] },
        { type: 'message', text: 'working' },
        { type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
        { type: 'todo', items: [{ text: 'a', status: 'completed' }] },
        { type: 'usage', inputTokens: 20, outputTokens: 4, costUsd: 0.02 },
      ]),
    );
    expect(t.rows.map((r) => r.kind)).toEqual(['text', 'todo']);
    expect(t.usage).toEqual({ inputTokens: 20, outputTokens: 4, costUsd: 0.02 });
  });

  it('labels MCP calls, approvals, turns and exits', () => {
    const t = buildTimeline(
      entries([
        { type: 'session_started', sessionId: 's', model: 'opus', version: '2' },
        {
          type: 'tool_call',
          id: 'm',
          name: 'mcp__legion__report_progress',
          input: { summary: 'half way' },
          kind: 'mcp',
        },
        { type: 'approval_request', requestId: 'r', tool: 'Bash', input: { command: 'rm -rf x' }, reason: null },
        { type: 'text_delta', text: 'cut off' },
        { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'max_turns' },
        { type: 'exited', code: 1 },
      ]),
    );
    expect(t.model).toBe('opus');
    expect(t.rows.map((r) => r.kind)).toEqual(['start', 'mcp', 'approval', 'text', 'turn', 'exited']);
    expect(t.rows[1]).toMatchObject({ server: 'legion', tool: 'report_progress', summary: 'half way' });
    expect(t.rows[3]).toMatchObject({ streaming: false });
  });
});

describe('helpers', () => {
  it('unwraps Codex argv commands', () => {
    expect(commandText({ command: ['bash', '-lc', 'pnpm test'] })).toBe('pnpm test');
    expect(commandText({ command: ['rg', '-n', 'x'] })).toBe('rg -n x');
    expect(commandText({ command: 'ls' })).toBe('ls');
  });
  it('splits MCP tool names', () => {
    expect(splitMcpName('mcp__legion__mark_task_done')).toEqual({ server: 'legion', tool: 'mark_task_done' });
    expect(splitMcpName('github.search')).toEqual({ server: 'github', tool: 'search' });
  });
});
