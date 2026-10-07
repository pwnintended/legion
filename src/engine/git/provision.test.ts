import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchGlob } from './glob';
import {
  detectLockfile,
  expandGlobs,
  installCommand,
  LegionConfigError,
  loadLegionConfig,
  lockfileCommand,
  portBase,
  provisionFiles,
  runShellCommand,
  runShellCommands,
} from './provision';
import { tmp, writeFiles } from './test-helpers';

const cleanups: (() => void)[] = [];
function dir() {
  const t = tmp('legion-prov-');
  cleanups.push(t.cleanup);
  return t.path;
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('legion.json', () => {
  it('returns null when absent, parses valid, rejects invalid', async () => {
    const d = dir();
    expect(await loadLegionConfig(d)).toBeNull();
    writeFileSync(
      join(d, 'legion.json'),
      JSON.stringify({ setup: ['pnpm i'], copy: ['.env*'], highRiskGlobs: ['db/**'] }),
    );
    expect(await loadLegionConfig(d)).toEqual({ setup: ['pnpm i'], copy: ['.env*'], highRiskGlobs: ['db/**'] });
    writeFileSync(join(d, 'legion.json'), JSON.stringify({ setup: 'nope' }));
    await expect(loadLegionConfig(d)).rejects.toBeInstanceOf(LegionConfigError);
    writeFileSync(join(d, 'legion.json'), '{ not json');
    await expect(loadLegionConfig(d)).rejects.toThrow(/invalid JSON/);
  });
});

describe('lockfiles', () => {
  it('detects the package manager and default install command', async () => {
    const d = dir();
    expect(await installCommand(d)).toBeNull();
    writeFiles(d, { 'package-lock.json': '{}' });
    expect(await installCommand(d)).toBe('npm ci');
    writeFiles(d, { 'yarn.lock': '' });
    expect((await detectLockfile(d))?.manager).toBe('yarn');
    writeFiles(d, { 'pnpm-lock.yaml': '' });
    expect(await installCommand(d)).toBe('pnpm install --frozen-lockfile');
    expect(await installCommand(d, { installCommand: 'make deps' })).toBe('make deps');
    const b = dir();
    writeFiles(b, { 'bun.lock': '' });
    expect(await installCommand(b)).toBe('bun install --frozen-lockfile');
  });

  it('regenerates lockfiles with a non-frozen command, overridable in legion.json', async () => {
    const d = dir();
    expect(await lockfileCommand(d)).toBeNull();
    writeFiles(d, { 'package-lock.json': '{}' });
    expect(await lockfileCommand(d)).toBe('npm install --package-lock-only');
    writeFiles(d, { 'yarn.lock': '' });
    expect(await lockfileCommand(d)).toBe('yarn install');
    writeFiles(d, { 'pnpm-lock.yaml': '' });
    expect(await lockfileCommand(d)).toBe('pnpm install --lockfile-only');
    expect(await lockfileCommand(d, { lockfileCommand: 'make lock' })).toBe('make lock');
    const b = dir();
    writeFiles(b, { 'bun.lock': '' });
    expect(await lockfileCommand(b)).toBe('bun install --lockfile-only');
  });
});

describe('glob', () => {
  it('matches', () => {
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/c.ts')).toBe(false);
    expect(matchGlob('src/engine', 'src/engine/git/x.ts')).toBe(true);
    expect(matchGlob('src/engine', 'src/engine2/x.ts')).toBe(false);
    expect(matchGlob('src/engine/', 'src/engine/x.ts')).toBe(true);
    expect(matchGlob('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(matchGlob('.env*', '.env.local')).toBe(true);
    expect(matchGlob('file?.txt', 'file1.txt')).toBe(true);
    expect(matchGlob('**/package.json', 'package.json')).toBe(true);
    expect(matchGlob('**/package.json', 'a/b/package.json')).toBe(true);
    expect(matchGlob('a.b', 'aXb')).toBe(false);
  });
});

describe('provisionFiles', () => {
  it('copies and symlinks matching files, skips node_modules, never overwrites', async () => {
    const root = dir();
    const wt = dir();
    writeFiles(root, {
      '.env': 'A=1',
      '.env.local': 'B=2',
      'config/secret.pem': 'KEY',
      'node_modules/x/.env': 'no',
      'src/.env': 'nested',
    });
    writeFiles(wt, { '.env.local': 'existing' });
    const r = await provisionFiles(root, wt, { copy: ['.env*'], symlink: ['config/*.pem'] });
    expect(r.copied).toEqual(['.env']);
    expect(r.skipped).toEqual(['.env.local']);
    expect(r.symlinked).toEqual(['config/secret.pem']);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('A=1');
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('existing');
    expect(lstatSync(join(wt, 'config/secret.pem')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt, 'src/.env'))).toBe(false);
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });

  it('rejects patterns escaping the repo', async () => {
    const root = dir();
    mkdirSync(join(root, 'x'));
    await expect(expandGlobs(root, ['../secrets'])).rejects.toThrow(/unsafe/);
    await expect(expandGlobs(root, ['/etc/passwd'])).rejects.toThrow(/unsafe/);
  });
});

describe('commands', () => {
  const env = { rootPath: '/root/main', taskId: 'T7', runId: 'run_abc' };

  it('passes LEGION_* env, captures exit code, duration, output', async () => {
    const d = dir();
    const r = await runShellCommand(
      'echo "$LEGION_ROOT_PATH $LEGION_TASK_ID $LEGION_RUN_ID $LEGION_PORT_BASE"; echo err >&2',
      {
        cwd: d,
        env,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.outputTail).toContain(`/root/main T7 run_abc ${portBase('run_abc', 'T7')}`);
    expect(r.outputTail).toContain('err');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failures, truncates output, stops at first failure, handles timeouts', async () => {
    const d = dir();
    const f = await runShellCommand('seq 1 5000; exit 3', { cwd: d, env, maxOutputChars: 100 });
    expect(f.exitCode).toBe(3);
    expect(f.outputTail.length).toBeLessThanOrEqual(100);
    expect(f.outputTail.endsWith('5000')).toBe(true);

    const seq = await runShellCommands(['true', 'false', 'echo never'], { cwd: d, env });
    expect(seq.ok).toBe(false);
    expect(seq.results.map((r) => r.command)).toEqual(['true', 'false']);

    const t = await runShellCommand('sleep 5', { cwd: d, env, timeoutMs: 100 });
    expect(t.exitCode).toBeNull();
    expect(t.timedOut).toBe(true);
  });

  it('port blocks are deterministic, in range and aligned', () => {
    expect(portBase('r', 'T1')).toBe(portBase('r', 'T1'));
    for (let i = 0; i < 50; i++) {
      const p = portBase('run_x', `T${i}`);
      expect(p).toBeGreaterThanOrEqual(40000);
      expect(p + 20).toBeLessThanOrEqual(60000);
      expect((p - 40000) % 20).toBe(0);
    }
  });
});
