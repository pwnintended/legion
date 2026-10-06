/**
 * The packaged app (`pnpm package` → dist/mac-<arch>/Legion.app) starts, its engine utilityProcess loads
 * node:sqlite and node-pty from the asar / asar.unpacked paths (engine self-test, `LEGION_SELFTEST=1`), and
 * the renderer connects. Opt-in: `pnpm test:packaged` (packages first); skipped in `pnpm test:e2e`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const app = join(root, 'dist', `mac-${process.arch}`, 'Legion.app');
const binary = join(app, 'Contents', 'MacOS', 'Legion');

test.skip(process.env.LEGION_E2E_PACKAGED !== '1', 'run with pnpm test:packaged');

test('packaged Legion.app: native modules and node:sqlite load, the renderer connects', async () => {
  expect(existsSync(binary)).toBe(true);
  const resources = join(app, 'Contents', 'Resources');
  expect(existsSync(join(resources, 'app.asar'))).toBe(true);
  expect(existsSync(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'))).toBe(true);

  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-packaged-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const launched = await electron.launch({
    executablePath: binary,
    env: { ...env, LEGION_HOME: home, LEGION_FAKE_ENGINES: '1', LEGION_SELFTEST: '1' },
  });
  let log = '';
  const capture = (chunk: Buffer) => {
    log += chunk.toString();
  };
  launched.process().stdout?.on('data', capture);
  launched.process().stderr?.on('data', capture);
  try {
    const window = await launched.firstWindow();
    await expect(window.getByTestId('engine-info')).toContainText('engine ready', { timeout: 30_000 });
    await expect(window.getByTestId('connection-status')).toHaveText('connected');
    await expect(window.getByTestId('engine-info')).toContainText(join(home, 'legion.db'));
    await expect.poll(() => log, { timeout: 20_000 }).toMatch(/selftest (ok|failed)/);
    expect(log).toContain('selftest ok: node-pty ok, node:sqlite schema v2');
    expect(await launched.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    expect(existsSync(join(home, 'legion.db'))).toBe(true);
  } finally {
    await launched.close();
    rmSync(home, { recursive: true, force: true });
  }
});
