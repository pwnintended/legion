/**
 * The conversation (demo mode): the passkeys run opens on its chat with the assistant's relayed updates, the
 * lead's status folded under a reply, a coder's screenshots and the lead's document, the open approval as a card
 * (answered in place, it becomes a receipt), the progress strip, a task dot to the agents' route map and ⌘E back,
 * the strip's Agents door,
 * the project's board with a new conversation, and its code. Screenshots of each go to test-results/chat/.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'chat');

async function launchDemo(): Promise<{ app: ElectronApplication; window: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-chat-'));
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
    localStorage.removeItem('legion.ui');
  });
  await window.reload();
  await setSize(app, window, [1440, 900]);
  return { app, window, home };
}

async function setSize(app: ElectronApplication, window: Page, [width, height]: [number, number]) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(size.width, size.height);
      win?.focus();
    },
    { width, height },
  );
  await window.waitForTimeout(250);
}

const shot = (window: Page, name: string) => window.screenshot({ path: join(shots, `${name}.png`) });

test('the run is a conversation: updates, presentations, decisions, the agents one key away', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    const chat = window.getByTestId('chat');
    await expect(chat).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');

    // The human's request, the assistant's replies, the plan receipts, the shared screenshots and document.
    await expect(chat.locator('.ch-you-text').first()).toContainText('Add passkey (WebAuthn) login');
    await expect(chat.getByTestId('chat-receipt').filter({ hasText: 'Approved plan v2' })).toBeVisible();
    await expect(chat.getByTestId('chat-presentation')).toHaveCount(2);
    await chat
      .getByTestId('chat-presentation')
      .first()
      .screenshot({ path: join(shots, 'presentation.png') });
    await expect(chat.getByTestId('chat-shot')).toHaveCount(2);
    await expect(chat.getByTestId('chat-document')).toContainText('INVALID_ATTESTATION');
    await expect(chat.getByTestId('chat-progress')).toContainText('Execute 1/6');
    await expect(chat.getByTestId('chat-task-dot')).toHaveCount(6);
    await window.waitForTimeout(500);
    await expect(chat.getByTestId('chat-jump')).toHaveCount(0);
    await shot(window, 'conversation');

    // The lead's status update sits under the reply it led to.
    const sources = chat.getByTestId('chat-sources').last();
    await sources.click();
    await expect(chat.locator('.ch-source').last()).toContainText('sign counter overflows');

    // The open approval is a card; the needs-you bar and ⌘U lead to it.
    const card = chat.getByTestId('chat-decision').filter({ hasText: 'Approval' });
    await expect(card).toContainText('@simplewebauthn/browser');
    await expect(chat.getByTestId('chat-needs-you')).toContainText('waiting for you');
    await window.keyboard.press('ControlOrMeta+u');
    await expect(card).toBeInViewport();
    await window.waitForTimeout(400);
    await shot(window, 'decision');
    await card.screenshot({ path: join(shots, 'decision-card.png') });
    await card.getByTestId('approval-accept').click();
    await expect(chat.getByTestId('chat-receipt').filter({ hasText: 'Allowed' })).toBeVisible({ timeout: 10_000 });

    // A screenshot opens in the preview.
    await chat.getByTestId('chat-shot').first().click();
    await expect(window.getByTestId('attachment-preview')).toBeVisible();
    await window.waitForTimeout(400);
    await shot(window, 'preview');
    await window.keyboard.press('Escape');

    // A task dot says what its agent does; clicking it opens the agents on that task.
    const dot = chat.getByTestId('chat-task-dot').nth(1);
    await dot.hover();
    await expect(window.locator('.ch-dot-item').nth(1).locator('.ch-dot-tip')).toBeVisible();
    await window.waitForTimeout(300);
    await shot(window, 'task-dot');
    await dot.click();
    await expect(window.getByTestId('titlebar-agents')).toBeVisible();
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('route-map')).toBeVisible();
    await expect(window.getByTestId('station-pane')).toHaveAttribute('data-station', 'task:T2');
    await expect(window.getByTestId('route-row-T2')).toHaveAttribute('aria-current', 'true');
    await expect(window.locator('[data-tile-id="session:T2"]')).toBeVisible();
    await window.waitForTimeout(400);
    await shot(window, 'agents-route-map');

    // ⌘E back to the conversation; a reply goes to the assistant and shows at once.
    await window.keyboard.press('ControlOrMeta+e');
    await expect(chat).toBeVisible();

    // The strip's end is the way in without knowing ⌘E: a labelled door that wears its key.
    const door = chat.getByTestId('chat-agents-door');
    await expect(door).toContainText('Agents');
    await expect(door.locator('.kbd')).toBeVisible();
    await chat.getByTestId('chat-progress').screenshot({ path: join(shots, 'progress-door.png') });
    await door.click();
    await expect(window.getByTestId('titlebar-agents')).toBeVisible();
    await expect(window.getByTestId('route-map')).toBeVisible();
    await window.keyboard.press('ControlOrMeta+e');
    await expect(chat).toBeVisible();

    await chat.getByTestId('chat-input').fill('Ship it behind a feature flag, please.');
    await window.keyboard.press('Enter');
    await expect(chat.locator('.ch-you-text').last()).toHaveText('Ship it behind a feature flag, please.');
    await expect(chat.locator('.ch-as-body').last()).toContainText('passed that to the lead', { timeout: 10_000 });

    // Narrow window: the column still reads.
    await setSize(app, window, [1000, 700]);
    await shot(window, 'conversation-1000x700');
    await setSize(app, window, [1440, 900]);

    // The project's board: every conversation going in the project as a tile; ⌘N splits a new one in.
    await window.getByTestId('titlebar-project').click();
    const board = window.getByTestId('board');
    await expect(board.getByTestId('board-tile')).toHaveCount(2);
    await shot(window, 'board');
    await window.keyboard.press('ControlOrMeta+n');
    const page = window.getByTestId('new-conversation');
    await expect(page).toBeVisible();
    await expect(page.getByTestId('new-conversation-input')).toBeFocused();
    await shot(window, 'new-conversation');
    // The project's code is the other view: its main checkout, a shell in it.
    await expect(window.getByTestId('view-code')).toHaveText('Code');
    await window.getByTestId('view-code').click();
    await expect(window.getByTestId('view-code')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('code-terminal')).toHaveCount(1);
    await shot(window, 'code');
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
