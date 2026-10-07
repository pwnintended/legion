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
    // The agents view (the run's route map); a run opens in its chat otherwise.
    localStorage.setItem('legion.ui', JSON.stringify({ view: 'agents' }));
  }, stage);
  await window.reload();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(1440, 900);
    win?.focus();
  });
  await expect(window.getByTestId('titlebar')).toContainText('demo', { timeout: 30_000 });
  // Workspace shortcuts (⌘2, ⌘3) need the run list loaded.
  await expect(window.getByTestId('rail-run')).toHaveCount(8);
  return { app, window, home };
}

async function close(app: ElectronApplication, home: string): Promise<void> {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}

/** The kind of the tile shown in the station pane (polled: a tile on its way out lingers for its exit animation). */
const focusedTile = (window: Page) =>
  window.locator('[data-workspace] [data-focused="true"]').first().getAttribute('data-tile-kind');

const station = (window: Page) => window.getByTestId('station-pane').getAttribute('data-station');

test('plan sign-off: plan document, editable DAG with an auto-serialized overlap, inspector, approve', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    // ⌘3: the i18n run waits for its plan sign-off; the route map lands on the Plan station, its Plan tab.
    await window.keyboard.press('Meta+3');
    await expect(window.getByTestId('titlebar')).toContainText('Extract UI strings for i18n');
    await expect.poll(() => station(window)).toBe('plan');
    await expect(window.getByTestId('station-tab-plan')).toHaveAttribute('aria-selected', 'true');
    const plan = window.getByTestId('plan-tile');
    await expect(plan).toContainText('Extract UI strings to locale files');
    await expect(plan).toContainText('From clarify');
    await expect(plan).toContainText('English, Dutch, German');
    await expect(plan.getByTestId('plan-signoff')).toContainText('7 tasks');
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'plan-document.png') });

    // The Graph tab (⌘⌥L): the DAG, validated, with the overlap it serialized called out.
    await window.keyboard.press('Meta+Alt+l');
    await expect(window.getByTestId('station-tab-graph')).toHaveAttribute('aria-selected', 'true');
    const dag = window.getByTestId('dag-tile');
    await expect(dag.getByTestId('dag-validation')).toContainText('acyclic');
    await expect(dag.getByTestId('overlap-callout')).toContainText('T4 now runs after T3');
    await expect(dag.locator('.react-flow__node')).toHaveCount(7);

    // Inspect T4, the task that was serialized.
    await dag.getByTestId('dag-node-T4').click();
    const inspector = dag.getByTestId('dag-inspector');
    await expect(inspector).toContainText('added for overlap');
    await expect(inspector).toContainText('shared with T3');
    await window.waitForTimeout(900);
    await window.screenshot({ path: join(shots, 'plan-graph.png') });

    // Arrow keys move the selection.
    await window.keyboard.press('ArrowRight');
    await expect(inspector).toContainText('translations');

    // "Give it to T1": the shared file moves to the common ancestor, the edge disappears, a new version saves.
    await dag.getByRole('button', { name: 'Give it to T1' }).click();
    await expect(dag.getByTestId('overlap-callout')).toHaveCount(0);
    await expect(window.getByTestId('route-plan')).toContainText('Plan · v2', { timeout: 10_000 });
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, 'plan-edited.png') });

    // Back on the Plan tab (⌘⌥H): the new version; ⌘⏎ on the shown plan approves it.
    await window.keyboard.press('Meta+Alt+h');
    await expect(window.getByTestId('station-tab-plan')).toHaveAttribute('aria-selected', 'true');
    await expect(plan).toContainText('v2 · edited by you');
    await expect.poll(() => focusedTile(window)).toBe('plan');
    await window.keyboard.press('Meta+Enter');
    await expect(plan).toContainText('Approved', { timeout: 10_000 });
    await expect(window.getByTestId('route-plan')).not.toContainText('Waiting for your sign-off');
  } finally {
    await close(app, home);
  }
});

test('review pack: gates, verdict, findings across rounds, diff with inline findings, approve & merge', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo('gate');
  try {
    await expect(window.getByTestId('titlebar')).toContainText('Add passkey (WebAuthn) login');
    // T4 waits for the human gate: the Integration station lists it; open its review pack from there.
    await window.getByTestId('route-integration').click();
    await expect.poll(() => station(window)).toBe('integration');
    await window.getByTestId('open-review-T4').click();
    await expect.poll(() => station(window)).toBe('task:T4');
    await expect(window.getByTestId('station-tab-review')).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByTestId('route-row-T4')).toHaveAttribute('aria-current', 'true');
    const review = window.getByTestId('review-tile');
    await expect(review).toContainText('risk high · your call');
    await expect(review.getByTestId('gates')).toContainText('Secret scan');
    await expect(review).toContainText('6/6 green');
    await expect(review.getByTestId('criteria')).toContainText('Sign counter survives large values');
    await expect(review.locator('[data-testid="finding"][data-state="resolved"]')).toHaveCount(2);
    await expect(review).toContainText('Why you’re seeing this');
    await window.waitForTimeout(700);
    await window.screenshot({ path: join(shots, 'review-pack.png') });

    // D opens the diff: the task's Changes tab, with the findings inline.
    await expect.poll(() => focusedTile(window)).toBe('review');
    await window.keyboard.press('d');
    await expect(window.getByTestId('station-tab-changes')).toHaveAttribute('aria-selected', 'true');
    const diff = window.getByTestId('diff-tile');
    await expect(diff).toContainText('0042_passkeys.sql');
    await expect(diff.locator('[data-testid="finding"]').first()).toBeVisible();
    // n jumps to the next finding; the highlighter colours the visible hunks.
    await window.keyboard.press('n');
    await expect(diff.locator('[data-active="true"][data-testid="finding"]')).toHaveCount(1);
    await expect.poll(() => diff.locator('.lg-dl .tx span[style]').count(), { timeout: 15_000 }).toBeGreaterThan(10);
    await window.waitForTimeout(900);
    await window.screenshot({ path: join(shots, 'review-changes.png') });

    // ⌘⏎ on the task's shown diff (or review) approves the merge; the Review tab shows the merge.
    await expect.poll(() => focusedTile(window)).toBe('diff');
    await window.keyboard.press('Meta+Enter');
    await window.getByTestId('station-tab-review').click();
    await expect(review.getByTestId('review-actions')).toContainText('Merged into integration', { timeout: 10_000 });
  } finally {
    await close(app, home);
  }
});

test('PR: final review, generated PR body, create the draft PR', async () => {
  mkdirSync(shots, { recursive: true });
  const { app, window, home } = await launchDemo();
  try {
    // ⌘2: the PDF run's PR is ready; the route map lands on the PR station.
    await window.keyboard.press('Meta+2');
    await expect(window.getByTestId('titlebar')).toContainText('Invoice PDF export');
    await expect.poll(() => station(window)).toBe('pr');
    await expect(window.getByTestId('route-pr')).toContainText('Ready for you');
    const pr = window.getByTestId('pr-tile');
    await expect(pr).toContainText('Final review');
    await expect(pr.getByTestId('pr-preview')).toContainText('Tasks');
    // The Integration station lists the merges in order with their post-merge verification.
    await window.getByTestId('route-integration').click();
    await expect(window.getByTestId('integration-tile').getByTestId('merged-list').locator('li')).toHaveCount(5);
    await window.waitForTimeout(500);
    await window.screenshot({ path: join(shots, 'pr-integration.png') });
    await window.getByTestId('route-pr').click();
    await expect.poll(() => focusedTile(window)).toBe('pr');
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
