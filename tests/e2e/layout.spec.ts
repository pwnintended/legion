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

/** The tile shown in the agents view's station pane, or the focused tile of the code view's strip. */
const focusedTile = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-id');

/** The kind of the tile shown (polled: a tile on its way out lingers for its exit animation). */
const focusedKind = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-kind');

const station = (window: Page) => window.getByTestId('station-pane').getAttribute('data-station');

const selectedTab = (window: Page) =>
  window
    .locator('[data-testid^="station-tab-"][aria-selected="true"]')
    .first()
    .getAttribute('data-testid', { timeout: 2000 });

const columnOrder = (window: Page) =>
  window.locator('[data-column]').evaluateAll((els) => els.map((el) => el.getAttribute('data-column')));

test('demo workspace: route map, stations and tabs, decisions, the code strip', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    // Chrome: demo badge, eight runs in the rail (an archived one is hidden), the passkeys run active.
    await expect(window.getByTestId('titlebar')).toContainText('demo', { timeout: 30_000 });
    await expect(window.getByTestId('rail-run')).toHaveCount(8);
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await expect(window.getByTestId('view-agents')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('needs-you').locator('.tb-needs-count')).toHaveText('6');
    // The agents view has no key modes: the status bar shows the map's keys, not the NORMAL pill.
    await expect(window.getByTestId('map-hint')).toBeVisible();
    await expect(window.getByTestId('mode-pill')).toHaveCount(0);

    // The route map: the crew, Plan, the six tasks in plan order, Integration, the PR. The run lands on T2's session.
    const map = window.getByTestId('route-panel');
    const routeMap = window.getByTestId('route-map');
    await expect(routeMap).toHaveAttribute('data-workspace', 'run_authv2demo01');
    await expect(map.locator('.rm-crew')).toContainText('Assistant, Lead');
    await expect(map.getByTestId('route-plan')).toContainText('Signed off · 6 tasks');
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) await expect(map.getByTestId(`route-row-${id}`)).toBeVisible();
    await expect(map.getByTestId('route-integration')).toBeVisible();
    await expect(map.getByTestId('route-pr')).toBeVisible();
    await expect(map.locator('[data-testid^="route-row-"]')).toHaveText([/T1/, /T2/, /T3/, /T4/, /T5/, /T6/]);
    await expect(map.getByTestId('route-row-T1').locator('.rm-stage')).toHaveText('merged');
    // T3 has an approval pending: its row says so.
    await expect(map.getByTestId('route-row-T3').locator('.rm-stage')).toHaveText('waiting');
    await expect(map.getByTestId('route-row-T3')).toHaveAttribute('aria-label', 'T3 Enrollment UI: waiting');
    await expect(map.getByTestId('route-row-T4').locator('.rm-stage')).toHaveText('fix 1/2');
    await expect(map.getByTestId('route-row-T2')).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => station(window)).toBe('task:T2');
    await expect.poll(() => focusedTile(window)).toBe('session:T2');
    await expect(window.getByTestId('station-tab-transcript')).toHaveAttribute('aria-selected', 'true');
    await window.waitForTimeout(600);
    await window.screenshot({ path: join(shots, 'route-map.png') });

    // Clicking a row shows its session: T3's, urgent, with the approval waiting.
    await map.getByTestId('route-row-T3').click();
    await expect.poll(() => station(window)).toBe('task:T3');
    await expect(map.getByTestId('route-row-T3')).toHaveAttribute('aria-current', 'true');
    await expect(map.getByTestId('route-row-T2')).not.toHaveAttribute('aria-current', 'true');
    const t3 = window.locator('[data-tile-id="session:T3"]');
    await expect(t3).toHaveAttribute('data-urgent', 'true');
    await expect(t3.getByTestId('approval-card')).toBeVisible();
    // The pane header names what it waits on and what it unblocks.
    await expect(window.getByTestId('station-deps')).toContainText('T1');
    await expect(window.getByTestId('station-deps')).toContainText('T5');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'station-waiting.png') });

    // ⌘⌥J / ⌘⌥K walk the stations in map order: crew, plan, T1..T6, integration, PR.
    await window.keyboard.press('Meta+Alt+j');
    await expect.poll(() => station(window)).toBe('task:T4');
    await expect.poll(() => focusedTile(window)).toBe('session:T4');
    await window.keyboard.press('Meta+Alt+ArrowUp');
    await expect.poll(() => station(window)).toBe('task:T3');
    for (const expected of ['task:T2', 'task:T1', 'plan', 'crew']) {
      await window.keyboard.press('Meta+Alt+k');
      await expect.poll(() => station(window)).toBe(expected);
    }
    await expect.poll(() => focusedTile(window)).toBe('agents');
    // The first station stays put.
    await window.keyboard.press('Meta+Alt+k');
    await expect.poll(() => station(window)).toBe('crew');
    await window.keyboard.press('Meta+Alt+j');
    await expect.poll(() => station(window)).toBe('plan');
    await expect.poll(() => focusedTile(window)).toBe('plan');
    // ...down to the PR, the last one.
    for (let i = 0; i < 9; i++) await window.keyboard.press('Meta+Alt+ArrowDown');
    await expect.poll(() => station(window)).toBe('pr');
    // (This run's layout has no PR tile yet: the station opens one.)
    await expect.poll(() => focusedKind(window)).toBe('pr');
    // A burst of moves leaves one tile in the pane once the exit animations are done.
    await expect(window.locator('.rm-pane-tile')).toHaveCount(1);
    await expect(map.getByTestId('route-pr')).toHaveAttribute('aria-current', 'true');

    // ⌘⌥L / ⌘⌥H walk the tabs of a station (wrapping); moving between tasks keeps the tab.
    await map.getByTestId('route-row-T2').click();
    await expect.poll(() => selectedTab(window)).toBe('station-tab-transcript');
    await window.keyboard.press('Meta+Alt+l');
    await expect.poll(() => selectedTab(window)).toBe('station-tab-changes');
    await expect.poll(() => focusedKind(window)).toBe('diff');
    await window.keyboard.press('Meta+Alt+j');
    await expect.poll(() => station(window)).toBe('task:T3');
    await expect.poll(() => selectedTab(window)).toBe('station-tab-changes');
    await expect.poll(() => focusedKind(window)).toBe('diff');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'station-changes.png') });
    await window.keyboard.press('Meta+Alt+ArrowRight');
    await expect.poll(() => selectedTab(window)).toBe('station-tab-review');
    await expect.poll(() => focusedKind(window)).toBe('review');
    await window.keyboard.press('Meta+Alt+l');
    await expect.poll(() => selectedTab(window)).toBe('station-tab-transcript');
    await window.keyboard.press('Meta+Alt+h');
    await expect.poll(() => selectedTab(window)).toBe('station-tab-review');
    await window.keyboard.press('Meta+Alt+ArrowLeft');
    await expect.poll(() => selectedTab(window)).toBe('station-tab-changes');
    // A tab clicked directly.
    await window.getByTestId('station-tab-transcript').click();
    await expect.poll(() => focusedTile(window)).toBe('session:T3');

    // ⌘U shows the decisions waiting for you as cards in the chat: the run on screen first (T3's approval, then
    // its budget stop), then the other runs, oldest first (the PDF run's PR, ...). The card shown is highlighted.
    const chat = window.getByTestId('chat');
    const card = (kind: string) => chat.locator(`[data-testid="chat-decision"][data-kind="${kind}"]`);
    const highlighted = () => window.locator('[data-highlight]').getAttribute('data-thread-key', { timeout: 2000 });
    await window.keyboard.press('Meta+u');
    await expect(chat).toBeVisible();
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('map-hint')).toHaveCount(0);
    await expect(window.getByTestId('mode-pill')).toHaveCount(0);
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

    // Back on the passkeys run, ⌘E returns to its agents on the station it was on (T3's transcript).
    await window.keyboard.press('Meta+1');
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await window.keyboard.press('Meta+e');
    await expect(window.getByTestId('view-agents')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => station(window)).toBe('task:T3');
    await expect.poll(() => focusedTile(window)).toBe('session:T3');
    await expect(window.getByTestId('map-hint')).toBeVisible();

    // ⌘3 opens the i18n run awaiting plan sign-off: it lands on the plan, urgent.
    await window.keyboard.press('Meta+3');
    await expect(window.getByTestId('titlebar')).toContainText('Extract UI strings for i18n');
    await expect.poll(() => station(window)).toBe('plan');
    await expect(window.getByTestId('route-plan')).toContainText('Waiting for your sign-off');
    await expect(window.locator('[data-tile-id="plan"]')).toHaveAttribute('data-urgent', 'true');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'plan-signoff.png') });

    // A narrow window folds the map into a bar above the pane; the bar opens it as a popover, and picking a
    // station closes it.
    await window.keyboard.press('Meta+1');
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    const bar = window.getByTestId('route-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('T3');
    await expect(window.getByTestId('route-panel')).toHaveCount(0);
    await bar.click();
    await expect(bar).toHaveAttribute('aria-expanded', 'true');
    await expect(window.getByTestId('route-panel')).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'route-bar-open.png') });
    await window.getByTestId('route-row-T4').click();
    await expect.poll(() => station(window)).toBe('task:T4');
    await expect(window.getByTestId('route-panel')).toHaveCount(0);
    await expect(bar).toContainText('T4');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await expect(window.getByTestId('route-bar')).toHaveCount(0);
    await expect(window.getByTestId('route-panel')).toBeVisible();

    // Overlay state lives in the store: ⌘K opens the palette slot, Esc closes it.
    await window.keyboard.press('Meta+k');
    await expect.poll(() => window.locator('body').getAttribute('data-overlay')).toBe('palette');
    await window.keyboard.press('Escape');
    await expect.poll(() => window.locator('body').getAttribute('data-overlay')).toBe(null);

    // The code view (⌘⇧E): the project's strip, where the key modes live. Overview | Activity | Files.
    await window.keyboard.press('Meta+Shift+e');
    await expect(window.getByTestId('view-code')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('route-map')).toHaveCount(0);
    await expect(window.locator('[data-workspace="project:prj_demoapp00001"]')).toBeVisible();
    await expect(window.getByTestId('mode-pill')).toHaveText('NORMAL');
    await expect(window.getByTestId('map-hint')).toHaveCount(0);
    expect(await columnOrder(window)).toEqual(['col:project', 'col:activity', 'col:files']);
    await expect.poll(() => focusedTile(window)).toBe('project');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'code-strip.png') });

    // Keyboard focus: ⌘⌥L / ⌘⌥H move between columns.
    await window.keyboard.press('Meta+Alt+l');
    await expect.poll(() => focusedTile(window)).toBe('activity');
    await window.keyboard.press('Meta+Alt+l');
    await expect.poll(() => focusedTile(window)).toBe('files');
    await window.keyboard.press('Meta+Alt+ArrowLeft');
    await expect.poll(() => focusedTile(window)).toBe('activity');

    // Move: ⌘⌥⇧L swaps the activity column with the files, ⌘⌥⇧H swaps it back.
    await window.keyboard.press('Meta+Alt+Shift+l');
    await expect.poll(() => columnOrder(window)).toEqual(['col:project', 'col:files', 'col:activity']);
    await window.keyboard.press('Meta+Alt+Shift+h');
    await expect.poll(() => columnOrder(window)).toEqual(['col:project', 'col:activity', 'col:files']);
    await expect.poll(() => focusedTile(window)).toBe('activity');

    // Resize mode: ⌘R, l widens the focused column, esc leaves the mode.
    const widthBefore = await window.locator('[data-column="col:activity"]').evaluate((el) => el.clientWidth);
    await window.keyboard.press('Meta+r');
    await expect(window.getByTestId('mode-pill')).toHaveText('RESIZE');
    await window.keyboard.press('l');
    await expect
      .poll(() => window.locator('[data-column="col:activity"]').evaluate((el) => el.clientWidth))
      .toBeGreaterThan(widthBefore);
    await window.keyboard.press('h');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('mode-pill')).toHaveText('NORMAL');

    // ⌘⌥C collapses the focused column to a thin one; clicking it expands it again.
    await window.keyboard.press('Meta+Alt+c');
    await expect(window.locator('[data-column="col:activity"] [data-tile-body]')).toHaveCount(0);
    const thin = window.locator('section[data-tile-id="activity"][aria-label$="(collapsed)"]');
    await expect(thin).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'code-collapsed.png') });
    await thin.locator('button').first().click();
    await expect(window.locator('[data-column="col:activity"] [data-tile-body]')).toBeVisible();

    // ⌘E from the code view goes to the conversation, and back to the agents; the pill goes with the strip.
    await window.keyboard.press('Meta+e');
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('mode-pill')).toHaveCount(0);
    await window.keyboard.press('Meta+e');
    await expect(window.getByTestId('view-agents')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('route-map')).toBeVisible();
    await expect(window.getByTestId('mode-pill')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('route map: ↑↓ / j k travel between the stops inside the map', async () => {
  const { app, window, home } = await launchDemo();
  try {
    const map = window.getByTestId('route-panel');
    await expect(map.getByTestId('route-row-T3')).toBeVisible({ timeout: 30_000 });
    // Focus in the map: each key moves to the next stop and selects the row it lands on, and the map keeps the
    // keyboard so the next key moves on from there.
    await map.getByTestId('route-row-T3').focus();
    await window.keyboard.press('ArrowDown');
    await expect.poll(() => station(window)).toBe('task:T4');
    await expect(map.getByTestId('route-row-T4')).toBeFocused();
    await window.keyboard.press('j');
    await expect.poll(() => station(window)).toBe('task:T5');
    await window.keyboard.press('k');
    await expect.poll(() => station(window)).toBe('task:T4');
    await window.keyboard.press('ArrowUp');
    await expect.poll(() => station(window)).toBe('task:T3');
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
    // The strip is the code view's: the passkeys run's project, with a file, the search and a commit open.
    await window.keyboard.press('Meta+Shift+e');
    await expect(window.getByTestId('project-overview')).toBeVisible();
    await expectFocusedInView(window);
    await window.keyboard.press('Meta+p');
    await window.keyboard.type('passkeylist');
    await expect(window.getByTestId('goto-option').first()).toContainText('PasskeyList.tsx');
    await window.keyboard.press('Enter');
    await expect(window.locator('[data-tile-kind="code"]').getByTestId('code-view')).toContainText('PasskeyList');
    await expectFocusedInView(window);
    await window.keyboard.press('Meta+Shift+f');
    await expect(window.getByTestId('project-search')).toBeVisible();
    await expectFocusedInView(window);
    await window.getByTestId('project-activity').getByTestId('activity-commit').first().click();
    await expect(window.locator('[data-tile-kind="diff"]')).toBeVisible();
    await expectFocusedInView(window);
    await expect.poll(async () => (await columnOrder(window)).length).toBeGreaterThanOrEqual(6);

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

    // An inserted column (another commit, in a new column with ⌘-click) is revealed, also after moving it left.
    await window.keyboard.press('Meta+Alt+h');
    await window.keyboard.press('Meta+Alt+h');
    await expectFocusedInView(window);
    const before = (await columnOrder(window)).length;
    await window
      .getByTestId('project-activity')
      .getByTestId('activity-commit')
      .nth(2)
      .click({ modifiers: ['Meta'] });
    await expect.poll(async () => (await columnOrder(window)).length).toBe(before + 1);
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
    // ⌘⏎ inside an overlay belongs to the overlay: it does not reach the shown tile.
    await window.keyboard.press('Meta+Enter');
    await expect(settings).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(window.getByTestId('route-map')).toBeVisible();
    await expect.poll(() => station(window)).toBe('task:T2');
    // The rail footer opens it too.
    await window.getByTestId('rail-settings').click();
    await expect(settings).toBeVisible();
    await window.keyboard.press('Escape');

    // ⌘6 (rail order: grouped by project): T2 failed all its attempts; the run lands on it with the escalation inline.
    await window.keyboard.press('Meta+6');
    await expect(window.getByTestId('titlebar')).toContainText('Move cron jobs onto the queue');
    await expect.poll(() => station(window)).toBe('task:T2');
    await expect.poll(() => focusedTile(window)).toBe('session:T2');
    const map = window.getByTestId('route-panel');
    await expect(map.getByTestId('route-row-T2')).toHaveAttribute('aria-current', 'true');
    await expect(map.getByTestId('route-row-T2').locator('.rm-stage')).toHaveText('failed');
    await expect(map.locator('.rm-counts')).toContainText('1 failed');
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
    await t2.evaluate((el) => (el as HTMLElement).focus());
    await window.keyboard.press('r');
    await expect(t2.getByTestId('escalation-card')).toHaveCount(0);
    await expect(t2).toHaveAttribute('data-urgent', 'false');

    // ⌘4: a finished run whose PR merged; it lands on the PR station, and is archived from its PR tile.
    await window.keyboard.press('Meta+4');
    await expect(window.getByTestId('titlebar')).toContainText('Dark mode tokens');
    await expect.poll(() => station(window)).toBe('pr');
    await expect.poll(() => focusedTile(window)).toBe('pr');
    await expect(window.getByTestId('route-pr')).toContainText('#398 merged');
    await expect(window.getByTestId('station-tab-pr')).toHaveAttribute('aria-selected', 'true');
    const opened = window.getByTestId('pr-opened');
    await expect(opened).toHaveAttribute('data-pr-state', 'merged');
    await expect(opened).toContainText('PR #398 is merged');
    await window.waitForTimeout(1200);
    await window.screenshot({ path: join(shots, 'done-run.png') });
    await opened.getByTestId('pr-archive').click();
    await expect(window.getByTestId('rail-run')).toHaveCount(7);
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
