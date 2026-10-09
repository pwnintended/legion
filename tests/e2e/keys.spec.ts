/**
 * The shortcuts sheet in demo mode: the status bar's "? keys" hint (⌘? while a field has the keyboard), ⌘? from a
 * text field, the view on screen listed first, pressing a chord to look it up, Esc clearing then closing, and the
 * sheet in Code and in a conversation's agents. Screenshots go to test-results/keys/.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { openAgents } from './agents';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'keys');

test('shortcuts sheet', async () => {
  mkdirSync(shots, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-keys-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('legion.demo', '1');
      localStorage.setItem('legion.demo.live', '0');
    });
    await window.reload();
    const resize = (width: number, height: number) =>
      app.evaluate(
        ({ BrowserWindow }, [w, h]) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.setSize(w as number, h as number);
          win?.focus();
        },
        [width, height],
      );
    await resize(1440, 900);
    await expect(window.getByTestId('titlebar')).toBeVisible({ timeout: 30_000 });
    const sheet = window.getByTestId('keys');
    const hint = window.getByTestId('keys-hint');

    // Off any field, the hint says ?; in one, ⌘? (a bare ? would be typed).
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(hint).toContainText('?');
    await expect(hint.locator('.kbd')).toHaveText('?');
    await window.locator('textarea').first().focus();
    await expect(hint.locator('.kbd')).toHaveText(/⌘\?|Ctrl\+\?/);
    await window.getByTestId('statusbar').screenshot({ path: join(shots, 'statusbar-typing.png') });

    // ? in a field types; ⌘? opens.
    await window.keyboard.press('Shift+Slash');
    await expect(sheet).toHaveCount(0);
    await window.keyboard.press('Backspace');
    await window.keyboard.press('ControlOrMeta+Shift+Slash');
    await expect(sheet).toBeVisible();
    const heads = sheet.locator('.keys-head .sec');
    await expect(heads.first()).toHaveText('Chat');
    await expect(sheet.locator('.keys-here')).toHaveCount(1);
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'chat.png') });

    // Press-to-find: ⌘F means something in every view.
    await window.keyboard.press('ControlOrMeta+f');
    await expect(window.getByTestId('keys-token')).toBeVisible();
    await expect(sheet.locator('.keys-row')).not.toHaveCount(0);
    await expect(sheet.locator('.kbd[data-hit="true"]').first()).toBeVisible();
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, 'lookup.png') });
    // ⌘K is looked up, not run.
    await window.keyboard.press('ControlOrMeta+k');
    await expect(window.getByTestId('palette')).toHaveCount(0);
    await expect(sheet.getByText('Command palette')).toBeVisible();
    // An unbound chord.
    await window.keyboard.press('ControlOrMeta+j');
    await expect(sheet.locator('.keys-empty')).toContainText('isn’t bound');
    await window.screenshot({ path: join(shots, 'unbound.png') });
    // Esc clears the lookup, then closes.
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('keys-token')).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // The hint opens it too; ? closes it from an empty search.
    await hint.click();
    await expect(sheet).toBeVisible();
    await window.keyboard.press('Shift+Slash');
    await expect(sheet).toHaveCount(0);

    // Code: its keys first; searching.
    await window.keyboard.press('ControlOrMeta+Shift+e');
    await expect(window.getByTestId('code-hint')).toBeVisible({ timeout: 15_000 });
    await window.keyboard.press('ControlOrMeta+Shift+Slash');
    await expect(sheet).toBeVisible();
    await expect(heads.first()).toHaveText('Code');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'code.png') });
    await window.keyboard.type('split');
    await expect(sheet.locator('.keys-row').first()).toContainText(/split/i);
    await window.screenshot({ path: join(shots, 'search.png') });
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // A conversation's agents.
    await window.getByTestId('view-chat').click();
    await openAgents(window);
    await window.keyboard.press('ControlOrMeta+Shift+Slash');
    await expect(heads.first()).toHaveText('Agents');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'agents.png') });

    // A small window: still one panel, the list scrolls.
    await resize(1024, 680);
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'agents-small.png') });
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
