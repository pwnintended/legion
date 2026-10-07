/**
 * The whole pipeline through the UI, against the real engine with scripted fake agents
 * (`LEGION_FAKE_ENGINES=1`, no external effects): ⌘N composer → repo picked through the folder dialog
 * (test hook `LEGION_E2E_PICK_DIR`) → the run's chat: the scripted assistant hands the request to the planner →
 * clarify answered in its card → plan approved from its card → the coder's approval reached with ⌘U and accepted →
 * the coders' presentations (a screenshot, a document) and the lead's status relayed by the assistant → review with
 * a fix round → PR ready → Open draft pull request → the fake PR.
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

test('full run, chat first: composer → assistant → clarify → plan → approval → presentations → draft PR', async () => {
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

    // The run opens on its conversation: the request, and the assistant's reply as it hands it to the planner.
    const chat = window.getByTestId('chat');
    await expect(chat).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId('view-chat')).toHaveAttribute('aria-pressed', 'true');
    await expect(chat.locator('.ch-you-text').first()).toContainText('Add a demo feature');
    const replies = chat.locator('.ch-as-body');
    await expect(replies.first()).toContainText("I'll have a planner look through the repository", {
      timeout: 30_000,
    });
    const card = (kind: string) => chat.locator(`[data-testid="chat-decision"][data-kind="${kind}"]`);
    const receipt = (kind: string) => chat.locator(`[data-testid="chat-receipt"][data-kind="${kind}"]`);

    // Clarify: the planner's one question, a card in the chat; answered, it becomes a receipt.
    const clarify = card('question').getByTestId('clarify');
    await expect(clarify).toBeVisible({ timeout: 30_000 });
    await expect(clarify).toContainText('Should the change also be documented?');
    await expect(replies.filter({ hasText: 'The planner has a question for you' })).toHaveCount(1, {
      timeout: 15_000,
    });
    await clarify.getByRole('radio', { name: 'Yes, add docs' }).click();
    await shot(window, 'clarify');
    await clarify.getByTestId('clarify-submit').click();
    await expect(receipt('question')).toContainText("Answered the planner's question", { timeout: 15_000 });

    // Plan: three tasks, T2 after T1; approved from its card.
    const plan = card('plan_signoff');
    await expect(plan).toContainText('3 tasks', { timeout: 30_000 });
    await expect(plan.locator('.ch-plan li')).toHaveCount(3);
    await expect(plan.locator('.ch-plan li').nth(1)).toContainText('after T1');
    await shot(window, 'plan');
    await plan.getByTestId('chat-plan-approve').click();
    await expect(receipt('plan_signoff')).toContainText('Approved plan v1', { timeout: 15_000 });
    await expect(chat.getByTestId('chat-progress')).toContainText('Execute', { timeout: 15_000 });
    await shot(window, 'executing');

    // T3's coder asks to run a linter: ⌘U brings its card into view; accept it there.
    await expect(window.getByTestId('needs-you').locator('.tb-needs-count')).toHaveText('1', { timeout: 30_000 });
    await window.keyboard.press('Meta+u');
    const approval = card('approval');
    await expect(approval).toContainText('markdownlint');
    await expect(approval).toBeInViewport();
    await shot(window, 'approval');
    await approval.getByTestId('approval-accept').click();
    await expect(receipt('approval')).toContainText('Allowed', { timeout: 15_000 });
    await expect(approval).toHaveCount(0);

    // What the coders presented: T2 a screenshot, T3 the document it wrote; the lead's status relayed by the
    // assistant, with the lead's update folded under its reply.
    const presentations = chat.getByTestId('chat-presentation');
    await expect(presentations).toHaveCount(2, { timeout: 90_000 });
    const preview = presentations.filter({ hasText: 'Feature preview' });
    await expect(preview.getByTestId('chat-shot')).toHaveCount(1);
    await expect(preview.getByTestId('chat-shot').locator('img')).toBeVisible();
    const doc = presentations.filter({ hasText: 'Documentation draft' });
    await expect(doc.getByTestId('chat-document')).toContainText('T3', { timeout: 15_000 });
    await expect(replies.filter({ hasText: 'merged. Nothing is blocked.' }).first()).toBeVisible({
      timeout: 90_000,
    });
    const sources = chat.getByTestId('chat-sources').filter({ hasText: "the lead's update" }).first();
    await sources.click();
    await expect(chat.locator('.ch-source').first()).toContainText('merged into the integration branch');

    // T2's review asks for changes, the fix round resolves them, everything merges, final review, PR ready.
    const pr = card('pr_ready');
    await expect(pr).toBeVisible({ timeout: 90_000 });
    await expect(pr).toContainText('3/3 tasks merged');
    await expect(replies.filter({ hasText: 'The draft pull request is ready' })).toHaveCount(1, {
      timeout: 15_000,
    });
    await shot(window, 'pr-ready');

    // Among the agents (⌘E): T2's column (collapsed once merged) shows its review's round trip.
    await window.keyboard.press('Meta+e');
    await window.locator('section[aria-label^="T2 "][aria-label$="(collapsed)"] button').first().click();
    await window.waitForTimeout(600);
    await shot(window, 't2-expanded');
    await window.keyboard.press('Meta+e');
    await expect(chat).toBeVisible();

    await pr.getByTestId('chat-create-pr').click();
    await expect(receipt('pr_ready')).toContainText('Opened the draft pull request', { timeout: 30_000 });
    const opened = chat.locator('.ch-event').filter({ hasText: 'Draft pull request #1 opened' });
    await expect(opened).toBeVisible({ timeout: 30_000 });
    await expect(opened.locator('a')).toHaveAttribute('href', 'https://github.invalid/legion/fake/pull/1');
    await expect(chat.getByTestId('chat-progress')).toHaveAttribute('data-status', 'done');
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
