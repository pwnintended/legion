import type { Review, Task, TaskNode, Verification } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { classifyCommand, commandLabel, gateReasons, gatesFor, latestVerifications, trackFindings } from './evidence';

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
