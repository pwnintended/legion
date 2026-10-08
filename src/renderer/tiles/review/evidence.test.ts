import type { Review, Task, TaskNode, Verification } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import {
  classifyCommand,
  commandLabel,
  gateReasons,
  gatesChip,
  gatesFor,
  latestVerifications,
  taskGates,
  trackFindings,
} from './evidence';

const v = (
  id: string,
  command: string,
  attemptId: string,
  createdAt: number,
  exitCode = 0,
  outputTail = 'ok',
): Verification => ({
  id,
  runId: 'run_1',
  taskId: 'task_1',
  attemptId,
  phase: 'task',
  command,
  exitCode,
  outputTail,
  durationMs: 1500,
  createdAt,
});

/** A structured gate row, as the engine records it since gates exist. */
const g = (
  id: string,
  gate: string,
  status: 'pass' | 'fail' | 'skipped',
  opts: Partial<Verification> = {},
): Verification => {
  const kind = gate === 'scope' || gate === 'secrets' ? gate : 'command';
  return {
    ...v(id, kind === 'command' ? `pnpm ${gate}` : `legion:${gate}`, 'att_1', Number(id.slice(1)) || 1),
    exitCode: status === 'fail' ? 1 : 0,
    gate,
    kind,
    status,
    summary: `${gate} ${status}`,
    blocking: true,
    ...opts,
  };
};

const review = (id: string, createdAt: number, findings: Review['findings']): Review => ({
  id,
  runId: 'run_1',
  taskId: 'task_1',
  attemptId: `att_${id}`,
  verdict: findings.some((f) => f.severity === 'major') ? 'request_changes' : 'approve',
  criteria: [],
  findings,
  summary: '',
  createdAt,
});

const finding = (title: string, severity: Review['findings'][number]['severity'] = 'major') => ({
  severity,
  file: 'a.sql',
  line: 3,
  title,
  body: 'body',
  suggestedFix: null,
});

describe('gates', () => {
  it('classifies verify commands', () => {
    expect(classifyCommand('pnpm vitest run db')).toBe('tests');
    expect(classifyCommand('pnpm test')).toBe('tests');
    expect(classifyCommand('pnpm typecheck')).toBe('typecheck');
    expect(classifyCommand('biome check .')).toBe('lint');
    expect(classifyCommand('gitleaks detect')).toBe('secrets');
    expect(classifyCommand('pnpm db:migrate:check')).toBe('verify');
    expect(commandLabel('pnpm typecheck && pnpm run test')).toBe('typecheck && test');
  });

  it('uses the latest verified attempt and adds a scope check', () => {
    const verifications = [
      v('v1', 'pnpm test', 'att_1', 1, 1),
      v('v2', 'pnpm test', 'att_2', 5, 0, '✓ 10 passed (2.3s)'),
      v('v3', 'pnpm lint', 'att_2', 6),
    ];
    const latest = latestVerifications(verifications, 'task_1');
    expect(latest.map((x) => x.id)).toEqual(['v2', 'v3']);
    const node: Pick<TaskNode, 'touches'> = { touches: [{ glob: 'migrations/**', mode: 'create' }] };
    const gates = gatesFor({ node, verifications: latest, changedFiles: ['migrations/1.sql', 'src/x.ts'] });
    expect(gates.map((g) => [g.label, g.ok])).toEqual([
      ['Tests', true],
      ['Lint', true],
      ['Scope', false],
    ]);
    expect(gates[0]?.evidence).toBe('✓ 10 passed (2.3s)');
    expect(gates[2]?.evidence).toContain('src/x.ts');
  });
});

describe('structured gates', () => {
  it('maps gate rows: label from the gate, ok from the status, summary and duration as evidence', () => {
    const gates = gatesFor({
      node: null,
      verifications: [
        g('v1', 'test', 'pass', { summary: '✓ 10 passed (2.3s)' }),
        g('v2', 'db:migrate:check', 'fail', { summary: 'exit code 1' }),
        g('v3', 'scope', 'pass', { summary: '4/4 files declared' }),
        g('v4', 'secrets', 'pass', { summary: 'no secrets in 120 added lines' }),
      ],
      changedFiles: null,
    });
    expect(gates.map((x) => [x.label, x.ok, x.status, x.blocking, x.command])).toEqual([
      ['test', true, 'pass', true, 'pnpm test'],
      ['db:migrate:check', false, 'fail', true, 'pnpm db:migrate:check'],
      ['Scope', true, 'pass', true, null],
      ['Secret scan', true, 'pass', true, null],
    ]);
    expect(gates[0]?.evidence).toBe('✓ 10 passed (2.3s)');
    expect(gates[1]?.evidence).toBe('exit code 1 · 1.5s');
    expect(gates[2]?.evidence).toBe('4/4 files declared');
    expect(gates.every((x) => x.verificationId === x.key)).toBe(true);
    expect(gatesChip(gates)).toMatchObject({ green: 3, total: 4, tone: 'bad' });
  });

  it('warns when only non-blocking gates failed', () => {
    const gates = gatesFor({
      node: null,
      verifications: [g('v1', 'test', 'pass'), g('v2', 'lint', 'fail', { blocking: false })],
      changedFiles: null,
    });
    expect(gates.find((x) => x.label === 'lint')).toMatchObject({ ok: false, blocking: false });
    expect(gatesChip(gates)).toEqual({ green: 1, total: 2, warnings: 1, tone: 'warn' });
    expect(gatesChip(gates.slice(0, 1)).tone).toBe('ok');
  });

  it('lists skipped gates without counting them', () => {
    const gates = gatesFor({
      node: null,
      verifications: [g('v1', 'test', 'pass'), g('v2', 'secrets', 'skipped', { summary: 'secret scan off' })],
      changedFiles: null,
    });
    expect(gates.map((x) => [x.label, x.ok, x.status])).toEqual([
      ['test', true, 'pass'],
      ['Secret scan', null, 'skipped'],
    ]);
    expect(gates[1]?.evidence).toBe('secret scan off');
    expect(gatesChip(gates)).toMatchObject({ green: 1, total: 1, tone: 'ok' });
  });

  it('keeps the persisted scope row instead of checking the scope client-side', () => {
    const node: Pick<TaskNode, 'touches'> = { touches: [{ glob: 'migrations/**', mode: 'create' }] };
    const gates = gatesFor({
      node,
      verifications: [g('v1', 'scope', 'fail', { summary: '1 file outside the declared touches', blocking: false })],
      changedFiles: ['migrations/1.sql', 'src/x.ts'],
    });
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ key: 'v1', label: 'Scope', ok: false, blocking: false, command: null });
    expect(gatesChip(gates).tone).toBe('warn');
  });

  it('renders legacy rows through the command classification, with a non-blocking client-side scope', () => {
    const node: Pick<TaskNode, 'touches'> = { touches: [{ glob: 'src/**', mode: 'modify' }] };
    const gates = gatesFor({
      node,
      verifications: [v('v1', 'pnpm typecheck', 'att_1', 1, 2, 'error TS2304')],
      changedFiles: ['src/a.ts'],
    });
    expect(gates.map((x) => [x.label, x.ok, x.status, x.blocking, x.command])).toEqual([
      ['Typecheck', false, 'fail', true, 'pnpm typecheck'],
      ['Scope', true, 'pass', false, null],
    ]);
    expect(gates[1]?.verificationId).toBeNull();
    expect(gatesChip(gates)).toMatchObject({ green: 1, total: 2, tone: 'bad' });
  });

  it('derives the same legacy gates, scope included, for the review pack and the merge-gate card', () => {
    const node: Pick<TaskNode, 'touches'> = { touches: [{ glob: 'migrations/**', mode: 'create' }] };
    const gates = taskGates({
      taskId: 'task_1',
      node,
      verifications: [
        v('v1', 'pnpm test', 'att_1', 1),
        v('v2', 'pnpm lint', 'att_1', 2),
        { ...v('v3', 'pnpm test', 'att_9', 9, 1), taskId: 'task_2' },
      ],
      attempts: [
        { id: 'att_1', taskId: 'task_1', role: 'coder' },
        { id: 'att_r', taskId: 'task_1', role: 'reviewer' },
        { id: 'att_9', taskId: 'task_2', role: 'coder' },
      ],
      diffstats: {
        att_1: { files: ['migrations/1.sql', 'src/x.ts'] },
        att_r: { files: ['reviewer.txt'] },
        att_9: { files: ['other.ts'] },
      },
    });
    expect(gates.map((x) => [x.label, x.ok])).toEqual([
      ['Tests', true],
      ['Lint', true],
      ['Scope', false],
    ]);
    expect(gates[2]?.evidence).toBe('1 outside: src/x.ts');
    expect(gatesChip(gates)).toEqual({ green: 2, total: 3, warnings: 1, tone: 'warn' });
  });

  it('groups the latest attempt by gate name', () => {
    const latest = latestVerifications(
      [
        g('v1', 'test', 'fail', { attemptId: 'att_1', createdAt: 1 }),
        g('v2', 'test', 'pass', { attemptId: 'att_2', createdAt: 5, command: 'pnpm test' }),
        // Same command, another gate name: two gates.
        g('v3', 'test-2', 'pass', { attemptId: 'att_2', createdAt: 6, command: 'pnpm test' }),
        g('v4', 'test', 'pass', { attemptId: 'att_2', createdAt: 7, command: 'pnpm vitest run' }),
      ],
      'task_1',
    );
    expect(latest.map((x) => x.id)).toEqual(['v4', 'v3']);
  });
});

describe('findings across rounds', () => {
  it('marks findings gone from the latest review as resolved', () => {
    const tracked = trackFindings([
      review('r1', 1, [finding('Counter overflows'), finding('Column comment', 'nit')]),
      review('r2', 2, [finding('Index on user_id', 'minor')]),
    ]);
    expect(tracked.map((t) => [t.finding.title, t.state, t.round])).toEqual([
      ['Index on user_id', 'open', 2],
      ['Counter overflows', 'resolved', 1],
      ['Column comment', 'resolved', 1],
    ]);
  });

  it('keeps a repeated finding open at its latest round', () => {
    const tracked = trackFindings([review('r1', 1, [finding('Same')]), review('r2', 2, [finding('Same')])]);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ state: 'open', round: 2 });
  });
});

describe('human gate reasons', () => {
  it('explains high risk and high-risk globs', () => {
    const task = { id: 'task_1', nodeId: 'T4', status: 'awaiting_human', fixRounds: 0 } as Task;
    const reasons = gateReasons({
      task,
      node: { risk: 'high' } as TaskNode,
      annotations: [{ kind: 'note', nodeIds: ['T4'], message: '[high_risk_glob] T4 writes migrations/**.' }],
      inbox: [],
      maxFixRounds: 2,
    });
    expect(reasons).toEqual([
      'T4 writes migrations/**.',
      'T4 is marked high-risk in the plan, so it waits for you even after the reviewer approves.',
    ]);
  });
});
