/**
 * The packaged app (`pnpm package` → dist/mac[-arm64]/Legion.app, dist/linux[-arm64]-unpacked/legion) starts, its
 * engine utilityProcess loads
 * node:sqlite and node-pty from the asar / asar.unpacked paths (engine self-test, `LEGION_SELFTEST=1`), and
 * the renderer connects. Opt-in: `pnpm test:packaged` (packages first); skipped in `pnpm test:e2e`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');

/** Where electron-builder's `--dir` output puts the executable and its resources on this OS. */
function packagedLayout(): { binary: string; resources: string } {
  // electron-builder names x64 output without the arch: dist/mac, dist/linux-unpacked.
  const arch = process.arch === 'x64' ? '' : `-${process.arch}`;
  if (process.platform === 'darwin') {
    const app = join(root, 'dist', `mac${arch}`, 'Legion.app');
    return { binary: join(app, 'Contents', 'MacOS', 'Legion'), resources: join(app, 'Contents', 'Resources') };
  }
  if (process.platform === 'linux') {
    const dir = join(root, 'dist', `linux${arch}-unpacked`);
    return { binary: join(dir, 'legion'), resources: join(dir, 'resources') };
  }
  throw new Error(`no packaged layout for ${process.platform}`);
}

test.skip(process.env.LEGION_E2E_PACKAGED !== '1', 'run with pnpm test:packaged');

test('packaged app: native modules and node:sqlite load, the renderer connects', async () => {
  const { binary, resources } = packagedLayout();
  expect(existsSync(binary)).toBe(true);
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
    expect(log).toMatch(/selftest ok: node-pty ok, node:sqlite schema v\d+/);
    expect(await launched.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    expect(existsSync(join(home, 'legion.db'))).toBe(true);
  } finally {
    await launched.close();
    rmSync(home, { recursive: true, force: true });
  }
});
