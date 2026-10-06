import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'layout');

/** Launch the built app and switch the renderer to demo mode (fixture data, frozen agents). */
async function launchDemo(): Promise<{ app: ElectronApplication; window: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-layout-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.evaluate(() => {
    localStorage.setItem('legion.demo', '1');
    localStorage.setItem('legion.demo.live', '0');
  });
  await window.reload();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(1440, 900);
    win?.focus();
  });
  return { app, window, home };
}

const focusedTile = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-id');

const columnOrder = (window: Page) =>
  window.locator('[data-column]').evaluateAll((els) => els.map((el) => el.getAttribute('data-column')));

test('demo workspace: strip, keyboard focus/move, layout modes', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    // Chrome: demo badge, three runs in the rail, the passkeys run active.
    await expect(window.getByTestId('titlebar')).toContainText('demo', { timeout: 30_000 });
    await expect(window.getByTestId('rail-run')).toHaveCount(3);
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await expect(window.locator('[data-tile-id="session:T2"]')).toBeVisible();
    await expect(window.getByTestId('mode-pill')).toHaveText('NORMAL');
    await expect(window.getByTestId('needs-you')).toContainText('needs you 3');

    // Initial layout: plan, thin T1, then live tasks; T3 (approval pending) pulses.
    expect((await columnOrder(window)).slice(0, 4)).toEqual(['col:plan', 'col:task:T1', 'col:task:T2', 'col:task:T3']);
    await expect(window.locator('[data-tile-id="session:T3"]')).toHaveAttribute('data-pulse', 'true');
    await expect(window.locator('[data-tile-id="review:T4"]')).toBeVisible();
    await window.waitForTimeout(600);
    await window.screenshot({ path: join(shots, 'strip.png') });

    // Keyboard focus: ⌘⌥L / ⌘⌥H move between columns.
    expect(await focusedTile(window)).toBe('session:T2');
    await window.keyboard.press('Meta+Alt+l');
    await expect.poll(() => focusedTile(window)).toBe('session:T3');
    // Focusing the urgent tile acknowledges it: the pulse stops, the peach border stays.
    await expect(window.locator('[data-tile-id="session:T3"]')).toHaveAttribute('data-pulse', 'false');
    await expect(window.locator('[data-tile-id="session:T3"]')).toHaveAttribute('data-urgent', 'true');
    await window.keyboard.press('Meta+Alt+ArrowLeft');
    await expect.poll(() => focusedTile(window)).toBe('session:T2');

    // Move: ⌘⌥⇧L swaps T2's column with T3's, ⌘⌥⇧H swaps it back.
    await window.keyboard.press('Meta+Alt+Shift+l');
    await expect.poll(async () => (await columnOrder(window)).slice(2, 4)).toEqual(['col:task:T3', 'col:task:T2']);
    await window.keyboard.press('Meta+Alt+Shift+h');
    await expect.poll(async () => (await columnOrder(window)).slice(2, 4)).toEqual(['col:task:T2', 'col:task:T3']);

    // Resize mode: ⌘R, l widens the focused column, esc leaves the mode.
    const widthBefore = await window.locator('[data-column="col:task:T2"]').evaluate((el) => el.clientWidth);
    await window.keyboard.press('Meta+r');
    await expect(window.getByTestId('mode-pill')).toHaveText('RESIZE');
    await window.keyboard.press('l');
    await expect
      .poll(() => window.locator('[data-column="col:task:T2"]').evaluate((el) => el.clientWidth))
      .toBeGreaterThan(widthBefore);
    await window.keyboard.press('h');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('mode-pill')).toHaveText('NORMAL');

    // Thin column expands on click, collapses again with ⌘⌥C.
    await window.locator('[data-tile-id="session:T1"] button').first().click();
    await expect(window.locator('[data-column="col:task:T1"] [data-tile-body]')).toBeVisible();
    await window.keyboard.press('Meta+Alt+c');
    await expect(window.locator('[data-column="col:task:T1"] [data-tile-body]')).toHaveCount(0);

    // ⌘U cycles urgent tiles across runs, oldest first: the PDF run's PR, the i18n plan, then T3's approval.
    await window.keyboard.press('Meta+u');
    await expect(window.getByTestId('titlebar')).toContainText('Invoice PDF export');
    await expect.poll(() => focusedTile(window)).toBe('pr');
    await window.keyboard.press('Meta+u');
    await expect(window.getByTestId('titlebar')).toContainText('Extract UI strings for i18n');
    await expect.poll(() => focusedTile(window)).toBe('plan');
    await window.keyboard.press('Meta+u');
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await expect.poll(() => focusedTile(window)).toBe('session:T3');

    // Focus mode (⌘⏎): master + stack.
    await window.keyboard.press('Meta+Alt+h');
    await window.keyboard.press('Meta+Enter');
    await expect(window.locator('[data-layout-mode="focus"]')).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'focus.png') });

    // Overview (⌘⇧O; ⌘⇥ is taken by macOS): one card per tile.
    await window.keyboard.press('Meta+Shift+o');
    await expect(window.getByTestId('overview')).toBeVisible();
    await expect(window.locator('[data-testid="overview"] .card')).toHaveCount(9);
    await window.waitForTimeout(700);
    await window.screenshot({ path: join(shots, 'overview.png') });

    // Pipeline (⌘G): DAG by depth.
    await window.keyboard.press('Meta+g');
    await expect(window.getByTestId('pipeline')).toBeVisible();
    await expect(window.locator('.pnode')).toHaveCount(6);
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'pipeline.png') });

    // Clicking a pipeline node jumps back to the strip with that task focused.
    await window.locator('.pnode', { hasText: 'Credential table migration' }).click();
    await expect(window.locator('[data-layout-mode="strip"]')).toBeVisible();
    await expect.poll(() => focusedTile(window)).toBe('session:T4');

    // Layout switcher + workspaces: ⌘3 opens the i18n run awaiting plan sign-off.
    await window.keyboard.press('Meta+3');
    await expect(window.getByTestId('titlebar')).toContainText('Extract UI strings for i18n');
    await expect(window.locator('[data-tile-id="plan"]')).toHaveAttribute('data-urgent', 'true');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'plan-signoff.png') });

    // Overlay state lives in the store: ⌘K opens the palette slot, Esc closes it.
    await window.keyboard.press('Meta+1');
    await window.keyboard.press('Meta+k');
    await expect.poll(() => window.locator('body').getAttribute('data-overlay')).toBe('palette');
    await window.keyboard.press('Escape');
    await expect.poll(() => window.locator('body').getAttribute('data-overlay')).toBe(null);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('empty state: onboarding with engine diagnostics', async () => {
  mkdirSync(shots, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-empty-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('onboarding')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('engine-info')).toContainText('engine ready', { timeout: 30_000 });
    await window.waitForTimeout(800);
    await window.screenshot({ path: join(shots, 'onboarding.png') });
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
