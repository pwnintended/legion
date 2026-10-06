import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');

test('launches, connects the renderer to the engine over MessagePort RPC, and shows engine info', async () => {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;

  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  try {
    const window = await app.firstWindow();
    const info = window.getByTestId('engine-info');
    await expect(info).toBeVisible({ timeout: 30_000 });
    await expect(info).toContainText('engine ready');
    await expect(info).toContainText(join(home, 'legion.db'));
    await expect(info).toContainText(/electron \d+\./);
    await expect(window.getByTestId('connection-status')).toHaveText('connected');

    // The DB was created by the engine utilityProcess (node:sqlite inside Electron's runtime).
    expect(existsSync(join(home, 'legion.db'))).toBe(true);

    // Security posture of the renderer.
    const exposed = await window.evaluate(() => ({
      hasRequire: typeof (globalThis as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (globalThis as { process?: unknown }).process !== 'undefined',
      bridgeKeys: Object.keys((globalThis as unknown as { legion: object }).legion).sort(),
    }));
    expect(exposed).toEqual({
      hasRequire: false,
      hasProcess: false,
      bridgeKeys: ['openExternal', 'pickDirectory', 'platform', 'requestEnginePort', 'showItemInFolder'],
    });

    // Survives a renderer reload: a fresh port is wired and info is shown again.
    await window.reload();
    await expect(window.getByTestId('engine-info')).toContainText('engine ready', { timeout: 30_000 });

    // Survives an engine crash: the supervisor restarts it and re-wires the renderer's port.
    const pidCell = window.getByTestId('info-engine-pid');
    const pid = Number(await pidCell.textContent());
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGKILL');
    await expect(pidCell).not.toHaveText(String(pid), { timeout: 30_000 });
    await expect(pidCell).toHaveText(/^\d+$/);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
