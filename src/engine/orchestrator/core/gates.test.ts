import { GateNameSchema, type GateSpec } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import {
  type GateResult,
  gateCounts,
  gateNameFor,
  gatesPassed,
  normalizeGateResult,
  resolveGateSettings,
  resolveGates,
  summaryLine,
} from './gates';

const detected = (name: string, command: string): GateSpec => ({ name, command, blocking: true, source: 'detected' });

const DETECTED: GateSpec[] = [
  detected('test', 'pnpm test'),
  detected('typecheck', 'pnpm run typecheck'),
  detected('lint', 'pnpm run lint'),
];

function result(status: GateResult['status'], blocking = true, name = 'g'): GateResult {
  return {
    name,
    command: `pnpm ${name}`,
    exitCode: status === 'fail' ? 1 : 0,
    outputTail: '',
    durationMs: 1,
    kind: 'command',
    status,
    blocking,
    summary: '',
    source: 'config',
  };
}

describe('gateNameFor', () => {
  it('names package manager commands after their script', () => {
    expect(gateNameFor('pnpm test')).toBe('test');
    expect(gateNameFor('pnpm run typecheck')).toBe('typecheck');
    expect(gateNameFor('pnpm --filter web lint')).toBe('lint');
    expect(gateNameFor('pnpm -r test')).toBe('test');
    expect(gateNameFor('npm test')).toBe('test');
    expect(gateNameFor('npm t')).toBe('test');
    expect(gateNameFor('npm run lint')).toBe('lint');
    expect(gateNameFor('npm run-script lint -- --fix')).toBe('lint');
    expect(gateNameFor('npm -w web run lint')).toBe('lint');
    expect(gateNameFor('yarn typecheck')).toBe('typecheck');
    expect(gateNameFor('yarn run lint')).toBe('lint');
    expect(gateNameFor('bun run lint')).toBe('lint');
    expect(gateNameFor('bun test')).toBe('test');
    expect(gateNameFor('pnpm db:migrate:check')).toBe('db:migrate:check');
    expect(gateNameFor('CI=1 pnpm test && pnpm build')).toBe('test');
    expect(gateNameFor('pnpm run Test:Unit')).toBe('test:unit');
  });

  it('labels other commands by program and subcommand', () => {
    expect(gateNameFor('cargo test --all')).toBe('cargo-test');
    expect(gateNameFor('go test ./...')).toBe('go-test');
    expect(gateNameFor('tsc --noEmit -p tsconfig.json')).toBe('tsc');
    expect(gateNameFor('npx vitest run')).toBe('vitest-run');
    expect(gateNameFor('pnpm exec tsc --noEmit')).toBe('tsc');
    expect(gateNameFor('./scripts/check.sh')).toBe('check.sh');
    expect(gateNameFor('   ')).toBe('verify');
  });

  it('always yields a valid gate name of at most 40 characters', () => {
    for (const command of [
      'pnpm run some-really-long-script-name-that-goes-on-and-on-and-on',
      'make CHECK',
      '$(which python) -m pytest',
      '_weird --- thing',
      'pnpm run "quoted"',
    ]) {
      const name = gateNameFor(command);
      expect(GateNameSchema.safeParse(name).success, `${command} → ${name}`).toBe(true);
    }
  });
});

describe('resolveGateSettings', () => {
  it('defaults to detection on and blocking scope and secrets', () => {
    const defaults = { detect: true, scope: 'block', secrets: { mode: 'block', allow: [] } };
    expect(resolveGateSettings(null)).toEqual(defaults);
    expect(resolveGateSettings({})).toEqual(defaults);
    expect(resolveGateSettings({ gates: {} })).toEqual(defaults);
  });

  it('applies the configured values, the bare secrets mode included', () => {
    expect(resolveGateSettings({ gates: { detect: false, scope: 'warn', secrets: 'off' } })).toEqual({
      detect: false,
      scope: 'warn',
      secrets: { mode: 'off', allow: [] },
    });
    expect(resolveGateSettings({ gates: { secrets: { allow: ['fixtures/**'] } } }).secrets).toEqual({
      mode: 'block',
      allow: ['fixtures/**'],
    });
    expect(resolveGateSettings({ gates: { secrets: { mode: 'warn' } } }).secrets).toEqual({ mode: 'warn', allow: [] });
  });
});

describe('resolveGates', () => {
  it('uses the detected gates when nothing is configured', () => {
    expect(resolveGates({ config: null, detected: DETECTED, taskCommands: [] })).toEqual(DETECTED);
  });

  it('puts config over verify over detected', () => {
    const gates = resolveGates({
      config: {
        gates: { commands: { test: 'pnpm vitest run', e2e: { run: 'pnpm e2e', blocking: false } } },
        verify: ['pnpm run typecheck:all', 'pnpm run lint'],
      },
      detected: DETECTED,
      taskCommands: [],
    });
    expect(gates).toEqual([
      { name: 'test', command: 'pnpm vitest run', blocking: true, source: 'config' },
      { name: 'e2e', command: 'pnpm e2e', blocking: false, source: 'config' },
      { name: 'typecheck:all', command: 'pnpm run typecheck:all', blocking: true, source: 'verify' },
      { name: 'lint', command: 'pnpm run lint', blocking: true, source: 'verify' },
      { name: 'typecheck', command: 'pnpm run typecheck', blocking: true, source: 'detected' },
    ]);
  });

  it('suppresses names set to false', () => {
    const gates = resolveGates({
      config: { gates: { commands: { lint: false, test: false } }, verify: ['pnpm test'] },
      detected: DETECTED,
      taskCommands: [],
    });
    expect(gates.map((g) => g.name)).toEqual(['typecheck']);
  });

  it('drops detected gates with detect: false', () => {
    const gates = resolveGates({
      config: { gates: { detect: false, commands: { e2e: 'pnpm e2e' } }, verify: ['make check'] },
      detected: DETECTED,
      taskCommands: ['pnpm test'],
    });
    expect(gates).toEqual([
      { name: 'e2e', command: 'pnpm e2e', blocking: true, source: 'config' },
      { name: 'make-check', command: 'make check', blocking: true, source: 'verify' },
      { name: 'test', command: 'pnpm test', blocking: true, source: 'task' },
    ]);
  });

  it('adds task commands no gate already runs', () => {
    const gates = resolveGates({
      config: { verify: ['pnpm run lint'] },
      detected: DETECTED,
      taskCommands: ['pnpm test', ' pnpm run lint ', 'pnpm vitest run src/a.test.ts', 'pnpm vitest run src/a.test.ts'],
    });
    expect(gates.map((g) => [g.name, g.source])).toEqual([
      ['lint', 'verify'],
      ['test', 'detected'],
      ['typecheck', 'detected'],
      ['vitest', 'task'],
    ]);
  });

  it('gives colliding names a numeric suffix', () => {
    const gates = resolveGates({
      config: { gates: { commands: { test: 'pnpm vitest run' } }, verify: ['pnpm test', 'npm test'] },
      detected: DETECTED,
      taskCommands: ['yarn test', 'pnpm --filter web test'],
    });
    expect(gates.map((g) => [g.name, g.command])).toEqual([
      ['test', 'pnpm vitest run'],
      ['test-2', 'pnpm test'],
      ['test-3', 'npm test'],
      ['typecheck', 'pnpm run typecheck'],
      ['lint', 'pnpm run lint'],
      ['test-4', 'yarn test'],
      ['test-5', 'pnpm --filter web test'],
    ]);
  });

  it('keeps suffixed names within 40 characters', () => {
    const long = 'a'.repeat(40);
    const gates = resolveGates({
      config: { gates: { commands: { [long]: 'pnpm one' } } },
      detected: [],
      taskCommands: [`pnpm run ${long}`],
    });
    expect(gates[1]?.name).toBe(`${'a'.repeat(38)}-2`);
  });
});

describe('gateCounts / gatesPassed', () => {
  it('counts every ran gate, green and failed', () => {
    const results = [result('pass'), result('pass'), result('fail'), result('fail', false)];
    expect(gateCounts(results)).toEqual({ green: 2, total: 4, blockingFailed: 1, warnings: 1 });
    expect(gatesPassed(results)).toBe(false);
  });

  it('passes with warn-only failures', () => {
    const results = [result('pass'), result('fail', false)];
    expect(gateCounts(results)).toEqual({ green: 1, total: 2, blockingFailed: 0, warnings: 1 });
    expect(gatesPassed(results)).toBe(true);
  });

  it('excludes skipped gates from the total', () => {
    const results = [result('pass'), result('skipped'), result('skipped', false)];
    expect(gateCounts(results)).toEqual({ green: 1, total: 1, blockingFailed: 0, warnings: 0 });
    expect(gatesPassed(results)).toBe(true);
    expect(gateCounts([])).toEqual({ green: 0, total: 0, blockingFailed: 0, warnings: 0 });
    expect(gatesPassed([])).toBe(true);
  });
});

describe('normalizeGateResult', () => {
  it('keeps structured results', () => {
    const r = result('fail', false, 'e2e');
    expect(normalizeGateResult(r)).toBe(r);
  });

  it('turns legacy verify results into blocking command gates', () => {
    expect(
      normalizeGateResult({ command: 'pnpm test', exitCode: 1, outputTail: 'x\n\u001b[31m2 failed\u001b[39m\n\n' }),
    ).toEqual({
      command: 'pnpm test',
      exitCode: 1,
      outputTail: 'x\n\u001b[31m2 failed\u001b[39m\n\n',
      durationMs: null,
      name: 'test',
      kind: 'command',
      status: 'fail',
      blocking: true,
      summary: '2 failed',
      source: 'verify',
    });
    expect(normalizeGateResult({ command: 'make', exitCode: null, outputTail: '', durationMs: 5 })).toMatchObject({
      name: 'make',
      status: 'fail',
      summary: 'killed or timed out',
      durationMs: 5,
    });
    expect(normalizeGateResult({ command: 'legion:scope', exitCode: 0, outputTail: '' })).toMatchObject({
      name: 'scope',
      kind: 'scope',
      status: 'pass',
      summary: 'passed',
      source: 'builtin',
    });
  });
});

describe('summaryLine', () => {
  it('takes the last non-empty line, clipped, or the fallback', () => {
    expect(summaryLine('a\r\n  Tests 3 passed  \n\n', 'x')).toBe('Tests 3 passed');
    expect(summaryLine(' \n', 'exit code 2')).toBe('exit code 2');
    const line = summaryLine('y'.repeat(500), '');
    expect(line).toHaveLength(160);
    expect(line.endsWith('…')).toBe(true);
  });
});
