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
    // The tiling workspace (the agents view); a run opens in its chat otherwise.
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

const focusedTile = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-id');

const columnOrder = (window: Page) =>
  window.locator('[data-column]').evaluateAll((els) => els.map((el) => el.getAttribute('data-column')));

test('demo workspace: strip, keyboard focus/move, layout modes', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    // Chrome: demo badge, six runs in the rail (an archived seventh is hidden), the passkeys run active.
    await expect(window.getByTestId('titlebar')).toContainText('demo', { timeout: 30_000 });
    await expect(window.getByTestId('rail-run')).toHaveCount(6);
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await expect(window.locator('[data-tile-id="session:T2"]')).toBeVisible();
    await expect(window.getByTestId('mode-pill')).toHaveText('NORMAL');
    await expect(window.getByTestId('needs-you').locator('.tb-needs-count')).toHaveText('6');

    // Initial layout: plan, the coordinating agents (lead and messages), thin T1, then live tasks; T3 (approval
    // pending) pulses.
    expect((await columnOrder(window)).slice(0, 5)).toEqual([
      'col:plan',
      'col:agents',
      'col:task:T1',
      'col:task:T2',
      'col:task:T3',
    ]);
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
    await expect.poll(async () => (await columnOrder(window)).slice(3, 5)).toEqual(['col:task:T3', 'col:task:T2']);
    await window.keyboard.press('Meta+Alt+Shift+h');
    await expect.poll(async () => (await columnOrder(window)).slice(3, 5)).toEqual(['col:task:T2', 'col:task:T3']);

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

    // ⌘U shows the decisions waiting for you as cards in the chat: the run on screen first (T3's approval, then
    // its budget stop), then the other runs, oldest first (the PDF run's PR, ...). The card shown is highlighted.
    const chat = window.getByTestId('chat');
    const card = (kind: string) => chat.locator(`[data-testid="chat-decision"][data-kind="${kind}"]`);
    const highlighted = () => window.locator('[data-highlight]').getAttribute('data-thread-key', { timeout: 2000 });
    await window.keyboard.press('Meta+u');
    await expect(chat).toBeVisible();
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await expect(card('approval')).toContainText('@simplewebauthn/browser');
    await expect(card('approval')).toBeInViewport();
    await expect.poll(highlighted).toBe('inbox:inb_authv2appr01');
    await window.keyboard.press('Meta+u');
    await expect.poll(highlighted).toBe('inbox:inb_authv2budg01');
    await expect(card('budget')).toBeInViewport();
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await window.keyboard.press('Meta+u');
    await expect(window.getByTestId('titlebar')).toContainText('Invoice PDF export');
    await expect.poll(highlighted).toBe('inbox:inb_pdfexportpr1');
    await expect(card('pr_ready')).toBeInViewport();
    // ...and on through all six (the title bar's count) before it comes back round.
    const shown = ['inbox:inb_authv2appr01', 'inbox:inb_authv2budg01', 'inbox:inb_pdfexportpr1'];
    for (let i = 0; i < 3; i++) {
      const previous = shown.at(-1);
      await window.keyboard.press('Meta+u');
      await expect.poll(highlighted).not.toBe(previous);
      shown.push((await highlighted()) ?? '');
    }
    expect(new Set(shown).size).toBe(6);

    // Back on the passkeys run, ⌘E returns to its agents.
    await window.keyboard.press('Meta+1');
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await window.keyboard.press('Meta+e');
    await expect(window.getByTestId('view-agents')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('[data-tile-id="session:T2"]')).toBeVisible();

    // Focus mode (⌘⏎): master + stack.
    await window.keyboard.press('Meta+Alt+h');
    await window.keyboard.press('Meta+Enter');
    await expect(window.locator('[data-layout-mode="focus"]')).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'focus.png') });

    // Overview (⌘⇧O; ⌘⇥ is taken by macOS): one card per tile (the agents and messages tiles included).
    await window.keyboard.press('Meta+Shift+o');
    await expect(window.getByTestId('overview')).toBeVisible();
    await expect(window.locator('[data-testid="overview"] .card')).toHaveCount(11);
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

/** Where the focused column sits in the strip's viewport (layout boxes, transforms ignored): 'ok' when fully in view. */
const focusedInView = (window: Page) =>
  window.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[data-workspace] .strip');
    const column = document
      .querySelector<HTMLElement>('[data-workspace] [data-focused="true"]')
      ?.closest<HTMLElement>('[data-column]');
    if (!strip || !column) return 'missing';
    const left = column.offsetLeft - strip.scrollLeft;
    const right = left + column.offsetWidth;
    const fits = column.offsetWidth <= strip.clientWidth;
    // A column wider than the viewport aligns its left edge.
    const ok = fits ? left >= -1 && right <= strip.clientWidth + 1 : Math.abs(left - 10) <= 1;
    return ok ? 'ok' : `${column.dataset.column} at ${Math.round(left)}..${Math.round(right)} of ${strip.clientWidth}`;
  });

async function expectFocusedInView(window: Page): Promise<void> {
  await expect.poll(() => focusedInView(window), { timeout: 4000 }).toBe('ok');
  // ...and it stays there once smooth scrolling and layout animations have settled.
  await window.waitForTimeout(700);
  expect(await focusedInView(window)).toBe('ok');
}

test('strip: the focused column is always fully in view (bursts, resizes, inserted columns)', async () => {
  const { app, window, home } = await launchDemo();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    await expect(window.locator('[data-tile-id="session:T2"]')).toBeVisible({ timeout: 30_000 });
    await expectFocusedInView(window);

    // Bursts of focus moves while the previous smooth scroll is still in flight.
    for (const key of ['l', 'l', 'l', 'l']) await window.keyboard.press(`Meta+Alt+${key}`);
    await expectFocusedInView(window);
    for (const key of ['h', 'h', 'h', 'h', 'h']) await window.keyboard.press(`Meta+Alt+${key}`);
    await expectFocusedInView(window);
    for (const key of ['l', 'l', 'h', 'l', 'l', 'l']) {
      await window.keyboard.press(`Meta+Alt+${key}`);
      await window.waitForTimeout(60);
    }
    await expectFocusedInView(window);

    // Widen the focused column to 2/3, then full: still entirely visible (full aligns left).
    await window.keyboard.press('Meta+r');
    await window.keyboard.press('l');
    await window.keyboard.press('l');
    await expectFocusedInView(window);
    await window.keyboard.press('l');
    await window.keyboard.press('Escape');
    await expectFocusedInView(window);

    // An inserted column (the review's diff, opened with D) is revealed, also after moving it left.
    await window.locator('[data-tile-id="review:T4"]').click({ position: { x: 160, y: 12 } });
    await expectFocusedInView(window);
    await window.keyboard.press('d');
    await expect(window.getByTestId('diff-tile')).toBeVisible();
    await expectFocusedInView(window);
    await window.keyboard.press('Meta+Alt+Shift+h');
    await window.keyboard.press('Meta+r');
    await window.keyboard.press('l');
    await window.keyboard.press('Escape');
    await expectFocusedInView(window);
    await window.keyboard.press('Meta+Alt+l');
    await expectFocusedInView(window);
    await window.keyboard.press('Meta+Alt+h');
    await expectFocusedInView(window);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('settings, a failed task escalated to you, a finished run archived', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login', { timeout: 30_000 });

    // Settings (⌘,): engines with detected version/login, inline validation, saves on commit.
    await window.keyboard.press('Meta+,');
    const settings = window.getByTestId('settings');
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId('engine-claude')).toContainText('2.1.289');
    await expect(settings.getByTestId('engine-claude').getByTestId('engine-status')).toHaveText('logged in');
    const global = settings.getByLabel('All engines');
    await global.fill('0');
    await global.press('Enter');
    await expect(settings).toContainText('Must be between 1 and 32.');
    await global.fill('5');
    await global.press('Enter');
    await expect(settings.getByTestId('settings-save')).toContainText('Saved');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'settings.png') });
    await settings.locator('.st-nav-item', { hasText: 'Agents' }).click();
    await window.waitForTimeout(600);
    await window.screenshot({ path: join(shots, 'settings-agents.png') });
    // ⌘⏎ inside an overlay is not the Focus layout.
    await window.keyboard.press('Meta+Enter');
    await expect(settings).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(window.locator('[data-layout-mode="strip"]')).toBeVisible();
    // The rail footer opens it too.
    await window.getByTestId('rail-settings').click();
    await expect(settings).toBeVisible();
    await window.keyboard.press('Escape');

    // ⌘6 (rail order: grouped by project): T2 failed all its attempts; the run lands on it with the escalation inline.
    await window.keyboard.press('Meta+6');
    await expect(window.getByTestId('titlebar')).toContainText('Move cron jobs onto the queue');
    await expect.poll(() => focusedTile(window)).toBe('session:T2');
    const t2 = window.locator('[data-tile-id="session:T2"]');
    await expect(t2).toHaveAttribute('data-urgent', 'true');
    await expect(t2.getByTestId('escalation-card')).toContainText('Out of attempts');
    await expect(t2.locator('.ss-attempt')).toHaveText(['coder', 'attempt 2', 'attempt 3']);
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'failed-task.png') });
    // "Start over…" (from scratch) asks first; Esc backs out without touching anything else.
    await t2.getByTestId('escalation-restart').click();
    const confirm = window.getByTestId('confirm');
    await expect(confirm).toContainText('Start T2 over from scratch?');
    await expect(confirm.getByTestId('confirm-ok')).toHaveText('Start over');
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, 'start-over-confirm.png') });
    await window.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(t2.getByTestId('escalation-card')).toBeVisible();
    // R retries it from the keyboard (holding it down sends one retry).
    await t2.locator('.tile-head').click();
    await window.keyboard.press('r');
    await expect(t2.getByTestId('escalation-card')).toHaveCount(0);
    await expect(t2).toHaveAttribute('data-urgent', 'false');

    // ⌘4: a finished run whose PR merged, archived from its PR tile.
    await window.keyboard.press('Meta+4');
    await expect(window.getByTestId('titlebar')).toContainText('Dark mode tokens');
    await expect.poll(() => focusedTile(window)).toBe('pr');
    const opened = window.getByTestId('pr-opened');
    await expect(opened).toHaveAttribute('data-pr-state', 'merged');
    await expect(opened).toContainText('PR #398 is merged');
    await window.waitForTimeout(1200);
    await window.screenshot({ path: join(shots, 'done-run.png') });
    await opened.getByTestId('pr-archive').click();
    await expect(window.getByTestId('rail-run')).toHaveCount(5);
    await expect(window.getByTestId('titlebar')).not.toContainText('Dark mode tokens');
    await window.getByTestId('show-archived').click();
    await expect(window.getByTestId('rail-archived-run')).toHaveCount(2);
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'archived.png') });
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
