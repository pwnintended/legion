import { describe, expect, it } from 'vitest';
import { gatesPassed } from './gates';
import { checkScope, scopeGateResult } from './scope';
import { makeNode } from './testing';

const node = makeNode('T1', [], {
  touches: [
    { glob: 'src/reports/**', mode: 'modify' },
    { glob: 'src/shared/domain.ts', mode: 'read' },
  ],
});

describe('scopeGateResult', () => {
  it('passes when every changed file is declared', () => {
    const report = checkScope(node, ['src/reports/csv.ts', 'src/reports/csv.test.ts']);
    const result = scopeGateResult(report, 'block');
    expect(result).toMatchObject({
      name: 'scope',
      kind: 'scope',
      command: 'legion:scope',
      source: 'builtin',
      status: 'pass',
      blocking: true,
      exitCode: 0,
      summary: '2/2 files declared',
      outputTail: '',
    });
    expect(gatesPassed([result])).toBe(true);
  });

  it('blocks on out-of-scope files in block mode', () => {
    const report = checkScope(node, ['src/reports/csv.ts', 'src/app.ts', 'src/shared/domain.ts']);
    const result = scopeGateResult(report, 'block');
    expect(result).toMatchObject({ name: 'scope', status: 'fail', blocking: true, exitCode: 1 });
    expect(result.summary).toBe('2 outside: src/app.ts, src/shared/domain.ts');
    expect(result.outputTail).toContain('- src/app.ts\n');
    expect(result.outputTail).toContain('- src/shared/domain.ts (declared read-only)');
    expect(result.outputTail).toContain('Revert these changes, or keep each one minimal and justify it');
    expect(result.outputTail).not.toContain('src/reports/csv.ts');
    expect(gatesPassed([result])).toBe(false);
  });

  it('only warns in warn mode', () => {
    const result = scopeGateResult(checkScope(node, ['src/app.ts']), 'warn');
    expect(result).toMatchObject({ status: 'fail', blocking: false, summary: '1 outside: src/app.ts' });
    expect(gatesPassed([result])).toBe(true);
  });

  it('names the first files and counts the rest', () => {
    const result = scopeGateResult(checkScope(node, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']), 'block');
    expect(result.summary).toBe('5 outside: a.ts, b.ts, c.ts +2 more');
    expect(result.outputTail).toContain('- e.ts');
  });

  it('does not count alwaysAllowed lockfiles as out of scope', () => {
    const changed = ['src/reports/csv.ts', 'pnpm-lock.yaml', 'packages/web/pnpm-lock.yaml'];
    expect(scopeGateResult(checkScope(node, changed), 'block')).toMatchObject({
      status: 'fail',
      summary: '2 outside: packages/web/pnpm-lock.yaml, pnpm-lock.yaml',
    });
    const allowed = scopeGateResult(checkScope(node, changed, ['**/pnpm-lock.yaml']), 'block');
    expect(allowed).toMatchObject({ status: 'pass', summary: '3/3 files declared', outputTail: '' });
  });
});
