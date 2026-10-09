import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'prompts');

/** Launch the built app in demo mode (fixture data, frozen agents). */
async function launchDemo(): Promise<{ app: ElectronApplication; window: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-prompts-'));
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

test('settings: a role’s prompt is Legion’s, then your additions, then the project’s; replacing it is reversible', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login', { timeout: 30_000 });
    await window.keyboard.press('ControlOrMeta+,');
    const settings = window.getByTestId('settings');
    await settings.locator('.st-nav-item', { hasText: 'Agents' }).click();

    // ↓ walks the role list; the detail follows.
    await settings.locator('[data-role-item="planner"]').click();
    await window.keyboard.press('ArrowDown');
    const lead = settings.locator('[data-role="lead"]');
    await expect(lead).toBeVisible();
    await expect(lead.getByRole('tab', { name: 'With the assistant' })).toHaveAttribute('aria-selected', 'true');
    await expect(lead.locator('.ag-text').first()).toContainText('You are the implementation lead in Legion');

    // Additions for every project save as you go; the reviewer's seeded one shows as custom in the list.
    await expect(settings.locator('[data-role-item="reviewer"] .ag-mark')).toHaveCount(1);
    await settings.locator('[data-role-item="coder"]').click();
    const coder = settings.locator('[data-role="coder"]');
    const additions = coder.getByLabel('Coder additions for every project');
    await additions.fill('Keep diffs small.');
    await additions.blur();
    await expect(settings.getByTestId('settings-save')).toContainText('Saved');

    // The project's layer saves to legion.json with its button.
    const project = coder.getByLabel('Coder additions for this project');
    await expect(project).toHaveValue(/pnpm lint --fix/);
    await project.fill('Use pnpm, never npm.');
    await expect(settings.locator('[data-role-item="coder"] .ag-mark')).toHaveAttribute('data-unsaved', 'true');
    await coder.getByRole('button', { name: 'Save to legion.json' }).click();
    await expect(coder).toContainText('Saved to legion.json');

    // What the agent receives: Legion's prompt, then both additions under their headings.
    await coder.getByRole('button', { name: 'Show what the agent receives' }).click();
    const received = coder.locator('.ag-received');
    await expect(received).toContainText('You are a coding agent in Legion');
    await expect(received.locator('.ag-own')).toContainText(
      '## Additional instructions\n\nKeep diffs small.\n\n## Additional instructions for this repository\n\nUse pnpm, never npm.',
    );
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'prompt-layers.png') });

    // Replace: a copy to edit, a warning for tools it stops mentioning, and back to the built-in.
    await coder.getByRole('button', { name: 'Replace…' }).click();
    await coder.getByRole('button', { name: 'Replace with a copy' }).click();
    const replacement = coder.getByLabel('Coder replacement prompt');
    await expect(replacement).toHaveValue(/You are a coding agent in Legion/);
    await replacement.fill('You implement one task. Report with report_progress.');
    await replacement.blur();
    await expect(coder.locator('.ag-missing')).toContainText('mark_task_done');
    await expect(coder.locator('.ag-missing')).not.toContainText('report_progress');
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, 'prompt-replaced.png') });
    await coder.getByRole('button', { name: 'Restore built-in' }).click();
    await expect(coder.getByLabel('Coder replacement prompt')).toHaveCount(0);
    await expect(coder.getByRole('button', { name: 'Replace…' })).toBeVisible();

    // Esc in an editor goes back to the list; Esc there closes the sheet.
    await additions.focus();
    await window.keyboard.press('Escape');
    await expect(settings).toBeVisible();
    await expect(settings.locator('[data-role-item="coder"]')).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
