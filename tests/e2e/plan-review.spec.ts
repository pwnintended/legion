import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'plan-review');

/** Launch the built app in demo mode (frozen agents); `stage: 'gate'` starts T4 at the human merge gate. */
async function launchDemo(
  stage: 'fixing' | 'gate' = 'fixing',
): Promise<{ app: ElectronApplication; window: Page; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-plan-review-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem('legion.demo', '1');
    localStorage.setItem('legion.demo.live', '0');
    localStorage.setItem('legion.demo.stage', s);
  }, stage);
  await window.reload();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(1440, 900);
    win?.focus();
  });
  await expect(window.getByTestId('titlebar')).toContainText('demo', { timeout: 30_000 });
  // Workspace shortcuts (⌘2, ⌘3) need the run list loaded.
  await expect(window.getByTestId('rail-run')).toHaveCount(6);
  return { app, window, home };
}

async function close(app: ElectronApplication, home: string): Promise<void> {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}

const focusedTile = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-kind');

test('plan sign-off: plan document, editable DAG with an auto-serialized overlap, inspector, approve', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await window.keyboard.press('Meta+3');
    await expect(window.getByTestId('titlebar')).toContainText('Extract UI strings for i18n');
    const plan = window.getByTestId('plan-tile');
    const dag = window.getByTestId('dag-tile');
    await expect(plan).toContainText('Extract UI strings to locale files');
    await expect(plan).toContainText('From clarify');
    await expect(plan).toContainText('English, Dutch, German');
    await expect(plan.getByTestId('plan-signoff')).toContainText('7 tasks');
    await expect(dag.getByTestId('dag-validation')).toContainText('acyclic');
    await expect(dag.getByTestId('overlap-callout')).toContainText('T4 now runs after T3');
    await expect(dag.locator('.react-flow__node')).toHaveCount(7);

    // Widen the DAG column (resize mode) and inspect T4, the task that was serialized.
    await dag.click({ position: { x: 300, y: 12 } });
    await window.keyboard.press('Meta+r');
    await window.keyboard.press('l');
    await window.keyboard.press('Escape');
    await dag.getByTestId('dag-node-T4').click();
    const inspector = dag.getByTestId('dag-inspector');
    await expect(inspector).toContainText('added for overlap');
    await expect(inspector).toContainText('shared with T3');
    await window.waitForTimeout(900);
    await window.screenshot({ path: join(shots, 'plan-signoff.png') });

    // Arrow keys move the selection; ⌘⏎ on the plan approves (the global ⌘⏎ is Focus layout).
    await window.keyboard.press('ArrowRight');
    await expect(inspector).toContainText('translations');

    // "Give it to T1": the shared file moves to the common ancestor, the edge disappears, a new version saves.
    await dag.getByRole('button', { name: 'Give it to T1' }).click();
    await expect(dag.getByTestId('overlap-callout')).toHaveCount(0);
    await expect(plan).toContainText('v2 · edited by you', { timeout: 10_000 });
    await expect(plan).toContainText('Saved');
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'plan-edited.png') });

    await plan.click({ position: { x: 200, y: 60 } });
    await expect.poll(() => focusedTile(window)).toBe('plan');
    await window.keyboard.press('Meta+Enter');
    await expect(window.locator('[data-layout-mode="strip"]')).toBeVisible();
    await expect(plan).toContainText('Approved', { timeout: 10_000 });
  } finally {
    await close(app, home);
  }
});

test('review pack: gates, verdict, findings across rounds, diff with inline findings, approve & merge', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo('gate');
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    // T4 waits for the human gate: the integration tile lists it; open its review pack from there.
    await window.locator('[data-tile-id="integration"] button').first().click();
    await window.getByTestId('open-review-T4').click();
    const review = window.getByTestId('review-tile');
    await expect(review).toContainText('risk high · your call');
    await expect(review.getByTestId('gates')).toContainText('Secret scan');
    await expect(review).toContainText('6/6 green');
    await expect(review.getByTestId('criteria')).toContainText('Sign counter survives large values');
    await expect(review.locator('[data-testid="finding"][data-state="resolved"]')).toHaveCount(2);
    await expect(review).toContainText('Why you’re seeing this');

    // Review pack on its own, maximized.
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(700);
    await window.screenshot({ path: join(shots, 'review-pack.png') });
    await window.keyboard.press('Meta+f');

    // D opens the diff next to it; move it left and give it 2/3, the pack 1/3 (the mockup's split).
    await review.click({ position: { x: 200, y: 12 } });
    await window.keyboard.press('d');
    const diff = window.getByTestId('diff-tile');
    await expect(diff).toContainText('0042_passkeys.sql');
    await window.keyboard.press('Meta+Alt+Shift+h');
    await window.keyboard.press('Meta+r');
    await window.keyboard.press('l');
    await window.keyboard.press('Escape');
    await expect(diff.locator('[data-testid="finding"]').first()).toBeVisible();
    // n jumps to the next finding; the highlighter colours the visible hunks.
    await window.keyboard.press('n');
    await expect(diff.locator('[data-active="true"][data-testid="finding"]')).toHaveCount(1);
    await expect.poll(() => diff.locator('.lg-dl .tx span[style]').count(), { timeout: 15_000 }).toBeGreaterThan(10);
    // The pack beside it at 1/3.
    await window.keyboard.press('Meta+Alt+l');
    await window.keyboard.press('Meta+r');
    await window.keyboard.press('h');
    await window.keyboard.press('Escape');
    // Back on the diff: the strip shows the diff (2/3) and the pack (1/3) side by side.
    await window.keyboard.press('Meta+Alt+h');
    await window.waitForTimeout(500);
    // Align the strip on the diff so both columns are in frame (the strip only scrolls as little as needed).
    await window.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[data-workspace] .strip');
      const column = document
        .querySelector<HTMLElement>('[data-tile-kind="diff"]')
        ?.closest<HTMLElement>('[data-column]');
      if (strip && column) strip.scrollTo({ left: column.offsetLeft - 10 });
    });
    await window.waitForTimeout(900);
    await window.screenshot({ path: join(shots, 'review-diff.png') });

    // ⌘⏎ on the task's focused diff (or review) approves the merge; the pack shows the merge.
    await expect.poll(() => focusedTile(window)).toBe('diff');
    await window.keyboard.press('Meta+Enter');
    await expect(review.getByTestId('review-actions')).toContainText('Merged into integration', { timeout: 10_000 });
  } finally {
    await close(app, home);
  }
});

test('PR: final review, generated PR body, create the draft PR', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    await window.keyboard.press('Meta+2');
    await expect(window.getByTestId('titlebar')).toContainText('Invoice PDF export');
    const pr = window.getByTestId('pr-tile');
    await expect(pr).toContainText('Final review');
    await expect(pr.getByTestId('pr-preview')).toContainText('Tasks');
    // The integration tile lists the merges in order with their post-merge verification.
    await expect(window.getByTestId('integration-tile').getByTestId('merged-list').locator('li')).toHaveCount(5);
    await window.locator('[data-tile-id="pr"]').click({ position: { x: 200, y: 12 } });
    // Tabbed column (the PR gets the full height), maximized.
    await window.keyboard.press('Meta+w');
    await window.keyboard.press('Meta+f');
    await window.waitForTimeout(700);
    await window.screenshot({ path: join(shots, 'pr-ready.png') });

    await pr.getByTestId('create-pr').click();
    const opened = window.getByTestId('pr-opened');
    await expect(opened).toContainText('Draft PR #412 is open');
    await window.waitForTimeout(1200);
    await window.screenshot({ path: join(shots, 'pr-opened.png') });
  } finally {
    await close(app, home);
  }
});
