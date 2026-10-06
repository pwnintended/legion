import type { ApprovalDecision } from '@shared/engine';
import { type AgentEvent, AgentEventSchema } from '@shared/events';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CWD, FIXTURES, type FixtureName, loadFixture } from './fixtures';
import type { ServerNotification, ServerRequest } from './methods';
import {
  approvalResponse,
  CodexNormalizer,
  countChange,
  countUnifiedDiff,
  displayCommand,
  unwrapShell,
} from './normalize';

function replay(name: FixtureName, structuredOutput = false): AgentEvent[] {
  const normalizer = new CodexNormalizer({ cwd: FIXTURE_CWD, structuredOutput });
  const events: AgentEvent[] = [];
  for (const { dir, msg } of loadFixture(name)) {
    if (dir !== 'in' || msg.method === undefined) continue;
    if (msg.id !== undefined) {
      const event = normalizer.approvalRequest(msg as unknown as ServerRequest);
      if (event) events.push(event);
    } else {
      events.push(...normalizer.handle(msg as unknown as ServerNotification));
    }
  }
  return events;
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const without = (events: AgentEvent[], ...drop: AgentEvent['type'][]) => events.filter((e) => !drop.includes(e.type));
const n = (method: string, params: unknown) => ({ method, params }) as unknown as ServerNotification;

describe('fixtures → AgentEvents', () => {
  it.each(FIXTURES)('%s produces schema-valid events ending in turn_complete', (name) => {
    const events = replay(name, name === 'structured');
    for (const event of events) expect(AgentEventSchema.safeParse(event).success).toBe(true);
    expect(events.at(-1)?.type).toBe('turn_complete');
  });

  it('plain answer', () => {
    const events = replay('plain');
    expect(without(events, 'usage', 'rate_limit')).toEqual([
      { type: 'text_delta', text: 'pong' },
      { type: 'message', text: 'pong' },
      { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 14303,
      outputTokens: 5,
      costUsd: null,
    });
    expect(events.filter((e) => e.type === 'rate_limit')).toEqual([
      { type: 'rate_limit', engine: 'codex', window: 'weekly', usedPct: 75, resetsAt: 1791752611000 },
    ]);
  });

  it('command execution', () => {
    const events = without(replay('command'), 'usage', 'rate_limit', 'text_delta');
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ name: 'shell', kind: 'command', input: { command: 'ls', cwd: '.' } });
    expect(events.find((e) => e.type === 'tool_result')).toEqual({
      type: 'tool_result',
      id: call?.type === 'tool_call' ? call.id : '',
      ok: true,
      output: 'exit 0\nREADME.md\n',
    });
    expect(events.at(-2)).toEqual({ type: 'message', text: '1' });
  });

  it('file change with per-path counts', () => {
    const events = replay('filechange');
    const edit = events.find((e) => e.type === 'tool_call' && e.kind === 'edit');
    expect(edit).toMatchObject({
      name: 'apply_patch',
      input: {
        changes: [
          { path: 'README.md', kind: 'update' },
          { path: 'hello.txt', kind: 'add' },
        ],
      },
    });
    expect(events.filter((e) => e.type === 'file_change')).toEqual([
      { type: 'file_change', path: 'README.md', added: 1, removed: 0 },
      { type: 'file_change', path: 'hello.txt', added: 1, removed: 0 },
    ]);
  });

  it('structured output is parsed from the final message', () => {
    expect(replay('structured', true).at(-1)).toEqual({
      type: 'turn_complete',
      structuredOutput: { sum: 5, greeting: 'Hello' },
      isError: false,
      reason: null,
    });
  });

  it('approval request (declined)', () => {
    const events = without(replay('approval'), 'usage', 'rate_limit', 'text_delta', 'message');
    expect(types(events)).toEqual(['tool_call', 'approval_request', 'tool_result', 'turn_complete']);
    expect(events[1]).toEqual({
      type: 'approval_request',
      requestId: '0',
      tool: 'shell',
      input: { command: 'curl -sS -o /dev/null -w "%{http_code}" https://example.com', cwd: '.' },
      reason: 'Allow this command to access the network?',
    });
    expect(events[2]).toMatchObject({ type: 'tool_result', ok: false, output: 'declined' });
  });

  it('interrupt closes the dangling command', () => {
    const events = without(replay('interrupt'), 'usage', 'rate_limit', 'text_delta', 'message');
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_call', input: { command: 'sleep 20', cwd: '.' } }),
      expect.objectContaining({ type: 'tool_result', ok: false, output: 'interrupted' }),
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'interrupted' },
    ]);
  });

  it('steer + follow-up turn', () => {
    const events = replay('steer');
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.text : ''))).toEqual(
      expect.arrayContaining(['second', 'third']),
    );
  });

  it('MCP tool call', () => {
    const events = replay('mcp');
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({
      name: 'mcp__legion__report_progress',
      kind: 'mcp',
      input: { summary: 'hello from codex' },
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, output: '{"ok":true}' });
  });

  it('resumed thread', () => {
    expect(replay('resume').filter((e) => e.type === 'message')).toEqual([{ type: 'message', text: 'zebra' }]);
  });
});

describe('synthetic notifications', () => {
  it('plan updates → todo', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    expect(
      normalizer.handle(
        n('turn/plan/updated', {
          threadId: 't',
          turnId: 'u',
          explanation: null,
          plan: [
            { step: 'read', status: 'completed' },
            { step: 'edit', status: 'inProgress' },
            { step: 'test', status: 'pending' },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'todo',
        items: [
          { text: 'read', status: 'completed' },
          { text: 'edit', status: 'in_progress' },
          { text: 'test', status: 'pending' },
        ],
      },
    ]);
  });

  it('reasoning summary', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    const item = { type: 'reasoning', id: 'r', summary: ['First.', 'Second.'], content: [] };
    expect(normalizer.handle(n('item/completed', { item, threadId: 't', turnId: 'u', completedAtMs: 0 }))).toEqual([
      { type: 'reasoning', text: 'First.\n\nSecond.' },
    ]);
    const empty = { ...item, summary: [] };
    expect(
      normalizer.handle(n('item/completed', { item: empty, threadId: 't', turnId: 'u', completedAtMs: 0 })),
    ).toEqual([]);
  });

  it('errors and failed turns', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    const error = { message: 'Rate limited', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null };
    expect(normalizer.handle(n('turn/started', { threadId: 't', turn: { id: 'u' } }))).toEqual([]);
    expect(normalizer.handle(n('error', { error, willRetry: false, threadId: 't', turnId: 'u' }))).toEqual([
      { type: 'error', message: 'Rate limited', retryable: true },
    ]);
    expect(
      normalizer.handle(n('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error, items: [] } })),
    ).toEqual([{ type: 'turn_complete', structuredOutput: null, isError: true, reason: 'Rate limited' }]);

    const other = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    const fatal = { message: 'Bad', codexErrorInfo: 'unauthorized', additionalDetails: 'log in' };
    expect(
      other.handle(
        n('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error: fatal, items: [] } }),
      ),
    ).toEqual([
      { type: 'error', message: 'Bad (log in)', retryable: false },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'Bad (log in)' },
    ]);
  });

  it('invalid structured output fails the turn (retryable)', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: true });
    const item = { type: 'agentMessage', id: 'm', text: 'not json', phase: 'final_answer' };
    normalizer.handle(n('item/completed', { item, threadId: 't', turnId: 'u', completedAtMs: 0 }));
    expect(
      normalizer.handle(n('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed', error: null } })),
    ).toEqual([
      { type: 'error', message: 'structured output is not valid JSON', retryable: true },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'structured output is not valid JSON' },
    ]);
  });

  it('structured output tolerates a ```json fence', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: true });
    const item = { type: 'agentMessage', id: 'm', text: '```json\n{"a":1}\n```', phase: 'final_answer' };
    normalizer.handle(n('item/completed', { item, threadId: 't', turnId: 'u', completedAtMs: 0 }));
    expect(
      normalizer.handle(n('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed', error: null } })),
    ).toEqual([{ type: 'turn_complete', structuredOutput: { a: 1 }, isError: false, reason: null }]);
  });

  it('dedupes unchanged rate limits and labels windows', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    const snapshot = {
      limitId: 'codex',
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: null },
    };
    expect(normalizer.handle(n('account/rateLimits/updated', { rateLimits: snapshot }))).toEqual([
      { type: 'rate_limit', engine: 'codex', window: '5h', usedPct: 10, resetsAt: 100_000 },
      { type: 'rate_limit', engine: 'codex', window: 'weekly', usedPct: 50, resetsAt: null },
    ]);
    expect(normalizer.handle(n('account/rateLimits/updated', { rateLimits: snapshot }))).toEqual([]);
    const other = { ...snapshot, limitId: 'gpt-6', secondary: null };
    expect(normalizer.handle(n('account/rateLimits/updated', { rateLimits: other }))).toEqual([
      { type: 'rate_limit', engine: 'codex', window: 'gpt-6:5h', usedPct: 10, resetsAt: 100_000 },
    ]);
  });

  it('abortTurn closes open calls', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    const item = {
      type: 'mcpToolCall',
      id: 'c1',
      server: 'legion',
      tool: 'approve',
      arguments: {},
      status: 'inProgress',
    };
    expect(normalizer.handle(n('item/started', { item, threadId: 't', turnId: 'u', startedAtMs: 0 }))).toHaveLength(1);
    expect(normalizer.abortTurn('exited')).toEqual([
      { type: 'tool_result', id: 'c1', ok: false, output: 'exited' },
      { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'exited' },
    ]);
  });

  it('ignores notifications it does not map', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    expect(normalizer.handle(n('mcpServer/startupStatus/updated', { name: 'legion', status: 'ready' }))).toEqual([]);
    expect(normalizer.handle(n('hook/started', {}))).toEqual([]);
  });
});

describe('approvals', () => {
  const allowOnce: ApprovalDecision = { behavior: 'allow', scope: 'once', updatedInput: null };
  const allowSession: ApprovalDecision = { behavior: 'allow', scope: 'session', updatedInput: null };
  const deny: ApprovalDecision = { behavior: 'deny', message: 'no', interrupt: false };
  const cancel: ApprovalDecision = { behavior: 'deny', message: 'stop', interrupt: true };
  const req = (method: string, params: unknown) => ({ id: 3, method, params }) as unknown as ServerRequest;

  it('command / file change decisions', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      const request = req(method, {});
      expect(approvalResponse(request, allowOnce)).toEqual({ decision: 'accept' });
      expect(approvalResponse(request, allowSession)).toEqual({ decision: 'acceptForSession' });
      expect(approvalResponse(request, deny)).toEqual({ decision: 'decline' });
      expect(approvalResponse(request, cancel)).toEqual({ decision: 'cancel' });
    }
  });

  it('permissions, user input, elicitation and legacy decisions', () => {
    const permissions = req('item/permissions/requestApproval', {
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    expect(approvalResponse(permissions, allowSession)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
    expect(approvalResponse(permissions, deny)).toEqual({ permissions: {}, scope: 'turn' });

    const input = req('item/tool/requestUserInput', { questions: [] });
    expect(approvalResponse(input, { ...allowOnce, updatedInput: { q1: 'yes', q2: ['a', 'b'] } })).toEqual({
      answers: { q1: { answers: ['yes'] }, q2: { answers: ['a', 'b'] } },
    });
    expect(approvalResponse(input, { ...allowOnce, updatedInput: { answers: { q1: { answers: ['x'] } } } })).toEqual({
      answers: { q1: { answers: ['x'] } },
    });
    expect(approvalResponse(input, deny)).toEqual({ answers: {} });

    const elicitation = req('mcpServer/elicitation/request', {});
    expect(approvalResponse(elicitation, { ...allowOnce, updatedInput: { ok: true } })).toEqual({
      action: 'accept',
      content: { ok: true },
      _meta: null,
    });
    expect(approvalResponse(elicitation, cancel)).toEqual({ action: 'cancel', content: null, _meta: null });

    const legacy = req('execCommandApproval', {});
    expect(approvalResponse(legacy, allowSession)).toEqual({ decision: 'approved_for_session' });
    expect(approvalResponse(legacy, deny)).toEqual({ decision: { denied: { rejection: 'no' } } });
    expect(approvalResponse(legacy, cancel)).toEqual({ decision: 'abort' });
  });

  it('file change approval shows the started item’s changes', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    const item = {
      type: 'fileChange',
      id: 'f1',
      changes: [{ path: '/w/a.ts', kind: { type: 'add' }, diff: 'x\n' }],
      status: 'inProgress',
    };
    normalizer.handle(n('item/started', { item, threadId: 't', turnId: 'u', startedAtMs: 0 }));
    expect(
      normalizer.approvalRequest(
        req('item/fileChange/requestApproval', { itemId: 'f1', reason: 'outside root', grantRoot: '/x' }),
      ),
    ).toEqual({
      type: 'approval_request',
      requestId: '3',
      tool: 'apply_patch',
      input: { changes: [{ path: 'a.ts', kind: 'add' }], grantRoot: '/x' },
      reason: 'outside root',
    });
  });

  it('non-approval requests are not mapped', () => {
    const normalizer = new CodexNormalizer({ cwd: '/w', structuredOutput: false });
    expect(normalizer.approvalRequest(req('item/tool/call', {}))).toBeNull();
    expect(() => approvalResponse(req('item/tool/call', {}), allowOnce)).toThrow();
  });
});

describe('helpers', () => {
  it('counts unified diffs, with or without git headers', () => {
    expect(countUnifiedDiff('@@ -1,2 +1,2 @@\n-a\n+b\n c\n')).toEqual({ added: 1, removed: 1 });
    expect(countUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n x\n+--- not a header\n')).toEqual({
      added: 1,
      removed: 0,
    });
    expect(countChange({ path: 'a', kind: { type: 'add' }, diff: 'one\ntwo\n' })).toEqual({ added: 2, removed: 0 });
    expect(countChange({ path: 'a', kind: { type: 'delete' }, diff: 'one\ntwo' })).toEqual({ added: 0, removed: 2 });
    expect(
      countChange({ path: 'a', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }),
    ).toEqual({ added: 1, removed: 1 });
  });

  it('unwraps the shell wrapper', () => {
    expect(unwrapShell("/bin/zsh -lc 'echo hi'")).toBe('echo hi');
    expect(unwrapShell(`/bin/zsh -lc "python3 -c 'print(\\"x\\")'"`)).toBe(`python3 -c 'print("x")'`);
    expect(unwrapShell("/bin/bash -c 'it'\\''s'")).toBe("it's");
    expect(unwrapShell('ls -la')).toBe('ls -la');
    expect(displayCommand('/bin/zsh -lc ls', [{ type: 'listFiles', command: 'ls', path: null }])).toBe('ls');
    expect(displayCommand("/bin/zsh -lc 'cd a && ls'", [])).toBe('cd a && ls');
  });
});
