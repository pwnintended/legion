import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'session');

/** Launch the built app in demo mode (fixture data, frozen agents). */
async function launchDemo(): Promise<{ app: ElectronApplication; window: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-session-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.evaluate(() => {
    localStorage.clear();
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

test('session tiles, approvals, composer, inbox, palette, clarify', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login', { timeout: 30_000 });
    const t2 = window.locator('[data-tile-id="session:T2"]');
    const t3 = window.locator('[data-tile-id="session:T3"]');
    await expect(t2.getByText('Read 3 files')).toBeVisible();
    await expect(t3.getByTestId('approval-card')).toBeVisible();
    // Bring T2 and T3 side by side.
    await window.keyboard.press('Meta+Alt+l');
    await expect.poll(() => focusedTile(window)).toBe('session:T3');
    await window.waitForTimeout(700);
    await window.screenshot({ path: join(shots, 'strip-sessions.png') });

    // Inbox (⌘I) across runs, approvals first; Esc closes and gives focus back to the tile.
    await window.keyboard.press('Meta+i');
    const inbox = window.getByTestId('inbox');
    await expect(inbox.getByTestId('inbox-item')).toHaveCount(5);
    await expect(inbox.getByTestId('inbox-item').first()).toHaveAttribute('data-kind', 'approval');
    await expect(inbox.getByTestId('inbox-item').first()).toContainText('blocks T5, T6');
    await window.waitForTimeout(450);
    await window.screenshot({ path: join(shots, 'inbox.png') });
    await window.keyboard.press('Escape');
    await expect(inbox).toHaveCount(0);
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.getAttribute('data-tile-id') ?? null))
      .toBe('session:T3');

    // Approval: `a` on the focused tile accepts it.
    await expect(t3.getByTestId('approval-card').locator('.kbd').first()).toHaveText('A');
    await t3.screenshot({ path: join(shots, 'approval.png') });
    await window.keyboard.press('a');
    await expect(t3.getByTestId('approval-card')).toHaveCount(0);
    await expect(t3.getByTestId('approval-resolved')).toContainText('Accepted');
    await expect(t3).toHaveAttribute('data-urgent', 'false');
    await window.waitForTimeout(400);
    await t3.screenshot({ path: join(shots, 'approval-accepted.png') });

    // Composer (⌘N): validation, repo inspection, issue link detection.
    await window.keyboard.press('Meta+n');
    const composer = window.getByTestId('composer');
    await expect(composer).toBeVisible();
    await expect(composer.getByTestId('repo-status')).toContainText('erudiet/app');
    await window.keyboard.press('Meta+Enter');
    await expect(composer.getByText('Describe the work or paste an issue URL.')).toBeVisible();
    await window.keyboard.type('Add audit logging to admin actions https://github.com/erudiet/app/issues/512');
    await expect(composer.getByTestId('composer-link')).toContainText('erudiet/app#512');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'composer.png') });
    // Overlays own their keys: ⌘⏎ with focus on a button inside the composer submits it (it is not the global
    // ⌘⏎ Focus layout binding).
    await composer.locator('[data-engine="codex"]').focus();
    await window.keyboard.press('Meta+Enter');
    await expect(composer).toHaveCount(0);
    await expect(window.getByTestId('titlebar')).toContainText('Add audit logging to admin actions');
    await expect(window.locator('[data-layout-mode="strip"]')).toBeVisible();

    // Inbox again: the approval is gone; j/k move, ⏎ jumps to the item's tile.
    await window.keyboard.press('Meta+i');
    await expect(inbox.getByTestId('inbox-item')).toHaveCount(4);
    await expect(inbox.getByTestId('inbox-item').first()).toHaveAttribute('data-kind', 'question');
    await window.keyboard.press('j');
    await expect(inbox.getByTestId('inbox-item').nth(1)).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('k');
    await window.keyboard.press('Enter');
    await expect(inbox).toHaveCount(0);
    await expect(window.getByTestId('titlebar')).toContainText('Rate-limit the public API');
    await expect.poll(() => focusedTile(window)).toBe('clarify');

    // Clarify: chips + free text, submit.
    const clarify = window.getByTestId('clarify');
    await expect(clarify).toBeVisible();
    await clarify.getByRole('radio', { name: 'Per API key, falling back to IP' }).click();
    await clarify.getByRole('radio', { name: '429 with Retry-After' }).click();
    await clarify.getByLabel('Answer to question 3').fill('/healthz and /webhooks/*');
    await clarify.locator('.cl-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, 'clarify.png') });
    await clarify.getByTestId('clarify-submit').click();
    await expect(window.locator('[data-tile-id="clarify"]')).toHaveCount(0);

    // Palette (⌘K): fuzzy task ids, jump.
    await window.keyboard.press('Meta+1');
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await window.keyboard.press('Meta+k');
    const palette = window.getByTestId('palette');
    await expect(palette).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'palette.png') });
    await window.keyboard.type('t4');
    await window.waitForTimeout(250);
    await window.screenshot({ path: join(shots, 'palette-search.png') });
    await window.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect.poll(() => focusedTile(window)).toBe('session:T4');

    // Focus mode on a busy session.
    await window.keyboard.press('Meta+Alt+h');
    await window.keyboard.press('Meta+Alt+h');
    await expect.poll(() => focusedTile(window)).toBe('session:T2');
    await window.keyboard.press('Meta+Enter');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'session-focus.png') });

    // Steer: ⏎ queues a note for the next turn; the agent picks it up after the current one.
    await t2.getByPlaceholder('Steer T2…').fill('Keep the error codes in SCREAMING_SNAKE_CASE');
    await window.keyboard.press('Enter');
    await expect(t2.locator('.ev-you')).toContainText('queued for next turn');
    await expect(t2.getByText('Noted for the next step')).toBeVisible();
    await window.waitForTimeout(300);
    await t2.screenshot({ path: join(shots, 'steer.png') });
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
