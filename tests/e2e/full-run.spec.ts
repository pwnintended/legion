/**
 * The whole pipeline through the UI, against the real engine with scripted fake agents
 * (`LEGION_FAKE_ENGINES=1`, no external effects): ⌘N composer → repo picked through the folder dialog
 * (test hook `LEGION_E2E_PICK_DIR`) → clarify answer → plan approved with ⌘⏎ → the coder's approval
 * accepted from the inbox → review with a fix round → PR ready → Create draft PR → the fake PR.
 * Screenshots of every stage go to test-results/full-run/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'full-run');

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Legion E2E',
  GIT_AUTHOR_EMAIL: 'e2e@legion.test',
  GIT_COMMITTER_NAME: 'Legion E2E',
  GIT_COMMITTER_EMAIL: 'e2e@legion.test',
};

function makeRepo(dir: string): string {
  const repo = join(dir, 'widgets');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# widgets\n\nA tiny fixture repository.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

let step = 0;
async function shot(window: Page, name: string): Promise<void> {
  step += 1;
  await window.waitForTimeout(500);
  await window.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name}.png`) });
}

test('full run: composer → clarify → plan → approval → review fix round → draft PR', async () => {
  test.setTimeout(180_000);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'legion-e2e-full-run-')));
  const home = join(scratch, 'home');
  const repo = makeRepo(scratch);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [root],
      cwd: root,
      env: { ...env, ...gitEnv, LEGION_HOME: home, LEGION_FAKE_ENGINES: '1', LEGION_E2E_PICK_DIR: repo },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(1440, 900);
      win?.focus();
    });
    await expect(window.getByTestId('connection-status')).toHaveText('connected', { timeout: 30_000 });
    await shot(window, 'empty');

    // ⌘N → composer; pick the repo through the picker's Browse… (the folder dialog is answered by the test hook).
    await window.keyboard.press('Meta+n');
    const composer = window.getByTestId('composer');
    await expect(composer).toBeVisible();
    await composer.locator('textarea').fill('Add a demo feature\n\nThe widgets repo needs a small feature with docs.');
    await composer.getByTestId('repo-picker').click();
    await window.getByTestId('repo-browse').click();
    await expect(composer.getByTestId('repo-status')).toContainText('main', { timeout: 15_000 });
    await expect(composer.getByTestId('repo-picker')).toHaveAttribute('title', repo);
    await shot(window, 'composer');
    await composer.locator('textarea').press('Meta+Enter');
    await expect(composer).toBeHidden({ timeout: 15_000 });

    // Clarify: answer the planner's one question.
    const clarify = window.getByTestId('clarify');
    await expect(clarify).toBeVisible({ timeout: 30_000 });
    await expect(clarify).toContainText('Should the change also be documented?');
    await clarify.getByRole('radio', { name: 'Yes, add docs' }).click();
    await shot(window, 'clarify');
    await clarify.getByTestId('clarify-submit').click();

    // Plan: three tasks, T2 after T1; approve with ⌘⏎ on the plan tile.
    const plan = window.getByTestId('plan-tile');
    await expect(plan.getByTestId('plan-signoff')).toContainText('3 tasks', { timeout: 30_000 });
    await expect(window.getByTestId('dag-tile').locator('.react-flow__node')).toHaveCount(3);
    await shot(window, 'plan');
    await plan.click({ position: { x: 200, y: 60 } });
    await window.keyboard.press('Meta+Enter');
    await expect(plan).toContainText('Approved', { timeout: 15_000 });
    await shot(window, 'executing');

    // T3's coder asks to run a linter: accept it from the inbox (⌘I).
    await expect(window.getByTestId('needs-you')).toContainText(/1/, { timeout: 30_000 });
    await window.keyboard.press('Meta+i');
    const inbox = window.getByTestId('inbox');
    const approval = inbox.locator('[data-testid="inbox-item"][data-kind="approval"]');
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText('markdownlint');
    await shot(window, 'inbox-approval');
    await approval.getByTestId('approval-accept').click();
    await expect(approval).toBeHidden({ timeout: 15_000 });
    await window.keyboard.press('Escape');

    // T2's review asks for changes, the fix round resolves them, everything merges, final review, PR ready.
    const pr = window.getByTestId('pr-tile');
    await expect(pr).toBeVisible({ timeout: 90_000 });
    await shot(window, 'pr-ready');

    // T2's column (collapsed once merged): its review shows the round trip.
    await window.locator('section[aria-label^="T2 "][aria-label$="(collapsed)"] button').first().click();
    await window.waitForTimeout(600);
    await shot(window, 't2-expanded');

    await pr.getByTestId('create-pr').click();
    const opened = window.getByTestId('pr-opened');
    await expect(opened).toBeVisible({ timeout: 30_000 });
    await expect(opened).toContainText('#1');
    await expect(opened).toContainText('github.invalid/legion/fake/pull/1');
    await shot(window, 'pr-opened');

    // What happened underneath: T2's review round trip, the approval, the PR, and nothing pushed.
    const db = new DatabaseSync(join(home, 'legion.db'), { readOnly: true });
    try {
      const verdicts = db
        .prepare(
          `SELECT r.verdict FROM reviews r JOIN tasks t ON t.id = r.task_id WHERE t.node_id = 'T2' ORDER BY r.created_at`,
        )
        .all()
        .map((row) => row.verdict);
      expect(verdicts).toEqual(['request_changes', 'approve']);
      const kinds = db
        .prepare('SELECT kind FROM inbox_items ORDER BY created_at')
        .all()
        .map((row) => row.kind);
      expect(kinds).toEqual(['question', 'plan_signoff', 'approval', 'pr_ready']);
      const run = db.prepare('SELECT status, pr FROM runs').get() as { status: string; pr: string };
      expect(run.status).toBe('done');
      expect(JSON.parse(run.pr)).toEqual({
        url: 'https://github.invalid/legion/fake/pull/1',
        number: 1,
        state: 'open',
        isDraft: true,
      });
    } finally {
      db.close();
    }
    expect(execFileSync('git', ['remote'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('');
  } finally {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
