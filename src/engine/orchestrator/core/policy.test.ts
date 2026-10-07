import {
  canTransition,
  DEFAULT_SETTINGS,
  type ReviewFinding,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TaskStatus,
} from '@shared/domain';
import type { ReviewOutput } from '@shared/schemas';
import { describe, expect, it } from 'vitest';
import {
  attemptsRemaining,
  decideAfterCoderTurn,
  decideAfterFailure,
  decideAfterMerge,
  decideAfterReview,
  decideAfterVerify,
  decideEscalation,
  decideHumanGate,
  requiresHumanGate,
  type TaskDecision,
  taskStatusPath,
} from './policy';
import { checkScope } from './scope';
import { makeNode } from './testing';

const limits = DEFAULT_SETTINGS.limits;
const task = (status: TaskStatus, attemptCount = 1, fixRounds = 0) => ({ status, attemptCount, fixRounds });

function expectLegal(from: TaskStatus, d: TaskDecision) {
  let current = from;
  for (const next of d.path) {
    expect(canTransition(TASK_TRANSITIONS, current, next), `${current} → ${next}`).toBe(true);
    current = next;
  }
}

const finding = (severity: ReviewFinding['severity'], title = 'Bug'): ReviewFinding => ({
  severity,
  file: 'src/a.ts',
  line: 3,
  title,
  body: 'body',
  suggestedFix: null,
});
const review = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
  verdict: 'approve',
  criteria: [{ id: 'AC1', status: 'met', evidence: 'test passes' }],
  findings: [],
  summary: 'ok',
  ...over,
});
const lowNode = makeNode('T1');

describe('taskStatusPath', () => {
  it('finds legal paths between all reachable statuses', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const path = taskStatusPath(from, to);
        if (path === null) continue;
        expectLegal(from, { action: 'done', path, patch: {}, escalation: null, reason: '' });
        expect(path.at(-1) ?? from).toBe(to);
      }
    }
    expect(taskStatusPath('merged', 'queued')).toBeNull();
    expect(taskStatusPath('verifying', 'queued', ['failed'])).toEqual(['failed', 'queued']);
  });
});

describe('verify → review → fix loop', () => {
  it('reviews after a passing verify and fixes after a failing one', () => {
    expect(decideAfterVerify(task('verifying'), true, limits).path).toEqual(['reviewing']);
    const fix = decideAfterVerify(task('verifying'), false, limits);
    expect(fix).toMatchObject({ action: 'fix', path: ['fixing'], patch: { fixRounds: 1 }, escalation: null });
    const exhausted = decideAfterVerify(task('verifying', 1, 2), false, limits);
    expect(exhausted).toMatchObject({ action: 'escalate', path: ['awaiting_human'], escalation: 'verify_failed' });
  });

  it('approves only when every criterion is met and nothing blocks', () => {
    expect(decideAfterReview(task('reviewing'), review(), { node: lowNode }, limits).path).toEqual(['approved']);
    const withMinor = review({ findings: [finding('minor'), finding('nit')] });
    expect(decideAfterReview(task('reviewing'), withMinor, { node: lowNode }, limits).action).toBe('approve');
    const majorDespiteApprove = review({ findings: [finding('major')] });
    expect(decideAfterReview(task('reviewing'), majorDespiteApprove, { node: lowNode }, limits)).toMatchObject({
      action: 'fix',
      patch: { fixRounds: 1 },
    });
    const unclear = review({ criteria: [{ id: 'AC1', status: 'unclear', evidence: '?' }] });
    expect(decideAfterReview(task('reviewing'), unclear, { node: lowNode }, limits).action).toBe('fix');
  });

  it('gates high-risk work behind a human after approval', () => {
    const high = makeNode('T1', [], { risk: 'high' });
    const gated = decideAfterReview(task('reviewing'), review(), { node: high }, limits);
    expect(gated.path).toEqual(['approved', 'awaiting_human']);
    expectLegal('reviewing', gated);
    const migration = makeNode('T1', [], { writes: ['db/migrations/001.sql'] });
    expect(requiresHumanGate(migration, ['db/migrations/**'])).toBe(true);
    expect(requiresHumanGate(migration, ['infra/**'])).toBe(false);
    expect(decideHumanGate(task('awaiting_human'), true).path).toEqual(['merging']);
    expect(decideHumanGate(task('awaiting_human', 1, 1), false)).toMatchObject({ path: ['fixing'], patch: {} });
  });

  it('escalates after the maximum number of fix rounds', () => {
    const changes = review({ verdict: 'request_changes', findings: [finding('blocker')] });
    const d = decideAfterReview(task('reviewing', 1, 2), changes, { node: lowNode }, limits);
    expect(d).toMatchObject({ action: 'escalate', path: ['awaiting_human'], escalation: 'fix_rounds_exhausted' });
  });

  it('escalates early when the same findings come back', () => {
    const changes = review({ verdict: 'request_changes', findings: [finding('major', 'Off by one')] });
    const d = decideAfterReview(
      task('reviewing', 1, 1),
      changes,
      { node: lowNode, previousFindings: [finding('major', 'off by one ')] },
      limits,
    );
    expect(d.escalation).toBe('fix_rounds_exhausted');
  });

  it('escalates a reject_replan verdict', () => {
    const d = decideAfterReview(task('reviewing'), review({ verdict: 'reject_replan' }), { node: lowNode }, limits);
    expect(d).toMatchObject({ action: 'escalate', escalation: 'review_rejected' });
  });
});

describe('coder turns', () => {
  it('verifies reported work and escalates blocked agents', () => {
    expect(decideAfterCoderTurn(task('running'), { report: { status: 'done' }, changedFiles: 2 }, limits).path).toEqual(
      ['verifying'],
    );
    expect(decideAfterCoderTurn(task('fixing'), { report: { status: 'done' }, changedFiles: 0 }, limits).path).toEqual([
      'verifying',
    ]);
    expect(
      decideAfterCoderTurn(task('running'), { report: { status: 'blocked' }, changedFiles: 0 }, limits),
    ).toMatchObject({
      path: ['awaiting_human'],
      escalation: 'other',
    });
  });

  it('treats empty or unreported turns as failed attempts', () => {
    const empty = decideAfterCoderTurn(task('running'), { report: { status: 'done' }, changedFiles: 0 }, limits);
    expect(empty).toMatchObject({ action: 'retry', path: ['queued'] });
    const silent = decideAfterCoderTurn(task('running', 3), { report: null, changedFiles: 4 }, limits);
    expect(silent).toMatchObject({ action: 'fail', path: ['failed'], escalation: 'attempts_exhausted' });
  });
});

describe('retry policy', () => {
  it('allows three attempts in total by default', () => {
    expect(attemptsRemaining({ attemptCount: 1 }, limits)).toBe(2);
    const first = decideAfterFailure(task('running', 1, 1), { kind: 'agent_error', message: 'crash' }, limits);
    expect(first).toMatchObject({ action: 'retry', path: ['queued'], patch: { fixRounds: 0 } });
    const fromVerify = decideAfterFailure(task('verifying', 2), { kind: 'agent_error', message: 'x' }, limits);
    expect(fromVerify.path).toEqual(['failed', 'queued']);
    const last = decideAfterFailure(task('fixing', 3), { kind: 'agent_error', message: 'x' }, limits);
    expect(last).toMatchObject({ action: 'fail', path: ['failed'], escalation: 'attempts_exhausted' });
  });

  it('does not charge rate-limited attempts and escalates auth problems', () => {
    const limited = decideAfterFailure(task('running', 3), { kind: 'rate_limited', message: '5h window' }, limits);
    expect(limited).toMatchObject({ action: 'requeue', path: ['queued'], patch: { attemptCount: 2 } });
    const auth = decideAfterFailure(task('running'), { kind: 'auth', message: 'logged out' }, limits);
    expect(auth).toMatchObject({ action: 'escalate', path: ['awaiting_human'] });
  });

  it('produces legal paths from every active status', () => {
    const active: TaskStatus[] = ['provisioning', 'running', 'verifying', 'reviewing', 'fixing', 'approved', 'merging'];
    for (const status of active) {
      for (const kind of ['rate_limited', 'auth', 'agent_error', 'provision_failed'] as const) {
        for (const attempts of [1, 3])
          expectLegal(status, decideAfterFailure(task(status, attempts), { kind, message: '' }, limits));
      }
    }
  });
});

describe('merge step and escalations', () => {
  it('handles merge outcomes', () => {
    expect(decideAfterMerge(task('merging'), 'merged', 0, limits).path).toEqual(['merged']);
    expect(decideAfterMerge(task('merging'), 'conflict', 1, limits)).toMatchObject({ action: 'resolve', path: [] });
    expect(decideAfterMerge(task('merging'), 'conflict', 2, limits)).toMatchObject({
      action: 'escalate',
      path: ['awaiting_human'],
    });
    expect(decideAfterMerge(task('merging'), 'verify_failed', 0, limits)).toMatchObject({
      path: ['fixing'],
      patch: { fixRounds: 1 },
    });
    expect(decideAfterMerge(task('merging', 1, 2), 'verify_failed', 0, limits).escalation).toBe('verify_failed');
  });

  it('applies human escalation answers', () => {
    expect(decideEscalation(task('failed', 3, 2), 'retry')).toMatchObject({
      path: ['queued'],
      patch: { attemptCount: 0, fixRounds: 0 },
    });
    expect(decideEscalation(task('awaiting_human', 2, 2), 'edit').path).toEqual(['queued']);
    expect(decideEscalation(task('failed'), 'skip').path).toEqual(['skipped']);
    expect(decideEscalation(task('awaiting_human'), 'abort').path).toEqual(['cancelled']);
  });
});

describe('checkScope', () => {
  it('classifies changed files against declared touches', () => {
    const node = makeNode('T1', [], {
      touches: [
        { glob: 'src/api/**', mode: 'modify' },
        { glob: 'src/types.ts', mode: 'read' },
        { glob: 'docs/api.md', mode: 'create' },
      ],
    });
    const report = checkScope(
      node,
      ['src/api/users.ts', './src/types.ts', 'README.md', 'pnpm-lock.yaml'],
      ['pnpm-lock.yaml'],
    );
    expect(report).toEqual({
      inScope: ['pnpm-lock.yaml', 'src/api/users.ts'],
      outOfScope: ['README.md', 'src/types.ts'],
      readOnly: ['src/types.ts'],
      unusedTouches: ['docs/api.md'],
      ok: false,
    });
    expect(checkScope(node, ['src/api/x.ts']).ok).toBe(true);
  });
});

describe('resume steps for a human retry', () => {
  it('marks escalations whose work can be kept with the step to resume', () => {
    expect(decideAfterVerify(task('verifying', 1, 2), false, limits).resume).toBe('fix');
    expect(decideAfterMerge(task('merging', 1, 2), 'verify_failed', 0, limits).resume).toBe('fix');
    expect(decideAfterMerge(task('merging'), 'conflict', limits.maxResolverAttempts, limits).resume).toBe('merge');
    const blocked = decideAfterCoderTurn(task('running'), { report: { status: 'blocked' }, changedFiles: 0 }, limits);
    expect(blocked.resume).toBe('fix');
    expect(decideAfterFailure(task('running'), { kind: 'auth', message: 'x' }, limits).resume).toBe('code');
    expect(decideAfterFailure(task('running'), { kind: 'agent_error', message: 'x' }, limits).resume).toBeUndefined();
    expect(decideEscalation(task('awaiting_human', 2, 2), 'restart')).toMatchObject({
      path: ['queued'],
      patch: { attemptCount: 0, fixRounds: 0 },
    });
  });
});
