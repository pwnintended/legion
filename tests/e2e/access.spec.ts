import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'access');

/** Launch the built app in demo mode (fixture data, frozen agents). */
async function launchDemo(): Promise<{ app: ElectronApplication; window: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-access-'));
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

test('settings: one model field per role follows the engine; MCP servers and skills are granted per role', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login', { timeout: 30_000 });
    await window.keyboard.press('ControlOrMeta+,');
    const settings = window.getByTestId('settings');
    await expect(settings).toBeVisible();

    // One model field per role; switching the role's engine switches which model it edits.
    await settings.locator('.st-nav-item', { hasText: 'Agents' }).click();
    await settings.locator('[data-role-item="coder"]').click();
    const coder = settings.locator('[data-role="coder"]');
    await expect(settings.getByLabel('Coder model')).toHaveCount(1);
    await expect(settings.getByLabel('Coder Claude model')).toHaveCount(0);
    const model = coder.getByLabel('Coder model');
    await model.fill('opus');
    await model.press('Enter');
    await expect(settings.getByTestId('settings-save')).toContainText('Saved');
    await coder.getByLabel('Coder engine').selectOption('codex');
    await expect(coder.getByLabel('Coder model')).toHaveValue('');
    await coder.getByLabel('Coder model').fill('gpt-5.5');
    await coder.getByLabel('Coder model').press('Enter');
    await expect(settings.getByTestId('settings-save')).toContainText('Saved');
    await coder.getByLabel('Coder engine').selectOption('claude');
    await expect(coder.getByLabel('Coder model')).toHaveValue('opus');

    // Access: add a server by hand, import another, grant them and a skill allowlist.
    await settings.locator('.st-nav-item', { hasText: 'Access' }).click();
    await expect(settings.getByText('No servers yet.')).toBeVisible();
    await settings.getByRole('button', { name: 'Add server' }).click();
    const form = settings.getByRole('form', { name: 'Add an MCP server' });
    await form.getByLabel('Name').fill('legion');
    await form.getByLabel('URL').fill('https://example.com/mcp');
    await form.getByRole('button', { name: 'Add server' }).click();
    await expect(form).toContainText('reserved');
    await form.getByLabel('Name').fill('notes');
    await form.getByRole('button', { name: 'Add server' }).click();
    await expect(settings.getByTestId('mcp-server-notes')).toContainText('https://example.com/mcp');

    await settings.getByRole('button', { name: 'Import from Claude Code' }).click();
    const found = settings.getByRole('group', { name: 'Servers found in your Claude Code config' });
    await expect(found).toContainText('linear');
    await found.getByRole('button', { name: 'Add' }).first().click();
    await expect(
      settings.getByTestId('mcp-server-docs').or(settings.getByTestId('mcp-server-linear')).first(),
    ).toBeVisible();

    const coderAccess = settings.locator('[data-role="Coder"]');
    await coderAccess.getByRole('button', { name: 'notes', exact: true }).click();
    await expect(coderAccess.getByRole('button', { name: 'notes', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await coderAccess.getByRole('radio', { name: 'Only these' }).click();
    await coderAccess.getByRole('button', { name: /^tdd/ }).click();
    await expect(coderAccess.getByRole('button', { name: /^tdd/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(settings.getByTestId('settings-save')).toContainText('Saved');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'access.png') });

    // Removing a server drops it from every grant.
    await settings.getByRole('button', { name: 'Remove notes' }).click();
    await expect(settings.getByTestId('mcp-server-notes')).toHaveCount(0);
    await expect(coderAccess.getByRole('button', { name: 'notes', exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
