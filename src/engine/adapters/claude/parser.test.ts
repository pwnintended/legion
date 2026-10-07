import { join } from 'node:path';
import type { AgentEvent, AgentEventOf } from '@shared/events';
import { ClarifyOutputSchema } from '@shared/schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser, classifyTool, LineBuffer, type ParserOptions, type ParserOutput } from './parser';
import { fixtureSessionId, loadFixture } from './testing';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const CWD = '/tmp/legion-fixture';

function parseFixture(name: string, opts: Partial<ParserOptions> = {}, interruptAfterIn = false): ParserOutput[] {
  const parser = new ClaudeStreamParser({ cwd: CWD, structuredOutput: false, ...opts });
  const outputs: ParserOutput[] = [];
  for (const line of loadFixture(join(FIXTURES, name))) {
    if (line.dir === 'in' && 'msg' in line && line.msg.type === 'control_request' && interruptAfterIn) {
      parser.noteInterrupt();
    }
    if (line.dir === 'out') outputs.push(...parser.handleLine(JSON.stringify(line.msg)));
  }
  return outputs;
}

const initSessionId = (name: string) => fixtureSessionId(loadFixture(join(FIXTURES, name)));

const eventsOf = (outputs: ParserOutput[]): AgentEvent[] =>
  outputs.flatMap((o) => (o.kind === 'event' ? [o.event] : []));
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

describe('ClaudeStreamParser (recorded fixtures)', () => {
  it('plain answer: session_started, deltas, message, usage, rate limits, turn_complete', () => {
    const events = eventsOf(parseFixture('plain.jsonl'));
    expect(events[0]).toEqual({
      type: 'session_started',
      sessionId: initSessionId('plain.jsonl'),
      model: 'claude-haiku-4-5-20251001',
      version: '2.1.289',
    });
    expect(
      of(events, 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('OK');
    expect(of(events, 'message')).toEqual([{ type: 'message', text: 'OK' }]);
    expect(of(events, 'reasoning')).toEqual([]); // haiku's thinking is redacted (empty text)
    const [usage] = of(events, 'usage');
    expect(usage?.costUsd).toBeGreaterThan(0);
    expect(usage?.inputTokens).toBeGreaterThan(1000); // includes cache reads/creation
    expect(of(events, 'rate_limit').map((e) => e.window)).toEqual(['5h', 'weekly']);
    for (const limit of of(events, 'rate_limit')) {
      expect(limit.engine).toBe('claude');
      expect(limit.resetsAt).toBeGreaterThan(1_700_000_000_000); // ms, not s
    }
    expect(events.at(-1)).toEqual({ type: 'turn_complete', structuredOutput: null, isError: false, reason: null });
  });

  it('Read tool: tool_call(kind read) paired with its tool_result', () => {
    const events = eventsOf(parseFixture('read.jsonl'));
    const [call] = of(events, 'tool_call');
    expect(call).toMatchObject({ name: 'Read', kind: 'read', input: { file_path: `${CWD}/hello.txt` } });
    const [result] = of(events, 'tool_result');
    expect(result).toMatchObject({ id: call?.id, ok: true });
    expect(result?.output).toContain('PAPAYA');
    expect(of(events, 'message').at(-1)?.text).toBe('PAPAYA');
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete', isError: false });
  });

  it('structured output: hidden StructuredOutput tool, payload on turn_complete', () => {
    const events = eventsOf(parseFixture('structured.jsonl', { structuredOutput: true }));
    expect(of(events, 'tool_call')).toEqual([]);
    expect(of(events, 'tool_result')).toEqual([]);
    const done = events.at(-1);
    if (done?.type !== 'turn_complete') throw new Error('expected turn_complete');
    expect(done.isError).toBe(false);
    expect(ClarifyOutputSchema.parse(done.structuredOutput).questions[0]?.id).toBe('q1');
  });

  it('approval: Write → file_change, then can_use_tool for Bash, denied result', () => {
    const outputs = parseFixture('approval-denied.jsonl');
    const events = eventsOf(outputs);
    expect(of(events, 'tool_call').map((e) => [e.name, e.kind])).toEqual([
      ['Write', 'edit'],
      ['Bash', 'command'],
    ]);
    expect(of(events, 'file_change')).toEqual([{ type: 'file_change', path: 'notes.txt', added: 1, removed: 0 }]);
    const permission = outputs.find((o) => o.kind === 'permission');
    if (permission?.kind !== 'permission') throw new Error('expected a permission request');
    expect(permission.request.toolName).toBe('Bash');
    expect(permission.request.toolUseId).toBe(of(events, 'tool_call')[1]?.id);
    expect(permission.request.suggestions.length).toBeGreaterThan(0);
    const denied = of(events, 'tool_result').at(-1);
    expect(denied).toMatchObject({ ok: false, output: 'Not allowed by Legion.' });
    expect(of(events, 'message').at(-1)?.text).toBe('DENIED');
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete', isError: false });
  });

  it('interrupt: control_response for our request, interrupted turn, then a normal turn', () => {
    const outputs = parseFixture('interrupt.jsonl', {}, true);
    expect(outputs).toContainEqual({
      kind: 'control_response',
      requestId: 'legion-interrupt-1',
      ok: true,
      response: { still_queued: [] },
      error: null,
    });
    const events = eventsOf(outputs);
    expect(of(events, 'session_started')).toHaveLength(1); // init is repeated per turn
    const turns = of(events, 'turn_complete');
    expect(turns).toEqual([
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'interrupted' },
      { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
    ]);
    expect(of(events, 'error')).toEqual([]);
  });

  it('interrupt is recognised from terminal_reason even without noteInterrupt', () => {
    const events = eventsOf(parseFixture('interrupt.jsonl'));
    expect(of(events, 'turn_complete')[0]?.reason).toBe('interrupted');
  });

  it('resume: cumulative usage, same session id', () => {
    const first = of(eventsOf(parseFixture('plain.jsonl')), 'usage')[0];
    const events = eventsOf(parseFixture('resume.jsonl'));
    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: initSessionId('plain.jsonl') });
    const resumed = of(events, 'usage')[0];
    expect(resumed?.outputTokens).toBeGreaterThan(first?.outputTokens ?? 0);
    expect(resumed?.costUsd).toBeGreaterThan(first?.costUsd ?? 0);
    expect(of(events, 'message').at(-1)?.text).toBe('ZEBRA-17');
  });

  it('MCP: ToolSearch + mcp__legion__echo classified as mcp', () => {
    const events = eventsOf(parseFixture('mcp.jsonl'));
    const calls = of(events, 'tool_call');
    expect(calls.map((e) => [e.name, e.kind])).toEqual([
      ['ToolSearch', 'other'],
      ['mcp__legion__echo', 'mcp'],
    ]);
    const echo = of(events, 'tool_result').find((e) => e.id === calls[1]?.id);
    expect(echo).toMatchObject({ ok: true, output: 'ECHO:hi' });
  });
});

describe('ClaudeStreamParser (synthetic)', () => {
  const parser = (structuredOutput = false) => new ClaudeStreamParser({ cwd: CWD, structuredOutput });
  const result = (extra: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } },
    ...extra,
  });
  const events = (p: ClaudeStreamParser, msg: unknown) => eventsOf(p.handle(msg));

  it('classifies tools', () => {
    expect(classifyTool('Grep')).toBe('read');
    expect(classifyTool('MultiEdit')).toBe('edit');
    expect(classifyTool('NotebookEdit')).toBe('edit');
    expect(classifyTool('Bash')).toBe('command');
    expect(classifyTool('mcp__legion__report_progress')).toBe('mcp');
    expect(classifyTool('WebFetch')).toBe('other');
  });

  it('reports activity for thinking and structured output that streams without visible text', () => {
    const p = parser(true);
    const stream = (event: Record<string, unknown>) => events(p, { type: 'stream_event', event });
    expect(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ).toEqual([{ type: 'activity', activity: 'thinking', tool: null, chars: 0 }]);
    expect(
      stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(1500) } }),
    ).toEqual([]);
    expect(
      stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(600) } }),
    ).toEqual([{ type: 'activity', activity: 'thinking', tool: null, chars: 2100 }]);
    expect(stream({ type: 'content_block_stop', index: 0 })).toEqual([]);
    expect(
      stream({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'StructuredOutput' } }),
    ).toEqual([{ type: 'activity', activity: 'output', tool: null, chars: 0 }]);
    expect(
      stream({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{'.repeat(2000) } }),
    ).toEqual([{ type: 'activity', activity: 'output', tool: null, chars: 2000 }]);
    expect(
      stream({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't2', name: 'Write' } }),
    ).toEqual([{ type: 'activity', activity: 'tool_input', tool: 'Write', chars: 0 }]);
    // Text blocks and subagent streams stay as they were.
    expect(stream({ type: 'content_block_start', content_block: { type: 'text', text: '' } })).toEqual([]);
    expect(
      events(p, {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_x',
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      }),
    ).toEqual([]);
  });

  it('sums usage over models and reports cost', () => {
    expect(events(parser(), result({}))[0]).toEqual({ type: 'usage', inputTokens: 8, outputTokens: 2, costUsd: 0.01 });
  });

  it('skips zeroed usage (interrupted turns)', () => {
    const out = events(parser(), result({ total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0 } }));
    expect(out.map((e) => e.type)).toEqual(['turn_complete']);
  });

  it('treats a missing structured_output as a retryable error when a schema was requested', () => {
    const out = events(parser(true), result({}));
    expect(out.slice(1)).toEqual([
      { type: 'error', message: 'The turn ended without structured output', retryable: true },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'missing_structured_output' },
    ]);
  });

  it('reports error_max_structured_output_retries as a retryable error', () => {
    const out = events(
      parser(true),
      result({ subtype: 'error_max_structured_output_retries', is_error: true, errors: ['schema mismatch'] }),
    );
    expect(out.slice(1)).toEqual([
      { type: 'error', message: 'schema mismatch', retryable: true },
      {
        type: 'turn_complete',
        structuredOutput: null,
        isError: true,
        reason: 'error_max_structured_output_retries',
      },
    ]);
  });

  it('reports API errors with retryability from the status', () => {
    const out = events(parser(), result({ is_error: true, api_error_status: 529, result: 'API Error: overloaded' }));
    expect(out.slice(1)).toEqual([
      { type: 'error', message: 'API Error: overloaded', retryable: true },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'api_error_529' },
    ]);
    const fatal = events(parser(), result({ subtype: 'error_max_turns', is_error: true }));
    expect(fatal[1]).toEqual({ type: 'error', message: 'error_max_turns', retryable: false });
  });

  it('maps api_retry to a retryable error', () => {
    const out = events(parser(), {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 529,
      error: 'overloaded',
    });
    expect(out).toEqual([{ type: 'error', message: 'API retry 1/10 (overloaded)', retryable: true }]);
  });

  it('maps a rejected rate limit without windows to 100%', () => {
    const out = events(parser(), {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1_800_000_000 },
    });
    expect(out).toEqual([
      { type: 'rate_limit', engine: 'claude', window: 'seven_day_opus', usedPct: 100, resetsAt: 1_800_000_000_000 },
    ]);
  });

  it('turns TodoWrite into todo items', () => {
    const out = events(parser(), {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'a', status: 'completed', activeForm: 'A' },
                { content: 'b', status: 'in_progress', activeForm: 'B' },
              ],
            },
          },
        ],
      },
    });
    expect(out[1]).toEqual({
      type: 'todo',
      items: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'in_progress' },
      ],
    });
  });

  it('tracks TaskCreate / TaskUpdate as a todo list', () => {
    const p = parser();
    const toolUse = (id: string, name: string, input: unknown) => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    const toolResult = (id: string, toolUseResult: unknown) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      tool_use_result: toolUseResult,
    });
    p.handle(toolUse('c1', 'TaskCreate', { subject: 'Write tests', description: '' }));
    expect(events(p, toolResult('c1', { task: { id: '1', subject: 'Write tests' } })).at(-1)).toEqual({
      type: 'todo',
      items: [{ text: 'Write tests', status: 'pending' }],
    });
    expect(events(p, toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })).at(-1)).toEqual({
      type: 'todo',
      items: [{ text: 'Write tests', status: 'completed' }],
    });
  });

  it('derives file changes from Edit structuredPatch', () => {
    const p = parser();
    p.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }] } });
    const out = events(p, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
      tool_use_result: {
        filePath: `${CWD}/src/a.ts`,
        structuredPatch: [{ lines: [' ctx', '-old', '+new', '+new2'] }],
      },
    });
    expect(out[1]).toEqual({ type: 'file_change', path: 'src/a.ts', added: 2, removed: 1 });
  });

  it('ignores subagent text but keeps its tool calls', () => {
    const out = events(parser(), {
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      message: {
        content: [
          { type: 'text', text: 'sub' },
          { type: 'tool_use', id: 's1', name: 'Grep', input: {} },
        ],
      },
    });
    expect(out).toEqual([{ type: 'tool_call', id: 's1', name: 'Grep', input: {}, kind: 'read' }]);
  });

  it('truncates long tool output', () => {
    const p = parser();
    const [result] = events(p, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'y'.repeat(20_000) }] }],
      },
    });
    expect(result?.type === 'tool_result' && result.output?.length).toBeLessThan(16_100);
  });

  it('surfaces control frames and unknown types', () => {
    const p = parser();
    expect(p.handle({ type: 'control_cancel_request', request_id: 'r1' })).toEqual([
      { kind: 'control_cancel', requestId: 'r1' },
    ]);
    expect(p.handle({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } })).toEqual([
      { kind: 'control_request', requestId: 'r2', subtype: 'hook_callback', request: { subtype: 'hook_callback' } },
    ]);
    expect(p.handle({ type: 'brand_new_thing' })).toEqual([{ kind: 'unknown', type: 'brand_new_thing' }]);
    expect(p.handle({ type: 'keep_alive' })).toEqual([]);
    expect(p.handleLine('not json')).toEqual([]);
  });
});

describe('LineBuffer', () => {
  it('splits chunks on newlines and keeps the remainder', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(buffer.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(buffer.flush()).toEqual(['{"c":3}']);
    expect(buffer.flush()).toEqual([]);
  });
});
