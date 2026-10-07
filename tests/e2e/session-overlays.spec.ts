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
    // The agents view (the run's route map); a run opens in its chat otherwise.
    localStorage.setItem('legion.ui', JSON.stringify({ view: 'agents' }));
  });
  await window.reload();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(1440, 900);
    win?.focus();
  });
  return { app, window, home };
}

/** The tile shown in the route map's station pane. */
const focusedTile = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-id');

const station = (window: Page) => window.getByTestId('station-pane').getAttribute('data-station');

test('session tiles, approvals, composer, decisions, palette, clarify', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login', { timeout: 30_000 });
    const t2 = window.locator('[data-tile-id="session:T2"]');
    const t3 = window.locator('[data-tile-id="session:T3"]');
    // The run lands on T2's session; one station at a time, so T3's is not on screen.
    await expect.poll(() => station(window)).toBe('task:T2');
    await expect(t2.getByText('Read 3 files')).toBeVisible();
    await expect(t3).toHaveCount(0);
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'station-T2.png') });
    // T3, the next station down the map (⌘⌥J), waits on an approval.
    await window.keyboard.press('Meta+Alt+j');
    await expect.poll(() => station(window)).toBe('task:T3');
    await expect.poll(() => focusedTile(window)).toBe('session:T3');
    await expect(t3.getByTestId('approval-card')).toBeVisible();
    await expect(t2).toHaveCount(0);
    await window.waitForTimeout(700);
    await window.screenshot({ path: join(shots, 'station-T3.png') });

    // Six decisions wait across runs (the title bar's count). ⌘U shows the first one in the run on screen as a card
    // in its chat: T3's approval; ⌘E goes back to the agents and gives focus back to the tile.
    await expect(window.getByTestId('needs-you').locator('.tb-needs-count')).toHaveText('6');
    await window.keyboard.press('Meta+u');
    const chat = window.getByTestId('chat');
    await expect(chat).toBeVisible();
    const approvalCard = chat.locator('[data-testid="chat-decision"][data-kind="approval"]');
    await expect(approvalCard).toContainText('@simplewebauthn/browser');
    await expect(approvalCard.getByTestId('approval-accept')).toBeVisible();
    await expect(window.locator('[data-highlight]')).toHaveAttribute('data-thread-key', 'inbox:inb_authv2appr01');
    await window.waitForTimeout(450);
    await window.screenshot({ path: join(shots, 'decision.png') });
    await window.keyboard.press('Meta+e');
    await expect(chat).toHaveCount(0);
    await expect.poll(() => station(window)).toBe('task:T3');
    await expect.poll(() => focusedTile(window)).toBe('session:T3');
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
    // Overlays own their keys: ⌘⏎ with focus on a button inside the composer submits it (it does not reach the
    // tile behind it).
    await composer.locator('[data-engine="codex"]').focus();
    await window.keyboard.press('Meta+Enter');
    await expect(composer).toHaveCount(0);
    await expect(window.getByTestId('titlebar')).toContainText('Add audit logging to admin actions');
    await expect(chat).toBeVisible();
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');

    // The approval is answered: five decisions left. The rate-limit run (from the rail) opens on its chat, with its
    // clarify questions as a card.
    await expect(window.getByTestId('needs-you').locator('.tb-needs-count')).toHaveText('5');
    await window.getByTestId('rail-run').filter({ hasText: 'Rate-limit the public API' }).click();
    await expect(window.getByTestId('titlebar')).toContainText('Rate-limit the public API');
    await expect(chat).toBeVisible();
    const question = chat.locator('[data-testid="chat-decision"][data-kind="question"]');
    await expect(question).toHaveCount(1);
    await expect(chat.getByTestId('chat-needs-you')).toContainText('1 waiting for you');
    // ⌘U answers what is in front of you first.
    await window.keyboard.press('Meta+u');
    await expect(window.locator('[data-highlight]')).toHaveAttribute('data-thread-key', 'inbox:inb_rlclarify001');
    await expect(window.getByTestId('titlebar')).toContainText('Rate-limit the public API');

    // Clarify, in the card: chips + free text, submit; the card becomes a receipt.
    const clarify = question.getByTestId('clarify');
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
    await expect(question).toHaveCount(0);
    await expect(chat.locator('[data-testid="chat-receipt"][data-kind="question"]')).toBeVisible();
    await expect(window.getByTestId('needs-you').locator('.tb-needs-count')).toHaveText('4');

    // Palette (⌘K): fuzzy task ids, jump (to the agents view).
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
    await expect(window.getByTestId('view-agents')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => station(window)).toBe('task:T4');
    await expect.poll(() => focusedTile(window)).toBe('session:T4');
    await expect(window.getByTestId('route-row-T4')).toHaveAttribute('aria-current', 'true');

    // A busy session, two stations up the map (⌘⌥K twice): T2, the whole pane.
    await window.keyboard.press('Meta+Alt+k');
    await window.keyboard.press('Meta+Alt+k');
    await expect.poll(() => station(window)).toBe('task:T2');
    await expect.poll(() => focusedTile(window)).toBe('session:T2');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'session-busy.png') });

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
