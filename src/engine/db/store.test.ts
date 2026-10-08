import { join } from 'node:path';
import type { PlanDag } from '@shared/domain';
import type { ServerEvent } from '@shared/events';
import { RpcError } from '@shared/rpc-transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/helpers';
import { MIGRATIONS, migrate, type OpenedStore, openStore, pragma, type Store, schemaVersion } from './index';
import { capOutput, VERIFICATION_OUTPUT_CAP } from './store';

let dir: ReturnType<typeof tempDir>;
let opened: OpenedStore;
let store: Store;
let clock = 1_000;

beforeEach(() => {
  dir = tempDir();
  clock = 1_000;
  opened = openStore(join(dir.path, 'legion.db'), { now: () => clock++ });
  store = opened.store;
});

afterEach(() => {
  opened.close();
  dir.cleanup();
});

const newRun = () =>
  store.createRun({
    repoPath: '/tmp/repo',
    baseRef: 'main',
    title: 'Add a thing',
    issueText: 'Please add a thing',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
  });

const dag: PlanDag = { nodes: [], annotations: [] };

describe('database', () => {
  it('opens with WAL, NORMAL sync and foreign keys, at the latest schema', () => {
    expect(pragma(opened.db, 'journal_mode')).toBe('wal');
    expect(pragma(opened.db, 'synchronous')).toBe(1);
    expect(pragma(opened.db, 'foreign_keys')).toBe(1);
    expect(opened.schemaVersion).toBe(MIGRATIONS.at(-1)?.version);
  });

  it('migrations are idempotent and reopening keeps data', () => {
    const run = newRun();
    expect(migrate(opened.db)).toBe(schemaVersion(opened.db));
    opened.close();
    opened = openStore(join(dir.path, 'legion.db'));
    store = opened.store;
    expect(store.getRun(run.id)).toEqual(run);
  });

  it('creates every table from the architecture', () => {
    const tables = (
      opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of [
      'runs',
      'plans',
      'tasks',
      'attempts',
      'reviews',
      'inbox_items',
      'events',
      'settings',
      'recent_repos',
      'merges',
      'verifications',
      'verification_outputs',
      'messages',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('refuses a database from a newer build', () => {
    opened.db.exec('PRAGMA user_version = 999');
    expect(() => migrate(opened.db)).toThrow(/newer/);
  });
});

describe('store', () => {
  it('round-trips a run and appends an event', () => {
    const events: ServerEvent[] = [];
    store.onEvents((batch) => events.push(...batch));
    const run = newRun();
    expect(store.getRun(run.id)).toEqual(run);
    expect(run.paused).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'run.updated', seq: 1, from: null, run });
    expect(store.headSeq()).toBe(1);
  });

  it('transitions with compare-and-set and records `from`', () => {
    const run = newRun();
    const next = store.transitionRun(run.id, 'draft', 'clarifying');
    expect(next.status).toBe('clarifying');
    expect(next.updatedAt).toBeGreaterThan(run.updatedAt);
    const last = store.eventsSince(0, 10).at(-1);
    expect(last).toMatchObject({ type: 'run.updated', from: 'draft' });
  });

  it('rejects stale and illegal transitions without side effects', () => {
    const run = newRun();
    const head = store.headSeq();
    expect(() => store.transitionRun(run.id, 'planning', 'awaiting_approval')).toThrow(RpcError);
    expect(() => store.transitionRun(run.id, 'draft', 'done')).toThrow(/illegal/);
    try {
      store.transitionRun(run.id, 'planning', 'awaiting_approval');
    } catch (error) {
      expect((error as RpcError).code).toBe('conflict');
    }
    expect(store.headSeq()).toBe(head);
    expect(store.getRun(run.id)?.status).toBe('draft');
    expect(() => store.transitionRun('run_missing', 'draft', 'planning')).toThrow(/not found/);
  });

  it('accepts several expected source statuses', () => {
    const run = newRun();
    const task = store.insertTask({ runId: run.id, nodeId: 'T1' });
    expect(task.status).toBe('blocked');
    const queued = store.transitionTask(task.id, ['blocked', 'failed'], 'queued');
    expect(queued.status).toBe('queued');
  });

  it('rolls back the entity change and its event together', () => {
    const run = newRun();
    const events: ServerEvent[] = [];
    store.onEvents((batch) => events.push(...batch));
    expect(() =>
      store.transaction(() => {
        store.transitionRun(run.id, 'draft', 'planning');
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(store.getRun(run.id)?.status).toBe('draft');
    expect(store.headSeq()).toBe(1);
    expect(events).toEqual([]);
  });

  it('publishes events of a transaction once, after commit, in order', () => {
    const run = newRun();
    const batches: ServerEvent[][] = [];
    store.onEvents((batch) => batches.push(batch));
    store.transaction(() => {
      store.transitionRun(run.id, 'draft', 'planning');
      store.insertTask({ runId: run.id, nodeId: 'T1' });
      expect(batches).toEqual([]);
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((e) => e.type)).toEqual(['run.updated', 'task.updated']);
    expect(batches[0]?.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('plans get increasing versions and approve once', () => {
    const run = newRun();
    const v1 = store.insertPlan({ runId: run.id, markdown: '# v1', dag, source: 'agent', feedback: null });
    const v2 = store.insertPlan({ runId: run.id, markdown: '# v2', dag, source: 'user', feedback: 'more tests' });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(store.latestPlan(run.id)?.id).toBe(v2.id);
    expect(store.approvePlan(v2.id).approvedAt).not.toBeNull();
    expect(() => store.approvePlan(v2.id)).toThrow(/already approved/);
    expect(store.listPlans(run.id).map((p) => p.dag)).toEqual([dag, dag]);
  });

  it('attempts get endedAt on terminal transitions', () => {
    const run = newRun();
    const attempt = store.insertAttempt({
      runId: run.id,
      taskId: null,
      role: 'planner',
      engine: 'fake',
      model: null,
      effort: null,
    });
    store.transitionAttempt(attempt.id, 'pending', 'running', { sessionId: 'sess-1' });
    const done = store.transitionAttempt(attempt.id, 'running', 'succeeded', { costUsd: 0.25 });
    expect(done.endedAt).not.toBeNull();
    expect(done.sessionId).toBe('sess-1');
    expect(store.listRunSummaries()[0]?.costUsd).toBe(0.25);
  });

  it('inbox items resolve once and must match the kind', () => {
    const run = newRun();
    const item = store.insertInboxItem({
      runId: run.id,
      taskId: null,
      attemptId: null,
      kind: 'budget',
      payload: { spentUsd: 5, limitUsd: 4 },
    });
    expect(store.listInbox({ runId: null, includeResolved: false })).toHaveLength(1);
    expect(() => store.resolveInboxItem(item.id, { kind: 'question', answers: [] })).toThrow(/budget/);
    const resolved = store.resolveInboxItem(item.id, { kind: 'budget', action: 'raise', newLimitUsd: 10 });
    expect(resolved.resolution).toEqual({ action: 'raise', newLimitUsd: 10 });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(() => store.resolveInboxItem(item.id, { kind: 'budget', action: 'stop', newLimitUsd: null })).toThrow(
      /already resolved/,
    );
    expect(store.listInbox({ runId: run.id, includeResolved: false })).toHaveLength(0);
    expect(store.listInbox({ runId: run.id, includeResolved: true })).toHaveLength(1);
  });

  it('builds a full snapshot and run summaries', () => {
    const run = newRun();
    const task = store.insertTask({ runId: run.id, nodeId: 'T1' });
    const attempt = store.insertAttempt({
      runId: run.id,
      taskId: task.id,
      role: 'coder',
      engine: 'fake',
      model: null,
      effort: null,
    });
    store.insertReview({
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      verdict: 'approve',
      criteria: [{ id: 'AC1', status: 'met', evidence: 'ok' }],
      findings: [],
      summary: 'fine',
    });
    store.insertVerification({
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      phase: 'task',
      command: 'pnpm test',
      exitCode: 0,
      outputTail: 'ok',
      durationMs: 12,
    });
    const merge = store.insertMerge({ runId: run.id, taskId: task.id, preSha: 'abc' });
    store.finishMerge(merge.id, 'merged', { postSha: 'def' });
    expect(() => store.finishMerge(merge.id, 'conflict')).toThrow(/already merged/);

    const snapshot = store.runSnapshot(run.id);
    expect(snapshot.seq).toBe(store.headSeq());
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.reviews[0]?.criteria).toEqual([{ id: 'AC1', status: 'met', evidence: 'ok' }]);
    expect(snapshot.verifications).toHaveLength(1);
    expect(snapshot.merges[0]).toMatchObject({ status: 'merged', postSha: 'def' });
    expect(store.listRunSummaries()[0]?.taskCounts).toEqual({ blocked: 1 });
  });

  describe('verifications', () => {
    const base = (runId: string) => ({
      runId,
      taskId: null,
      attemptId: null,
      phase: 'task' as const,
      command: 'pnpm test',
      exitCode: 1,
      outputTail: 'tail',
      durationMs: 42,
    });

    it('round-trips the gate fields and keeps the full output out of rows and events', () => {
      const run = newRun();
      const events: ServerEvent[] = [];
      store.onEvents((batch) => events.push(...batch));
      const v = store.insertVerification({
        ...base(run.id),
        gate: 'test',
        kind: 'command',
        status: 'fail',
        summary: '2 tests failed',
        blocking: true,
        output: 'full output',
      });
      const nonBlocking = store.insertVerification({
        ...base(run.id),
        command: '',
        exitCode: 0,
        gate: 'scope',
        kind: 'scope',
        status: 'pass',
        summary: 'all in scope',
        blocking: false,
      });
      expect(v).toMatchObject({ gate: 'test', kind: 'command', status: 'fail', summary: '2 tests failed' });
      expect(v.blocking).toBe(true);
      expect(v).not.toHaveProperty('output');
      expect(store.listVerifications(run.id)).toEqual([v, nonBlocking]);
      expect(nonBlocking.blocking).toBe(false);
      expect(store.listVerifications(run.id)[1]?.blocking).toBe(false);
      for (const row of store.listVerifications(run.id)) expect(row).not.toHaveProperty('output');
      expect(store.runSnapshot(run.id).verifications).toEqual([v, nonBlocking]);
      const created = events.find((e) => e.type === 'verification.created');
      expect(created).toMatchObject({ type: 'verification.created', verification: v });
      expect(JSON.stringify(events)).not.toContain('full output');
    });

    it('reads a legacy row (no gate fields, no output) back with nulls', () => {
      const run = newRun();
      const v = store.insertVerification(base(run.id));
      const [row] = store.listVerifications(run.id);
      expect(row).toEqual(v);
      expect(row).toMatchObject({ gate: null, kind: null, status: null, summary: null, blocking: null });
      expect(store.verificationOutput(v.id)).toBeNull();
    });

    it('returns the stored output, capped to the tail', () => {
      const run = newRun();
      const v = store.insertVerification({ ...base(run.id), gate: 'lint', output: 'line 1\nline 2\n' });
      expect(store.verificationOutput(v.id)).toBe('line 1\nline 2\n');
      expect(store.verificationOutput('verification_missing')).toBeNull();

      const big = `${'a'.repeat(VERIFICATION_OUTPUT_CAP)}THE END`;
      const capped = store.insertVerification({ ...base(run.id), output: big });
      const stored = store.verificationOutput(capped.id);
      expect(stored).toHaveLength(VERIFICATION_OUTPUT_CAP);
      expect(stored?.endsWith('THE END')).toBe(true);
    });

    it('caps on whole characters', () => {
      expect(capOutput('abc', 3)).toBe('abc');
      expect(capOutput('abcdef', 3)).toBe('def');
      expect(capOutput('xé€', 4)).toBe('€'); // never a split character
    });

    it('deletes the output with its run', () => {
      const run = newRun();
      const v = store.insertVerification({ ...base(run.id), output: 'gone soon' });
      expect(store.verificationOutput(v.id)).toBe('gone soon');
      opened.db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
      expect(store.listVerifications(run.id)).toEqual([]);
      expect(store.verificationOutput(v.id)).toBeNull();
      const left = opened.db.prepare('SELECT COUNT(*) AS n FROM verification_outputs').get() as { n: number };
      expect(Number(left.n)).toBe(0);
    });
  });

  it('stores agent events and pages transcripts', () => {
    const run = newRun();
    const attempt = store.insertAttempt({
      runId: run.id,
      taskId: null,
      role: 'planner',
      engine: 'fake',
      model: null,
      effort: null,
    });
    for (let i = 0; i < 5; i++) store.appendAgentEvent(attempt, { type: 'text_delta', text: `t${i}` });
    const first = store.attemptTranscript(attempt.id, 0, 3);
    expect(first.entries.map((e) => e.event)).toEqual([0, 1, 2].map((i) => ({ type: 'text_delta', text: `t${i}` })));
    expect(first.hasMore).toBe(true);
    const rest = store.attemptTranscript(attempt.id, first.entries.at(-1)?.seq ?? 0, 3);
    expect(rest.entries).toHaveLength(2);
    expect(rest.hasMore).toBe(false);
  });

  it('settings default, patch, persist and emit', () => {
    const events: ServerEvent[] = [];
    store.onEvents((batch) => events.push(...batch));
    expect(store.getSettings().concurrency.global).toBe(3);
    const next = store.updateSettings({ concurrency: { global: 5 } });
    expect(next.concurrency.global).toBe(5);
    expect(store.getSettings().concurrency.global).toBe(5);
    expect(events[0]).toMatchObject({ type: 'settings.updated' });
    expect(() => store.updateSettings({ concurrency: { global: 0 } })).toThrow();
    expect(store.getSettings().concurrency.global).toBe(5);
  });

  it('recent repos are most-recent first', () => {
    store.touchRecentRepo('/a', 'a');
    store.touchRecentRepo('/b', 'b');
    store.touchRecentRepo('/a', 'a');
    expect(store.listRecentRepos().map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('cascades deletes from runs', () => {
    const run = newRun();
    store.insertTask({ runId: run.id, nodeId: 'T1' });
    opened.db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
    expect(store.listTasks(run.id)).toEqual([]);
  });
});

describe('agent hierarchy and messages', () => {
  const attempt = (runId: string, parentAttemptId: string | null = null) =>
    store.insertAttempt({
      runId,
      taskId: null,
      role: 'coder',
      engine: 'fake',
      model: null,
      effort: null,
      parentAttemptId,
    });

  it('stores the parent edge and lists children', () => {
    const run = newRun();
    const lead = attempt(run.id);
    expect(lead.parentAttemptId).toBeNull();
    const a = attempt(run.id, lead.id);
    const b = attempt(run.id, lead.id);
    expect(store.getAttempt(a.id)?.parentAttemptId).toBe(lead.id);
    expect(store.listChildAttempts(lead.id).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(store.listChildAttempts(a.id)).toEqual([]);
  });

  it('queues, lists and delivers messages exactly once, with events', () => {
    const run = newRun();
    const lead = attempt(run.id);
    const child = attempt(run.id, lead.id);
    const events: ServerEvent[] = [];
    store.onEvents((batch) => events.push(...batch));
    const question = store.insertMessage({
      runId: run.id,
      fromAttemptId: child.id,
      toAttemptId: lead.id,
      kind: 'question',
      body: 'Which db?',
      replyTo: null,
    });
    expect(question).toMatchObject({ kind: 'question', deliveredAt: null, replyTo: null });
    expect(question.id).toMatch(/^msg_/);
    const answer = store.insertMessage({
      runId: run.id,
      fromAttemptId: lead.id,
      toAttemptId: child.id,
      kind: 'answer',
      body: 'sqlite',
      replyTo: question.id,
    });
    expect(store.listMessages(run.id).map((m) => m.id)).toEqual([question.id, answer.id]);
    expect(store.queuedMessagesFor(lead.id).map((m) => m.id)).toEqual([question.id]);
    expect(store.queuedMessagesFor(child.id).map((m) => m.id)).toEqual([answer.id]);

    const delivered = store.markDelivered([question.id, question.id, 'msg_missing']);
    expect(delivered.map((m) => m.id)).toEqual([question.id]);
    expect(delivered[0]?.deliveredAt).toBeGreaterThan(question.createdAt);
    expect(store.queuedMessagesFor(lead.id)).toEqual([]);
    expect(store.getMessage(question.id)?.deliveredAt).toBe(delivered[0]?.deliveredAt);
    expect(store.markDelivered([question.id])).toEqual([]);
    expect(events.filter((e) => e.type === 'message.updated')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'message.updated', message: { id: question.id } });
  });
});
