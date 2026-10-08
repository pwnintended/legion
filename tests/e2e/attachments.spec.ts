/**
 * Attachments in the New run composer and the clarify form, against the real engine with scripted fake agents
 * (`LEGION_FAKE_ENGINES=1`): a screenshot pasted from the clipboard (synthetic paste event), a text file
 * dropped from "Finder", files from the native dialog (test hook `LEGION_E2E_PICK_FILES`), an inline
 * rejection, previews (image lightbox, text viewer), removal with Backspace, the draft surviving a close, then
 * the run: the planner reports the attachments it received, and the clarify answer brings one more.
 * Screenshots go to test-results/attachments/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { png, sevenPng, textPdf } from '../../src/engine/attachments/testing';
import { openAgents } from './agents';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'attachments');

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
  writeFileSync(join(repo, 'README.md'), '# widgets\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

/** A mockup-ish PNG: a red header bar and a red button on white. */
function mockupPng(): Buffer {
  return png(320, 200, (x, y) => (y >= 0 && y < 36) || (x >= 210 && x < 300 && y >= 150 && y < 182));
}

let step = 0;
async function shot(window: Page, name: string): Promise<void> {
  step += 1;
  await window.waitForTimeout(350);
  await window.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name}.png`) });
}

async function setSize(app: ElectronApplication, window: Page, [w, h]: readonly [number, number]) {
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setContentSize(width as number, height as number);
      win?.focus();
    },
    [w, h],
  );
  await expect.poll(() => window.evaluate(() => [innerWidth, innerHeight].join('x'))).toBe(`${w}x${h}`);
}

/** Dispatch a paste carrying one file on `target` (what ⌘V of a screenshot delivers). */
async function pasteFile(target: Locator, file: { name: string; type: string; base64: string }) {
  await target.evaluate((el, f) => {
    const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], f.name, { type: f.type }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, file);
}

/** Dispatch a drag event (enter / over / drop) carrying files on `target`. */
async function dragFiles(target: Locator, type: string, files: { name: string; type: string; text: string }[]) {
  await target.evaluate(
    (el, { type: eventType, files: list }) => {
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([f.text], f.name, { type: f.type }));
      el.dispatchEvent(new DragEvent(eventType, { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    { type, files },
  );
}

test('attachments: paste, drop, dialog, preview, remove, then the planner receives them', async () => {
  test.setTimeout(180_000);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'legion-e2e-attachments-')));
  const home = join(scratch, 'home');
  const repo = makeRepo(scratch);
  const picked = join(scratch, 'Desktop');
  mkdirSync(picked);
  const specPdf = join(picked, 'spec.pdf');
  const mockup = join(picked, 'settings-mockup.png');
  writeFileSync(specPdf, textPdf('Settings page spec'));
  writeFileSync(mockup, mockupPng());
  const seven = sevenPng().toString('base64');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [root],
      cwd: root,
      env: {
        ...env,
        ...gitEnv,
        LEGION_HOME: home,
        LEGION_FAKE_ENGINES: '1',
        LEGION_E2E_PICK_DIR: repo,
        LEGION_E2E_PICK_FILES: [specPdf, mockup].join(delimiter),
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await setSize(app, window, [1280, 800]);
    await expect(window.getByTestId('connection-status')).toHaveText('connected', { timeout: 30_000 });

    // The composer with a repository and a description.
    await window.keyboard.press('ControlOrMeta+Shift+n');
    const composer = window.getByTestId('composer');
    await expect(composer).toBeVisible();
    const textarea = composer.locator('textarea');
    await textarea.fill('Make the settings page match the mockup\n\nThe header and the save button are off.');
    await composer.getByTestId('repo-picker').click();
    await window.getByTestId('repo-browse').click();
    await expect(composer.getByTestId('repo-status')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
    await expect(composer.getByTestId('attach-button')).toBeVisible();
    await shot(window, 'composer-empty');

    const chips = composer.getByTestId('attachment-chip');
    const ready = async (count: number) => {
      await expect(chips).toHaveCount(count);
      await expect(composer.locator('.at-chip[data-busy]')).toHaveCount(0, { timeout: 15_000 });
    };

    // ⌘V of a screenshot: the clipboard's `image.png` becomes a dated "Pasted image …".
    await textarea.focus();
    await pasteFile(textarea, { name: 'image.png', type: 'image/png', base64: seven });
    await ready(1);
    await expect(chips.first()).toHaveAttribute('data-name', /^Pasted image \d{4}-\d\d-\d\d at [\d.]+\.png$/);
    await expect(textarea).toHaveValue(/^Make the settings page/);

    // A text file dragged from Finder: the drop hint says "attach" (typed files, not a folder).
    const notes = {
      name: 'notes.md',
      type: 'text/markdown',
      text: '# Notes\n\n- Header: 36px, red.\n- Save button bottom-right.\n',
    };
    await dragFiles(composer.locator('.cmp-root'), 'dragenter', [notes]);
    await expect(composer.getByTestId('composer-drop')).toHaveAttribute('data-intent', 'files');
    await shot(window, 'drop-hint');
    await dragFiles(composer.locator('.cmp-root'), 'drop', [notes]);
    await expect(composer.getByTestId('composer-drop')).toHaveCount(0);
    await ready(2);

    // Something that can't be attached: a polite inline error, nothing added.
    await dragFiles(composer.locator('.cmp-root'), 'dragenter', [
      { name: 'demo.mov', type: 'video/quicktime', text: 'x' },
    ]);
    await dragFiles(composer.locator('.cmp-root'), 'drop', [{ name: 'demo.mov', type: 'video/quicktime', text: 'x' }]);
    const error = composer.getByTestId('attachment-error');
    await expect(error).toContainText('demo.mov: Only images (PNG, JPEG, GIF, WebP), text or code files and PDFs');
    await expect(chips).toHaveCount(2);
    await shot(window, 'rejected');
    await error.getByRole('button', { name: 'Dismiss' }).click();
    await expect(error).toHaveCount(0);

    // Attach… (the native dialog, answered by LEGION_E2E_PICK_FILES): a PDF and a mockup.
    await composer.getByTestId('attach-button').click();
    await ready(4);
    expect(await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))).toEqual([
      expect.stringMatching(/^Pasted image/),
      'notes.md',
      'spec.pdf',
      'settings-mockup.png',
    ]);
    await expect(composer.locator('.at-img img')).toHaveCount(2);
    await textarea.focus();
    await shot(window, 'tray');

    // Preview: the image in a lightbox (←/→ step through), Esc closes it and only it.
    await chips.first().click();
    const preview = window.getByTestId('attachment-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('img')).toBeVisible();
    await expect(preview).toContainText('1 / 4');
    await expect(preview).toContainText('240×240');
    await shot(window, 'preview-image');
    await window.keyboard.press('ArrowLeft');
    await expect(window.getByTestId('attachment-preview-name')).toHaveText('settings-mockup.png');
    await shot(window, 'preview-mockup');
    await window.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(composer).toBeVisible();

    // Preview of the text file: Markdown is rendered, not shown as source.
    await chips.nth(1).click();
    const markdown = window.getByTestId('attachment-preview-markdown');
    await expect(markdown.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await expect(markdown.getByRole('listitem')).toHaveText(['Header: 36px, red.', 'Save button bottom-right.']);
    await shot(window, 'preview-text');
    await window.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    // The PDF: no preview, an explanation.
    await chips.nth(2).click();
    await expect(preview).toContainText('Claude reads the PDF itself');
    await shot(window, 'preview-pdf');
    await window.keyboard.press('Escape');

    // Backspace on a focused chip removes it; focus moves to the neighbour.
    await chips.nth(2).focus();
    await window.keyboard.press('Backspace');
    await expect(chips).toHaveCount(3);
    await expect.poll(() => window.evaluate(() => document.activeElement?.getAttribute('data-name'))).toBe('notes.md');

    // The draft (attachments included) survives closing the composer.
    await window.keyboard.press('Escape');
    await expect(composer).toHaveCount(0);
    await window.keyboard.press('ControlOrMeta+Shift+n');
    await expect(composer).toBeVisible();
    await expect(chips).toHaveCount(3);

    // A smaller window.
    await setSize(app, window, [1000, 700]);
    await textarea.focus();
    await shot(window, 'tray-1000x700');
    await setSize(app, window, [1280, 800]);

    // Create the run: the assistant takes the request (and its attachments) and hands it to the planner.
    await textarea.press('ControlOrMeta+Enter');
    await expect(composer).toBeHidden({ timeout: 15_000 });

    // Clarify, as a card in the chat: the issue's attachments are listed; a screenshot pasted into an answer
    // travels with it.
    const chat = window.getByTestId('chat');
    await expect(chat).toBeVisible();
    const clarify = chat.locator('[data-testid="chat-decision"][data-kind="question"]').getByTestId('clarify');
    await expect(clarify).toBeVisible({ timeout: 30_000 });
    await expect(chat.locator('.ch-you-files').first().getByTestId('attachment-chip')).toHaveCount(3);
    // Among the agents (⌘E and back): the planner is at work, so the route map's Plan station shows the
    // plan-to-be, which lists them as the issue's attachments.
    await window.keyboard.press('ControlOrMeta+e');
    await expect(window.getByTestId('route-map')).toBeVisible();
    await expect(window.getByTestId('station-pane')).toHaveAttribute('data-station', 'plan');
    await expect(
      window.locator('[data-tile-kind="plan"]').getByTestId('run-attachments').getByTestId('attachment-chip'),
    ).toHaveCount(3);
    await shot(window, 'plan-attachments');
    await window.keyboard.press('ControlOrMeta+e');
    await expect(clarify).toBeVisible();
    await clarify.getByRole('radio', { name: 'Yes, add docs' }).click();
    const note = clarify.locator('.cl-note').first();
    await note.fill('Match the mockup exactly');
    await pasteFile(note, { name: 'image.png', type: 'image/png', base64: mockupPng().toString('base64') });
    await expect(clarify.getByTestId('attachment-chip')).toHaveCount(1);
    await expect(clarify.locator('.at-chip[data-busy]')).toHaveCount(0, { timeout: 15_000 });
    await shot(window, 'clarify');
    await clarify.getByTestId('clarify-submit').click();
    const plan = chat.locator('[data-testid="chat-decision"][data-kind="plan_signoff"]');
    await expect(plan).toContainText('3 tasks', { timeout: 30_000 });
    await shot(window, 'planned');

    // What the planner received (the demo agent says so in its transcript), and what is stored.
    const db = new DatabaseSync(join(home, 'legion.db'), { readOnly: true });
    try {
      const runId = (db.prepare('SELECT id FROM runs').get() as { id: string }).id;
      const messages = (
        db.prepare(`SELECT payload FROM events WHERE type = 'agent.event'`).all() as { payload: string }[]
      )
        .map((row) => JSON.parse(row.payload) as { event?: { type: string; text?: string } })
        .flatMap((p) => (p.event?.type === 'message' && p.event.text ? [p.event.text] : []));
      expect(messages).toContainEqual(
        expect.stringMatching(
          /^Received 3 attachments: Pasted image .+\.png \(image\), notes\.md \(text\), settings-mockup\.png \(image\)\.$/,
        ),
      );
      expect(messages).toContainEqual(
        expect.stringMatching(/^Received 1 attachment: Pasted image .+\.png \(image\)\.$/),
      );
      const rows = db.prepare('SELECT name, kind, run_id FROM attachments ORDER BY created_at').all() as {
        name: string;
        kind: string;
        run_id: string | null;
      }[];
      expect(rows.filter((r) => r.run_id === runId).map((r) => r.kind)).toEqual(['image', 'text', 'image', 'image']);
      // The removed PDF stays an unclaimed draft (garbage-collected after a day).
      expect(rows.find((r) => r.name === 'spec.pdf')?.run_id ?? null).toBeNull();
      const run = db.prepare('SELECT attachments FROM runs WHERE id = ?').get(runId) as { attachments: string };
      expect((JSON.parse(run.attachments) as { name: string }[]).map((a) => a.name)).toEqual([
        expect.stringMatching(/^Pasted image/),
        'notes.md',
        'settings-mockup.png',
      ]);
    } finally {
      db.close();
    }
    const stored = readdirSync(join(home, 'attachments'));
    expect(stored.filter((f) => /^[0-9a-f]{64}\.(png|md|pdf)$/.test(f)).length).toBe(stored.length);
    expect(existsSync(join(home, 'attachments'))).toBe(true);
  } finally {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('attachments in demo mode: a screenshot pasted into the steer bar travels with the message', async () => {
  test.setTimeout(90_000);
  mkdirSync(shots, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-attachments-demo-'));
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
    await setSize(app, window, [1440, 900]);
    // The run's agents (the route map) open on T2's station: its session tile has the steer bar.
    await openAgents(window);
    const t2 = window.locator('[data-tile-id="session:T2"]');
    await expect(t2.getByText('Read 3 files')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('station-pane')).toHaveAttribute('data-station', 'task:T2');
    const input = t2.locator('.ss-input');
    await input.click();
    await input.fill('The button should look like this');
    await pasteFile(input, { name: 'image.png', type: 'image/png', base64: mockupPng().toString('base64') });
    await expect(t2.getByTestId('attachment-chip')).toHaveCount(1);
    await expect(t2.locator('.at-chip[data-busy]')).toHaveCount(0, { timeout: 15_000 });
    await t2.screenshot({ path: join(shots, 'demo-steer-tray.png') });
    await input.press('Enter');
    const sent = t2.getByRole('list', { name: 'Sent attachments' });
    await expect(sent.getByTestId('attachment-chip')).toHaveCount(1);
    await expect(t2.locator('.ss-steer').getByTestId('attachment-chip')).toHaveCount(0);
    await expect(t2.getByText(/open as well/)).toBeVisible({ timeout: 10_000 });
    await window.waitForTimeout(300);
    await t2.screenshot({ path: join(shots, 'demo-steer-sent.png') });
    await sent.getByTestId('attachment-chip').click();
    await expect(window.getByTestId('attachment-preview')).toBeVisible();
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, 'demo-steer-preview.png') });
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('attachment-preview')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
