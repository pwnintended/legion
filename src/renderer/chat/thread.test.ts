import type { AgentMessage, Attempt, InboxItem, Presentation, Run } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import type { TranscriptEntry } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { assistantBusy, buildThread, openDecisionItems, type ThreadInput, type ThreadItem } from './thread';

const run: Run = {
  id: 'run_1',
  repoPath: '/repo',
  projectId: 'prj_1',
  baseRef: 'main',
  title: 'Passkeys',
  issueText: 'Add passkeys',
  issueUrl: null,
  status: 'executing',
  paused: false,
  plannerEngine: 'claude',
  plannerModel: null,
  integrationBranch: null,
  prUrl: null,
  pr: null,
  archived: false,
  attachments: [],
  error: null,
  createdAt: 1000,
  updatedAt: 1000,
};

const attempt = (id: string, role: Attempt['role'], patch: Partial<Attempt> = {}): Attempt => ({
  id,
  runId: run.id,
  taskId: null,
  role,
  engine: 'claude',
  model: null,
  effort: null,
  sessionId: null,
  parentAttemptId: null,
  status: 'running',
  startedAt: 1000,
  endedAt: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  error: null,
  ...patch,
});

let seq = 0;
const at = (ts: number, event: AgentEvent): TranscriptEntry => ({ seq: ++seq, ts, event });
const you = (ts: number, text: string) => at(ts, { type: 'user_message', text, attachments: [], priority: null });
const turnEnd = (ts: number) => at(ts, { type: 'turn_complete', structuredOutput: null, isError: false, reason: null });

const message = (id: string, ts: number, patch: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  runId: run.id,
  fromAttemptId: 'att_lead',
  toAttemptId: 'att_as',
  kind: 'status',
  body: 'T1 merged',
  replyTo: null,
  createdAt: ts,
  deliveredAt: ts,
  ...patch,
});

function input(patch: Partial<ThreadInput>): ThreadInput {
  return {
    run,
    attempts: [attempt('att_as', 'assistant')],
    transcripts: {},
    messages: [],
    inbox: [],
    presentations: [],
    tasks: [],
    nodes: [],
    merges: [],
    ...patch,
  };
}

const kinds = (thread: ThreadItem[]) => thread.map((i) => i.kind);

describe('buildThread', () => {
  it("interleaves the human's messages and the assistant's replies; streamed text is replaced by the final", () => {
    const thread = buildThread(
      input({
        transcripts: {
          att_as: [
            you(1100, 'Add passkeys'),
            at(1200, { type: 'text_delta', text: 'On ' }),
            at(1210, { type: 'text_delta', text: 'it' }),
            at(1220, { type: 'tool_call', id: 't', name: 'start_implementation', input: {}, kind: 'mcp' }),
            at(1225, { type: 'message', text: 'On it.' }),
            at(1230, { type: 'text_delta', text: 'The planner' }),
            at(1240, { type: 'message', text: 'The planner is drafting.' }),
            turnEnd(1250),
            you(2000, 'Use Redis'),
          ],
        },
      }),
    );
    expect(kinds(thread)).toEqual(['human', 'assistant', 'assistant', 'human']);
    const replies = thread.filter((i) => i.kind === 'assistant');
    expect(replies.map((r) => [r.text, r.streaming, r.continued])).toEqual([
      ['On it.', false, false],
      ['The planner is drafting.', false, true],
    ]);
  });

  it('keeps a reply streaming until its turn ends', () => {
    const thread = buildThread(
      input({ transcripts: { att_as: [you(1100, 'Hi'), at(1200, { type: 'text_delta', text: 'Hel' })] } }),
    );
    expect(thread.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hel', streaming: true });
  });

  it('folds agent messages under the reply that followed them, or shows them when the assistant stayed quiet', () => {
    const transcripts = {
      att_as: [you(1100, 'Go'), turnEnd(1150), at(3000, { type: 'message', text: 'T1 is in.' }), turnEnd(3010)],
    };
    const thread = buildThread(
      input({
        transcripts,
        messages: [
          message('m1', 2500),
          message('m2', 4000, { body: 'T2 merged' }),
          // A brief from the assistant to the lead is not the human's business.
          message('m3', 2600, { fromAttemptId: 'att_as', toAttemptId: 'att_lead', kind: 'brief' }),
        ],
      }),
    );
    const reply = thread.find((i) => i.kind === 'assistant');
    expect(reply?.kind === 'assistant' && reply.sources.map((m) => m.id)).toEqual(['m1']);
    expect(thread.at(-1)).toMatchObject({ kind: 'update', message: { id: 'm2' } });
    expect(thread.some((i) => i.kind === 'update' && i.message.id === 'm3')).toBe(false);
  });

  it('hides an unanswered update while the assistant is still on it', () => {
    const thread = buildThread(
      input({
        transcripts: {
          att_as: [
            you(1100, 'Go'),
            turnEnd(1150),
            at(4100, { type: 'activity', activity: 'thinking', tool: null, chars: 0 }),
          ],
        },
        messages: [message('m2', 4000)],
      }),
    );
    expect(kinds(thread)).toEqual(['human']);
  });

  it('places decisions and presentations by time and narrates the PR', () => {
    const item = {
      id: 'inb_1',
      runId: run.id,
      taskId: null,
      attemptId: null,
      kind: 'pr_ready',
      payload: { integrationBranch: 'b', title: 'PR', body: '' },
      resolution: { approved: true, title: null, body: null },
      createdAt: 1500,
      resolvedAt: 1600,
    } as InboxItem;
    const presentation: Presentation = {
      id: 'shw_1',
      runId: run.id,
      taskId: null,
      attemptId: 'att_c',
      title: 'Preview',
      caption: null,
      attachments: [],
      createdAt: 1300,
    };
    const thread = buildThread(
      input({
        run: { ...run, status: 'done', pr: { url: 'https://x/pull/7', number: 7, state: 'open', isDraft: true } },
        transcripts: { att_as: [you(1100, 'Go')] },
        inbox: [item],
        presentations: [presentation],
      }),
    );
    expect(kinds(thread)).toEqual(['human', 'presentation', 'decision', 'event']);
    expect(thread.at(-1)).toMatchObject({ text: 'Draft pull request #7 opened', href: 'https://x/pull/7', ts: 1600 });
    expect(openDecisionItems(thread)).toEqual([]);
  });

  it('gives runs without an assistant their request and narrates merges', () => {
    const thread = buildThread(
      input({
        attempts: [],
        tasks: [
          {
            id: 'task_1',
            runId: run.id,
            nodeId: 'T1',
            status: 'merged',
          } as ThreadInput['tasks'][number],
        ],
        nodes: [{ id: 'T1', title: 'Contracts' } as ThreadInput['nodes'][number]],
        merges: [
          {
            id: 'mrg_1',
            runId: run.id,
            taskId: 'task_1',
            preSha: 'a',
            postSha: 'b',
            status: 'merged',
            error: null,
            createdAt: 1400,
            endedAt: 1500,
          },
        ],
      }),
    );
    expect(thread.map((i) => (i.kind === 'human' || i.kind === 'event' ? i.text : i.kind))).toEqual([
      'Add passkeys',
      'T1 · Contracts merged',
    ]);
  });

  it('shows an optimistic message until its recorded twin arrives', () => {
    const pending = [
      { id: 1, text: 'Use Redis', attachments: [], status: 'sent' as const, error: null, ts: 1900 },
      { id: 2, text: 'And docs', attachments: [], status: 'sending' as const, error: null, ts: 1950 },
    ];
    const thread = buildThread(input({ transcripts: { att_as: [you(2000, 'Use Redis')] }, pending }));
    expect(thread.map((i) => (i.kind === 'human' ? [i.text, i.pending?.status ?? null] : i.kind))).toEqual([
      ['And docs', 'sending'],
      ['Use Redis', null],
    ]);
  });
});

describe('assistantBusy', () => {
  const live = attempt('att_as', 'assistant');
  it('is busy from the input until the turn ends', () => {
    expect(assistantBusy([you(1, 'x')], live)).toBe(true);
    expect(assistantBusy([you(1, 'x'), turnEnd(2)], live)).toBe(false);
    expect(
      assistantBusy(
        [you(1, 'x'), turnEnd(2), at(3, { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null })],
        live,
      ),
    ).toBe(false);
    expect(assistantBusy([you(1, 'x')], { ...live, status: 'succeeded' })).toBe(false);
  });
});

describe('a direct session', () => {
  const sessionRun: Run = { ...run, status: 'session' };
  const call = (ts: number, id: string, name: string, kind: 'read' | 'command') =>
    at(ts, { type: 'tool_call', id, name, input: { command: 'ls' }, kind });
  const result = (ts: number, id: string) => at(ts, { type: 'tool_result', id, ok: true, output: '' });
  const said = (ts: number, text: string) => at(ts, { type: 'message', text });

  it('reads like a conversation, its tool calls grouped between its words', () => {
    const entries = [
      you(1100, 'Fix the build'),
      said(1200, 'Looking.'),
      call(1300, 'c1', 'Bash', 'command'),
      result(1310, 'c1'),
      call(1320, 'c2', 'Read', 'read'),
      result(1330, 'c2'),
      said(1400, 'Fixed it.'),
      turnEnd(1500),
    ];
    const thread = buildThread(
      input({
        run: sessionRun,
        attempts: [attempt('att_ss', 'session')],
        transcripts: { att_ss: entries },
      }),
    );
    expect(thread.map((i) => i.kind)).toEqual(['human', 'assistant', 'work', 'assistant']);
    const work = thread[2] as Extract<ThreadItem, { kind: 'work' }>;
    expect(work.entries.map((e) => e.event.type)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result']);
    // The words after the tool calls continue the same turn: no second header.
    expect((thread[3] as Extract<ThreadItem, { kind: 'assistant' }>).continued).toBe(true);
  });

  it('keeps the assistant’s tool calls out of its conversation', () => {
    const entries = [you(1100, 'Hi'), call(1200, 'c1', 'Read', 'read'), said(1300, 'Hello.'), turnEnd(1400)];
    const thread = buildThread(input({ transcripts: { att_as: entries } }));
    expect(thread.map((i) => i.kind)).toEqual(['human', 'assistant']);
  });

  it('calls its end a stopped session', () => {
    const thread = buildThread(
      input({
        run: { ...run, status: 'cancelled' },
        attempts: [attempt('att_ss', 'session', { status: 'cancelled' })],
      }),
    );
    expect(thread.at(-1)).toMatchObject({ kind: 'event', text: 'The session was stopped' });
  });
});
