import { afterEach, describe, expect, it } from 'vitest';
import { DETECTORS, detectPackageManager, detectProjectGates } from './detect';
import { tmp, writeFiles } from './test-helpers';

const cleanups: (() => void)[] = [];
function dir(files: Record<string, string> = {}) {
  const t = tmp('legion-detect-');
  cleanups.push(t.cleanup);
  writeFiles(t.path, files);
  return t.path;
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
const scripts = { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' };
const gate = (name: string, command: string) => ({ name, command, blocking: true, source: 'detected' });

describe('detectPackageManager', () => {
  it('returns null without package.json or lockfile', async () => {
    expect(await detectPackageManager(dir())).toBeNull();
  });

  it('defaults to npm when only package.json exists', async () => {
    expect(await detectPackageManager(dir({ 'package.json': pkg({}) }))).toBe('npm');
  });

  it('uses the lockfile', async () => {
    expect(await detectPackageManager(dir({ 'package.json': pkg({}), 'pnpm-lock.yaml': '' }))).toBe('pnpm');
    expect(await detectPackageManager(dir({ 'package.json': pkg({}), 'yarn.lock': '' }))).toBe('yarn');
    expect(await detectPackageManager(dir({ 'package.json': pkg({}), 'bun.lockb': '' }))).toBe('bun');
    expect(await detectPackageManager(dir({ 'package.json': pkg({}), 'package-lock.json': '{}' }))).toBe('npm');
  });

  it('prefers the packageManager field over the lockfile', async () => {
    const d = dir({ 'package.json': pkg({ packageManager: 'pnpm@9.12.0' }), 'yarn.lock': '' });
    expect(await detectPackageManager(d)).toBe('pnpm');
    const d2 = dir({ 'package.json': pkg({ packageManager: 'yarn@4.1.0+sha512.abc' }), 'package-lock.json': '{}' });
    expect(await detectPackageManager(d2)).toBe('yarn');
  });

  it('ignores an unknown packageManager value', async () => {
    const d = dir({ 'package.json': pkg({ packageManager: 'deno@2' }), 'bun.lock': '' });
    expect(await detectPackageManager(d)).toBe('bun');
  });

  it('falls back to the lockfile when package.json is invalid', async () => {
    expect(await detectPackageManager(dir({ 'package.json': '{ nope', 'yarn.lock': '' }))).toBe('yarn');
    expect(await detectPackageManager(dir({ 'package.json': '{ nope' }))).toBeNull();
  });
});

describe('detectProjectGates', () => {
  it('has a node detector in the registry', () => {
    expect(DETECTORS.map((d) => d.id)).toEqual(['node']);
  });

  it('detects test, typecheck and lint with npm by default', async () => {
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts }) }))).toEqual([
      gate('test', 'npm test'),
      gate('typecheck', 'npm run typecheck'),
      gate('lint', 'npm run lint'),
    ]);
  });

  it('uses pnpm', async () => {
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts }), 'pnpm-lock.yaml': '' }))).toEqual([
      gate('test', 'pnpm test'),
      gate('typecheck', 'pnpm run typecheck'),
      gate('lint', 'pnpm run lint'),
    ]);
  });

  it('uses yarn', async () => {
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts }), 'yarn.lock': '' }))).toEqual([
      gate('test', 'yarn test'),
      gate('typecheck', 'yarn typecheck'),
      gate('lint', 'yarn lint'),
    ]);
  });

  it('uses bun run (not bun test)', async () => {
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts }), 'bun.lock': '' }))).toEqual([
      gate('test', 'bun run test'),
      gate('typecheck', 'bun run typecheck'),
      gate('lint', 'bun run lint'),
    ]);
  });

  it('uses the packageManager field', async () => {
    const d = dir({ 'package.json': pkg({ packageManager: 'pnpm@9', scripts: { test: 'vitest' } }), 'yarn.lock': '' });
    expect(await detectProjectGates(d)).toEqual([gate('test', 'pnpm test')]);
  });

  it('maps type-check to the typecheck gate, preferring typecheck', async () => {
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts: { 'type-check': 'tsc' } }) }))).toEqual([
      gate('typecheck', 'npm run type-check'),
    ]);
    const both = dir({ 'package.json': pkg({ scripts: { 'type-check': 'tsc', typecheck: 'tsc -b' } }) });
    expect(await detectProjectGates(both)).toEqual([gate('typecheck', 'npm run typecheck')]);
  });

  it('ignores the npm placeholder test script', async () => {
    const d = dir({
      'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } }),
    });
    expect(await detectProjectGates(d)).toEqual([gate('lint', 'npm run lint')]);
  });

  it('returns only the scripts that exist', async () => {
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts: { build: 'tsc', dev: 'vite' } }) }))).toEqual(
      [],
    );
    expect(await detectProjectGates(dir({ 'package.json': pkg({ name: 'x' }) }))).toEqual([]);
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts: { test: 42, lint: '' } }) }))).toEqual([]);
  });

  it('returns nothing for a missing or invalid package.json', async () => {
    expect(await detectProjectGates(dir())).toEqual([]);
    expect(await detectProjectGates(dir({ 'pnpm-lock.yaml': '' }))).toEqual([]);
    expect(await detectProjectGates(dir({ 'package.json': '{ "scripts": ' }))).toEqual([]);
    expect(await detectProjectGates(dir({ 'package.json': '["test"]' }))).toEqual([]);
    expect(await detectProjectGates(dir({ 'package.json': pkg({ scripts: ['test'] }) }))).toEqual([]);
  });
});
