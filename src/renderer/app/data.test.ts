import type { Attempt, InboxItem, Run, Task } from '@shared/domain';
import type { ServerEvent, ServerEventBody } from '@shared/events';
import type { RunSnapshot } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import {
  activityLine,
  applyEvents,
  applyOpenInbox,
  applyRunList,
  applySnapshot,
  applyTranscriptPage,
  beginTranscript,
  initialData,
  openInbox,
  openInboxCount,
  pushActivity,
  runCost,
  selectRunList,
  taskCounts,
  tasksOfRun,
  transcriptEntries,
} from './data';

const run = (id: string, patch: Partial<Run> = {}): Run => ({
  id,
  repoPath: '/repo',
  baseRef: 'main',
  title: id,
  issueText: '',
  issueUrl: null,
  status: 'executing',
  paused: false,
  plannerEngine: 'claude',
  plannerModel: null,
  integrationBranch: null,
  prUrl: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const task = (id: string, runId: string, nodeId: string, patch: Partial<Task> = {}): Task => ({
  id,
  runId,
  nodeId,
  status: 'queued',
  branch: null,
  worktreePath: null,
  startSha: null,
  attemptCount: 0,
  fixRounds: 0,
  mergedSha: null,
  engineOverride: null,
  modelOverride: null,
  effortOverride: null,
  progress: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const attempt = (id: string, runId: string, patch: Partial<Attempt> = {}): Attempt => ({
  id,
  runId,
  taskId: null,
  role: 'coder',
  engine: 'claude',
  model: null,
  effort: null,
  sessionId: null,
  status: 'running',
  startedAt: 1,
  endedAt: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  error: null,
  ...patch,
});

const approval = (id: string, runId: string, patch: Partial<InboxItem> = {}): InboxItem =>
  ({
    id,
    runId,
    taskId: null,
    attemptId: null,
    createdAt: 1,
    resolvedAt: null,
    kind: 'approval',
    payload: { requestId: 'r', tool: 'Bash', input: { command: 'ls' }, reason: null },
    resolution: null,
    ...patch,
  }) as InboxItem;

const ev = (seq: number, body: ServerEventBody): ServerEvent => ({ seq, ts: seq, ...body });

const snapshot = (seq: number, patch: Partial<RunSnapshot> = {}): RunSnapshot => ({
  seq,
  run: run('run_a'),
  plans: [],
  tasks: [],
  attempts: [],
  reviews: [],
  inbox: [],
  verifications: [],
  merges: [],
  ...patch,
});

describe('applyEvents', () => {
  it('upserts entities and advances seq', () => {
    const s = applyEvents(initialData(), [
      ev(1, { type: 'run.updated', run: run('run_a'), from: null }),
      ev(2, { type: 'task.updated', task: task('t1', 'run_a', 'T1'), from: null }),
    ]);
    expect(s.seq).toBe(2);
    expect(s.runs.run_a?.id).toBe('run_a');
    expect(tasksOfRun(s.tasks, 'run_a').map((t) => t.id)).toEqual(['t1']);
  });

  it('is idempotent and ignores stale events', () => {
    const e1 = ev(5, { type: 'task.updated', task: task('t1', 'run_a', 'T1', { status: 'running' }), from: null });
    const e0 = ev(3, { type: 'task.updated', task: task('t1', 'run_a', 'T1', { status: 'queued' }), from: null });
    const once = applyEvents(initialData(), [e1]);
    const twice = applyEvents(once, [e1, e0]);
    expect(twice.tasks.t1?.status).toBe('running');
    expect(twice.tasks).toBe(once.tasks);
  });

  it('returns the same state for an empty batch', () => {
    const s = initialData();
    expect(applyEvents(s, [])).toBe(s);
  });

  it('does not mutate the previous state', () => {
    const before = applyEvents(initialData(), [ev(1, { type: 'run.updated', run: run('run_a'), from: null })]);
    const frozen = JSON.stringify(before);
    applyEvents(before, [ev(2, { type: 'run.updated', run: run('run_a', { status: 'done' }), from: 'executing' })]);
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it('appends agent events to loaded transcripts, dedupes by seq and derives activity + rate limits', () => {
    let s = beginTranscript(initialData(), 'att_1');
    const agent = (seq: number, event: Extract<ServerEvent, { type: 'agent.event' }>['event']) =>
      ev(seq, { type: 'agent.event', runId: 'run_a', taskId: null, attemptId: 'att_1', event });
    s = applyEvents(s, [
      agent(10, { type: 'message', text: 'Hello   world' }),
      agent(11, { type: 'tool_call', id: 'c', name: 'Bash', input: { command: 'pnpm test' }, kind: 'command' }),
      agent(12, { type: 'rate_limit', engine: 'claude', window: '5h', usedPct: 38, resetsAt: null }),
    ]);
    s = applyEvents(s, [agent(11, { type: 'message', text: 'dupe' })]);
    expect(s.transcripts.att_1?.entries.map((e) => e.seq)).toEqual([10, 11, 12]);
    expect(s.activity.att_1?.lines).toEqual(['Hello world', '$ pnpm test']);
    expect(s.rateLimits.claude?.['5h']?.usedPct).toBe(38);
    // Transcripts that were never requested are not accumulated.
    s = applyEvents(s, [
      ev(13, {
        type: 'agent.event',
        runId: 'run_a',
        taskId: null,
        attemptId: 'att_2',
        event: { type: 'message', text: 'x' },
      }),
    ]);
    expect(s.transcripts.att_2).toBeUndefined();
    expect(s.activity.att_2?.lines).toEqual(['x']);
  });
});

describe('snapshots', () => {
  it('applies a run snapshot and ignores events it already contains', () => {
    let s = applySnapshot(initialData(), snapshot(10, { tasks: [task('t1', 'run_a', 'T1', { status: 'running' })] }));
    expect(s.loadedRuns.run_a).toBe(10);
    s = applyEvents(s, [
      ev(9, { type: 'task.updated', task: task('t1', 'run_a', 'T1', { status: 'queued' }), from: null }),
    ]);
    expect(s.tasks.t1?.status).toBe('running');
    s = applyEvents(s, [
      ev(11, { type: 'task.updated', task: task('t1', 'run_a', 'T1', { status: 'verifying' }), from: null }),
    ]);
    expect(s.tasks.t1?.status).toBe('verifying');
  });

  it('does not let an older snapshot overwrite newer events, and drops rows the snapshot lost', () => {
    let s = applyEvents(initialData(), [
      ev(20, { type: 'task.updated', task: task('t1', 'run_a', 'T1', { status: 'merged' }), from: null }),
      ev(5, { type: 'task.updated', task: task('t2', 'run_a', 'T2'), from: null }),
      ev(6, { type: 'task.updated', task: task('t9', 'run_b', 'T9'), from: null }),
    ]);
    s = applySnapshot(s, snapshot(15, { tasks: [task('t1', 'run_a', 'T1', { status: 'running' })] }));
    expect(s.tasks.t1?.status).toBe('merged');
    expect(s.tasks.t2).toBeUndefined();
    expect(s.tasks.t9).toBeDefined();
  });

  it('applies runs.list as of the request seq and removes vanished runs', () => {
    let s = applyEvents(initialData(), [
      ev(3, { type: 'run.updated', run: run('run_old'), from: null }),
      ev(8, { type: 'run.updated', run: run('run_new', { status: 'planning' }), from: null }),
    ]);
    s = applyRunList(
      s,
      [
        { run: run('run_a', { createdAt: 5 }), taskCounts: { running: 2 }, openInbox: 1, costUsd: 1.5 },
        { run: run('run_new', { status: 'draft' }), taskCounts: {}, openInbox: 0, costUsd: 0 },
      ],
      5,
    );
    expect(Object.keys(s.runs).sort()).toEqual(['run_a', 'run_new']);
    expect(s.runs.run_new?.status).toBe('planning');
    expect(s.connection.loaded).toBe(true);
    expect(taskCounts(s, 'run_a')).toEqual({ running: 2 });
    expect(runCost(s, 'run_a')).toBe(1.5);
    expect(openInboxCount(s, 'run_a')).toBe(1);
  });

  it('applies the global open inbox and drops items resolved in the meantime', () => {
    let s = applyEvents(initialData(), [
      ev(2, { type: 'inbox.updated', item: approval('i1', 'run_a') }),
      ev(9, { type: 'inbox.updated', item: approval('i3', 'run_a', { createdAt: 5 }) }),
    ]);
    s = applyOpenInbox(s, [approval('i2', 'run_b')], 4);
    expect(Object.keys(s.inbox).sort()).toEqual(['i2', 'i3']);
    expect(openInbox(s.inbox, '*').map((i) => i.id)).toEqual(['i2', 'i3']);
    expect(openInbox(s.inbox, 'run_b').map((i) => i.id)).toEqual(['i2']);
  });
});

describe('transcripts', () => {
  it('merges a fetched page with live entries that arrived while loading', () => {
    const live = (seq: number, text: string) =>
      ev(seq, { type: 'agent.event', runId: 'r', taskId: null, attemptId: 'a', event: { type: 'message', text } });
    let s = beginTranscript(initialData(), 'a');
    s = applyEvents(s, [live(7, 'live')]);
    s = applyTranscriptPage(
      s,
      'a',
      [
        { seq: 3, ts: 3, event: { type: 'message', text: 'old' } },
        { seq: 7, ts: 7, event: { type: 'message', text: 'live' } },
      ],
      true,
    );
    expect(s.transcripts.a).toMatchObject({ status: 'ready', lastSeq: 7 });
    expect(s.transcripts.a?.entries.map((e) => e.seq)).toEqual([3, 7]);
  });

  it('appends live entries in place (O(1)) and copies only when an older state is extended', () => {
    const live = (seq: number) =>
      ev(seq, {
        type: 'agent.event',
        runId: 'r',
        taskId: null,
        attemptId: 'a',
        event: { type: 'text_delta', text: 'x' },
      });
    let s = beginTranscript(initialData(), 'a');
    s = applyEvents(s, [live(1)]);
    const first = s.transcripts.a;
    if (!first) throw new Error('transcript missing');
    let next = s;
    for (let seq = 2; seq <= 500; seq++) next = applyEvents(next, [live(seq)]);
    const grown = next.transcripts.a;
    // Same backing array, no per-event copy; each state knows how many entries are its own.
    expect(grown?.entries).toBe(first.entries);
    expect(grown?.count).toBe(500);
    expect(first.count).toBe(1);
    expect(transcriptEntries(first).map((e) => e.seq)).toEqual([1]);
    // Extending the older state again must not clobber the newer one.
    const branch = applyEvents(s, [live(900)]).transcripts.a;
    expect(branch?.entries).not.toBe(first.entries);
    expect(branch ? transcriptEntries(branch).map((e) => e.seq) : null).toEqual([1, 900]);
    expect(grown?.entries.at(-1)?.seq).toBe(500);
  });

  it('seeds activity lines from history', () => {
    const s = applyTranscriptPage(
      initialData(),
      'a',
      [{ seq: 1, ts: 1, event: { type: 'message', text: 'hi' } }],
      true,
    );
    expect(s.activity.a?.lines).toEqual(['hi']);
  });
});

describe('selectors', () => {
  it('orders the rail: active runs oldest first, then finished newest first', () => {
    const s = applyEvents(initialData(), [
      ev(1, { type: 'run.updated', run: run('r1', { createdAt: 3 }), from: null }),
      ev(2, { type: 'run.updated', run: run('r2', { createdAt: 1 }), from: null }),
      ev(3, { type: 'run.updated', run: run('r3', { status: 'done', updatedAt: 5 }), from: null }),
      ev(4, { type: 'run.updated', run: run('r4', { status: 'failed', updatedAt: 9 }), from: null }),
    ]);
    expect(selectRunList(s).map((r) => r.id)).toEqual(['r2', 'r1', 'r4', 'r3']);
    expect(selectRunList(s)).toBe(selectRunList(s));
  });

  it('sums attempt costs for loaded runs', () => {
    const s = applySnapshot(
      initialData(),
      snapshot(1, { attempts: [attempt('a1', 'run_a', { costUsd: 0.5 }), attempt('a2', 'run_a', { costUsd: 0.25 })] }),
    );
    expect(runCost(s, 'run_a')).toBe(0.75);
  });

  it('memoizes per-run selectors on collection identity', () => {
    const s = applyEvents(initialData(), [
      ev(1, { type: 'task.updated', task: task('t1', 'run_a', 'T1'), from: null }),
    ]);
    expect(tasksOfRun(s.tasks, 'run_a')).toBe(tasksOfRun(s.tasks, 'run_a'));
  });

  it('formats activity lines', () => {
    expect(activityLine({ type: 'file_change', path: 'a.ts', added: 3, removed: 1 })).toBe('Edit a.ts +3 −1');
    expect(
      activityLine({
        type: 'todo',
        items: [
          { text: 'a', status: 'completed' },
          { text: 'b', status: 'in_progress' },
        ],
      }),
    ).toBe('todo 1/2 · b');
    expect(activityLine({ type: 'text_delta', text: 'x' })).toBeNull();
  });
});

describe('pushActivity', () => {
  it('folds an edit call and its file change into one line', () => {
    expect(pushActivity(['Read a.ts', 'Edit b.ts'], 'Edit b.ts +7 −1')).toEqual(['Read a.ts', 'Edit b.ts +7 −1']);
    expect(pushActivity(['Write c.ts'], 'Edit c.ts +3 −0')).toEqual(['Edit c.ts +3 −0']);
    expect(pushActivity(['Edit b.ts'], 'Edit c.ts +1 −0')).toEqual(['Edit b.ts', 'Edit c.ts +1 −0']);
    expect(pushActivity(['1', '2', '3', '4'], '5')).toEqual(['2', '3', '4', '5']);
  });
});
