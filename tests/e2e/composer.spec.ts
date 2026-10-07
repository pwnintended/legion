/**
 * The New run composer against the real engine (not demo mode): the repository picker (discovery, search,
 * Browse… via the `LEGION_E2E_PICK_DIR` hook, a typed path, a folder dropped from Finder), the status line
 * (ok / not a git repo), the base-branch picker, the disabled "Plan it" reason and Esc handling. Screenshots
 * of every state at three window sizes go to test-results/composer/, plus the other overlays (centring).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'composer');
const SIZES = [
  [1000, 700],
  [1280, 800],
  [1728, 1117],
] as const;

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Legion E2E',
  GIT_AUTHOR_EMAIL: 'e2e@legion.test',
  GIT_COMMITTER_NAME: 'Legion E2E',
  GIT_COMMITTER_EMAIL: 'e2e@legion.test',
};

function makeRepo(path: string, ageDays: number, extra: (git: (...args: string[]) => string) => void = () => {}) {
  mkdirSync(path, { recursive: true });
  const date = `${Math.floor(Date.now() / 1000) - ageDays * 86_400} +0000`;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: path,
      env: { ...process.env, ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      encoding: 'utf8',
    }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), `# ${path}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  extra(git);
  return path;
}

/** A fake home: ~/Projects with a few checkouts and one plain folder. */
function makeHome(scratch: string) {
  const projects = join(scratch, 'Projects');
  const widgets = makeRepo(join(projects, 'widgets'), 0, (git) => {
    git('branch', 'feature/onboarding');
    git('branch', 'release/2026.10');
  });
  const gateway = makeRepo(join(projects, 'acme', 'api-gateway'), 2);
  writeFileSync(join(gateway, 'README.md'), 'local edit\n');
  makeRepo(join(projects, 'acme', 'billing-service'), 6);
  makeRepo(join(projects, 'sandbox', 'rust-raytracer'), 30);
  const notes = join(projects, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'todo.md'), '- [ ] nothing\n');
  return { projects, widgets, gateway, notes };
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

/** The panel is fully inside the window and horizontally centred. */
async function expectCentred(window: Page, panel: Locator) {
  await window.waitForTimeout(450);
  const box = await panel.boundingBox();
  const [vw, vh] = await window.evaluate(() => [innerWidth, innerHeight]);
  expect(box).not.toBeNull();
  if (!box || vw === undefined || vh === undefined) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  expect(box.y + box.height).toBeLessThanOrEqual(vh);
  expect(Math.abs(box.x + box.width / 2 - vw / 2)).toBeLessThanOrEqual(1);
  return box;
}

test('composer: repository picker, status line, base branch, at three sizes', async () => {
  test.setTimeout(240_000);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'legion-e2e-composer-')));
  const { projects, widgets, gateway, notes } = makeHome(scratch);

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
        // A fake home so paths read ~/Projects/… and nothing outside the scratch dir is scanned.
        HOME: scratch,
        LEGION_HOME: join(scratch, 'legion'),
        LEGION_FAKE_ENGINES: '1',
        LEGION_DISCOVER_ROOTS: projects,
        LEGION_E2E_PICK_DIR: widgets,
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await setSize(app, window, [1280, 800]);
    await expect(window.getByTestId('connection-status')).toHaveText('connected', { timeout: 30_000 });

    const composer = window.getByTestId('composer');
    const picker = composer.getByTestId('repo-picker');
    const list = window.getByTestId('repo-picker-list');
    const status = composer.getByTestId('repo-status');

    // ⌘N: the issue field has focus; nothing is picked on a fresh install.
    await window.keyboard.press('Meta+n');
    await expect(composer).toBeVisible();
    await expect.poll(() => window.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    await expect(picker).toContainText('Choose a repository…');
    // "Plan it" is visibly inert and says why on hover.
    await expect(composer.getByTestId('composer-submit')).toHaveAttribute('aria-disabled', 'true');
    await composer.getByTestId('composer-submit').hover();
    await expect(composer.getByTestId('composer-blocked')).toHaveText('Describe the work first');
    await expect(composer.getByTestId('composer-blocked')).toBeVisible();
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, 'fresh-1280x800.png') });

    // Click opens the list: discovery found the checkouts, newest commit first; the plain folder isn't one.
    await picker.click();
    await expect(list).toBeVisible();
    await expect(list.getByText('Found on this Mac')).toBeVisible();
    await expect(list.getByTestId('repo-option')).toHaveText([
      /widgets.*~\/Projects\/widgets.*main/,
      /api-gateway.*~\/Projects\/acme\/api-gateway/,
      /billing-service/,
      /rust-raytracer/,
    ]);
    await expect(list.getByTestId('repo-option').nth(1).locator('[data-dirty="true"]')).toHaveCount(1);
    // Search by name or path; ↓/⏎ choose; focus returns to the trigger.
    await window.keyboard.type('acme');
    await expect(list.getByTestId('repo-option')).toHaveCount(2);
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(picker).toContainText('billing-service');
    await expect(status).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe('repo-picker');

    // Esc closes only the list, not the composer.
    await window.keyboard.press('Enter');
    await expect(list).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(composer).toBeVisible();

    // Browse… (the native folder dialog; answered by LEGION_E2E_PICK_DIR).
    await picker.click();
    await window.getByTestId('repo-browse').click();
    await expect(picker).toHaveAttribute('title', widgets);
    await expect(status).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
    await expect(status).toContainText('Git repo');
    await expect(status).toContainText('default main');

    // Base branch: default preselected, filterable.
    const branch = composer.getByTestId('branch-picker');
    await expect(branch).toContainText('main');
    await expect(branch).toContainText('default');
    await branch.click();
    await expect(window.getByTestId('branch-option')).toHaveCount(3);
    await window.keyboard.type('onb');
    await expect(window.getByTestId('branch-option')).toHaveText([/feature\/onboarding/, /Use.*onb/]);
    await window.keyboard.press('Enter');
    await expect(branch).toContainText('feature/onboarding');
    await expect(branch).not.toContainText('default');

    // A typed path (~ expands) offers "Use <path>"; a plain folder gets an actionable error.
    await picker.click();
    await window.keyboard.type('~/Projects/notes');
    await expect(list.getByTestId('repo-option-path')).toContainText('~/Projects/notes');
    await window.keyboard.press('Enter');
    await expect(status).toHaveAttribute('data-state', 'error', { timeout: 15_000 });
    await expect(status).toContainText('Not a git repository. Run git init there, or pick another folder.');
    await expect(picker).toHaveAttribute('aria-invalid', 'true');
    await expect(picker).toHaveAttribute('title', notes);

    // A folder dragged from Finder onto the composer.
    await composer.locator('.cmp-root').evaluate((el, url) => {
      const data = new DataTransfer();
      data.items.add(new File([''], 'api-gateway'));
      data.setData('text/uri-list', url);
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, `file://${gateway}/`);
    await expect(composer.getByTestId('composer-drop')).toBeVisible();
    await window.waitForTimeout(200);
    await window.screenshot({ path: join(shots, 'drop-1280x800.png') });
    await composer.locator('.cmp-root').evaluate((el, url) => {
      const data = new DataTransfer();
      data.items.add(new File([''], 'api-gateway'));
      data.setData('text/uri-list', url);
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, `file://${gateway}/`);
    await expect(composer.getByTestId('composer-drop')).toHaveCount(0);
    await expect(picker).toHaveAttribute('title', gateway);
    await expect(status).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
    await expect(status).toContainText('uncommitted changes left alone');

    // Recent now lists what was used; ⌘O browses straight from the list.
    await picker.click();
    await expect(list.getByText('Recent')).toBeVisible();
    await window.keyboard.press('Meta+o');
    await expect(list).toHaveCount(0);
    await expect(picker).toHaveAttribute('title', widgets);
    await window.keyboard.press('Escape');
    await expect(composer).toHaveCount(0);

    // Screenshots of each state at each size; the panel is centred and fully visible.
    for (const size of SIZES) {
      const tag = `${size[0]}x${size[1]}`;
      await setSize(app, window, size);
      await window.keyboard.press('Meta+n');
      await expect(composer).toBeVisible();
      // Empty: no text yet (the draft keeps the last repo).
      await composer.locator('textarea').fill('');
      await composer.getByTestId('composer-submit').hover();
      await expectCentred(window, composer);
      await window.screenshot({ path: join(shots, `empty-${tag}.png`) });

      await picker.click();
      await expect(list).toBeVisible();
      await window.waitForTimeout(250);
      await window.screenshot({ path: join(shots, `picker-open-${tag}.png`) });
      await window.keyboard.type('~/Projects/');
      await window.waitForTimeout(150);
      await window.screenshot({ path: join(shots, `picker-path-${tag}.png`) });
      await window.keyboard.press('Escape');

      await composer
        .locator('textarea')
        .fill('Add rate limiting to the public widgets API\n\nPer API key, 429 with Retry-After.');
      await picker.click();
      await window.keyboard.type('widgets');
      await window.keyboard.press('Enter');
      await expect(status).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
      await composer.locator('textarea').focus();
      await window.waitForTimeout(250);
      await window.screenshot({ path: join(shots, `selected-${tag}.png`) });

      // A long prompt grows the text box; ⌘⇧E expands the composer, and the choice is remembered.
      const textarea = composer.locator('textarea');
      const short = await textarea.inputValue();
      const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Requirement line for a long, detailed prompt.`);
      await textarea.fill(`${short}\n\n${long.join('\n')}`);
      const grownHeight = (await textarea.boundingBox())?.height ?? 0;
      expect(grownHeight).toBeGreaterThan(236);
      await window.waitForTimeout(150);
      await window.screenshot({ path: join(shots, `long-${tag}.png`) });
      const narrowWidth = (await composer.boundingBox())?.width ?? 0;
      await window.keyboard.press('Meta+Shift+E');
      await expect(composer.getByTestId('composer-expand')).toHaveAttribute('aria-pressed', 'true');
      await window.waitForTimeout(400);
      expect((await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(narrowWidth);
      await window.screenshot({ path: join(shots, `expanded-${tag}.png`) });
      await composer.getByTestId('composer-expand').click();
      await expect(composer.getByTestId('composer-expand')).toHaveAttribute('aria-pressed', 'false');
      await textarea.fill(short);

      await composer.getByTestId('branch-picker').click();
      await window.waitForTimeout(250);
      await window.screenshot({ path: join(shots, `branch-open-${tag}.png`) });
      await window.keyboard.press('Escape');

      await picker.click();
      await window.keyboard.type(notes);
      await window.keyboard.press('Enter');
      await expect(status).toHaveAttribute('data-state', 'error', { timeout: 15_000 });
      await composer.locator('textarea').focus();
      await window.waitForTimeout(250);
      await window.screenshot({ path: join(shots, `error-${tag}.png`) });
      // Back to a good repo, so the next size's "empty" shot shows a ready repo with no text.
      await picker.click();
      await window.keyboard.type('widgets');
      await window.keyboard.press('Enter');
      await expect(status).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
      await window.keyboard.press('Escape');
      await expect(composer).toHaveCount(0);

      // The other overlays: centred and fully on screen.
      for (const [key, id] of [
        ['Meta+k', 'palette'],
        ['Meta+,', 'settings'],
      ] as const) {
        await window.keyboard.press(key);
        const panel = window.getByTestId(id);
        await expect(panel).toBeVisible();
        await expectCentred(window, panel);
        await window.screenshot({ path: join(shots, `${id}-${tag}.png`) });
        await window.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      }
    }
  } finally {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
