/**
 * Projects as the home, against the real engine (no demo data): a fresh install shows onboarding that leads with
 * "Add a project"; adding one (Browse… answered by `LEGION_E2E_PICK_DIR`) lands on its page (a new conversation),
 * not the composer; its Code view opens on the project's main checkout (a shell, the files in the side panel).
 * Then: browse the tree, open a file, ⌘P go to file, ⌘⇧F search and open a hit at its line, open a commit's diff
 * from the history, edit a file and save it (and see changes made on disk show up, or flagged under unsaved
 * edits), select lines and "Start a run about this…" (composer with the project and a `path:lines` reference).
 * Screenshots at 1280×800 and 1728×1117 go to test-results/project-home/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const shots = join(root, 'test-results', 'project-home');
const SIZES = [
  [1280, 800],
  [1728, 1117],
] as const;

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@widgets.test',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@widgets.test',
};

// A tiny PNG (4×4, mauve) for the image preview.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mM8veP/fwYiAOOoQvoqBAB2vgw5L8wn1QAAAABJRU5ErkJggg==',
  'base64',
);

const README = `# widgets

Small, sharp UI widgets for dashboards. No runtime dependencies.

## Install

\`\`\`sh
pnpm add @acme/widgets
\`\`\`

## Usage

\`\`\`ts
import { sparkline } from '@acme/widgets';

sparkline(el, [3, 1, 4, 1, 5, 9, 2, 6]);
\`\`\`

## Development

- \`pnpm test\` runs the unit tests
- \`pnpm build\` emits \`dist/\`
- See [the design notes](docs/design.md) before adding a widget.
`;

const STRINGS = `/** String helpers shared by every widget. */
export function shout(text: string): string {
  return text.toUpperCase();
}

export function truncate(text: string, max: number): string {
  // TODO: count grapheme clusters, not code units
  return text.length > max ? \`\${text.slice(0, max - 1)}…\` : text;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
`;

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  let clock = Math.floor(Date.now() / 1000) - 12 * 86_400;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: path,
      env: { ...process.env, ...gitEnv, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
      encoding: 'utf8',
    }).trim();
  const write = (files: Record<string, string | Buffer>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(path, rel)), { recursive: true });
      writeFileSync(join(path, rel), content);
    }
  };
  const commit = (message: string, files: Record<string, string | Buffer>, hours: number) => {
    clock += hours * 3600;
    write(files);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit(
    'Initial import',
    {
      'README.md': '# widgets\n',
      'package.json': '{\n  "name": "@acme/widgets",\n  "version": "0.1.0",\n  "type": "module"\n}\n',
      '.gitignore': 'node_modules/\ndist/\n*.log\n',
      'src/index.ts': "export * from './sparkline';\nexport * from './util/strings';\n",
    },
    0,
  );
  commit('Add string helpers', { 'src/util/strings.ts': STRINGS }, 20);
  commit(
    'Sparkline widget',
    {
      'src/sparkline.ts':
        "import { truncate } from './util/strings';\n\nexport function sparkline(el: HTMLElement, values: number[]): void {\n  const max = Math.max(...values);\n  el.title = truncate(values.join(', '), 40);\n  el.dataset.max = String(max);\n}\n",
    },
    30,
  );
  git('tag', 'v0.1.0');
  commit(
    'Docs: design notes and logo',
    {
      'docs/design.md': '# Design notes\n\nWidgets render into a host element and never own layout.\n',
      'docs/logo.png': PNG,
    },
    26,
  );
  commit('README: install and usage', { 'README.md': README }, 40);
  commit(
    'Gauge widget (draft)',
    {
      'src/gauge.ts':
        "export function gauge(el: HTMLElement, value: number): void {\n  // TODO: animate the needle\n  el.style.setProperty('--value', String(value));\n}\n",
    },
    18,
  );
  git('branch', 'feat/gauge');
  // Ignored and untracked files.
  write({
    'debug.log': 'noise\n',
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'NOTES.md': 'untracked notes\n',
  });
  return path;
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

async function shotAt(
  app: ElectronApplication,
  window: Page,
  name: string,
  sizes: readonly (readonly [number, number])[] = SIZES,
) {
  for (const size of sizes) {
    await setSize(app, window, size);
    await window.waitForTimeout(450);
    await window.screenshot({ path: join(shots, `${name}-${size[0]}x${size[1]}.png`) });
  }
}

/** The viewer's tab on show. */
const shownTab = (window: Page) => window.getByTestId('code-viewer').locator('.cw-tab-body:not([hidden])');

test('project home: add a project, browse, go to file, search, a commit, start a run from a selection', async () => {
  test.setTimeout(240_000);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'legion-e2e-project-')));
  const projects = join(scratch, 'Projects');
  const repo = makeRepo(join(projects, 'widgets'));
  // An untracked file to edit (saving it leaves the tracked files clean).
  const scratchFile = join(repo, 'src', 'scratch.ts');
  writeFileSync(scratchFile, 'export const a = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main', join(projects, 'gateway')], { env: { ...process.env, ...gitEnv } });

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
        HOME: scratch,
        LEGION_HOME: join(scratch, 'legion'),
        LEGION_FAKE_ENGINES: '1',
        LEGION_DISCOVER_ROOTS: projects,
        LEGION_E2E_PICK_DIR: repo,
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await setSize(app, window, [1280, 800]);
    await expect(window.getByTestId('connection-status')).toHaveText('connected', { timeout: 30_000 });

    // A fresh install invites a project, not a prompt.
    const onboarding = window.getByTestId('onboarding');
    await expect(onboarding).toBeVisible();
    await expect(onboarding).toContainText('Start with a project.');
    await expect(window.getByTestId('onboarding-repo').first()).toContainText('widgets', { timeout: 15_000 });
    await shotAt(app, window, '01-onboarding');

    // Add a project: the picker, then Browse… (answered by the test hook). Lands on the home, no composer.
    await setSize(app, window, [1280, 800]);
    await window.getByTestId('onboarding-add-project').click();
    const add = window.getByTestId('add-project');
    await expect(add).toBeVisible();
    await expect(add.getByTestId('add-project-option').first()).toContainText('widgets');
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, '02-add-project-1280x800.png') });
    await add.getByTestId('add-project-browse').click();
    await expect(add).toHaveCount(0);
    await expect(window.getByTestId('composer')).toHaveCount(0);
    // The project's page opens on a new conversation; its Code view is the project's home.
    await expect(window.getByTestId('new-conversation')).toBeVisible();
    await expect(window.getByTestId('new-conversation-input')).toBeVisible();
    await expect(window.getByTestId('view-code')).toHaveText(/Code/);
    // No run yet: no agents to show.
    await expect(window.getByTestId('titlebar-agents')).toHaveCount(0);
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(shots, '02b-new-conversation-1280x800.png') });
    await window.getByTestId('view-code').click();
    await expect(window.getByTestId('view-code')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('code-panel')).toHaveAttribute('data-section', 'files');
    // Terminal-first: a shell in the main checkout.
    await expect(window.getByTestId('code-terminal')).toHaveCount(1);
    await expect(window.getByTestId('code-terminal')).toContainText('widgets');
    await expect(window.getByTestId('rail-project')).toHaveCount(1);
    await expect(window.getByTestId('titlebar-project')).toHaveText('widgets');
    // Files: ignored files are not there, untracked ones are.
    const files = window.getByTestId('project-files');
    await expect(files.getByTestId('file-row')).toHaveText([
      /docs/,
      /src/,
      /\.gitignore/,
      /NOTES\.md/,
      /package\.json/,
      /README\.md/,
    ]);
    // The README renders in a viewer beside the shell; repository-relative links survive the URL hardening.
    await files.locator('[data-path="README.md"]').click();
    const readme = window.getByTestId('code-viewer').getByTestId('code-markdown');
    await expect(readme).toContainText('Small, sharp UI widgets');
    await expect(readme).not.toContainText('[blocked]');
    await expect(readme.getByRole('link', { name: 'the design notes' })).toBeVisible();
    // Activity (the panel's clock): no runs yet, the history with decorations.
    await window.getByTestId('code-section-activity').click();
    const activity = window.getByTestId('project-activity');
    await expect(activity.getByTestId('activity-commit')).toHaveCount(6);
    await expect(activity.getByTestId('activity-commit').first()).toContainText('Gauge widget (draft)');
    await expect(activity.getByTestId('activity-commit').first()).toContainText('feat/gauge');
    await expect(activity).toContainText('No runs in this project yet.');
    await window.getByTestId('code-section-files').click();
    await shotAt(app, window, '03-home');

    // Browse the tree and open a file (keyboard: → expands, ↓ moves, ⏎ opens).
    await files.locator('[data-path="src"]').click();
    await files.locator('[data-path="src/util"]').click();
    await files.locator('[data-path="src/util/strings.ts"]').click();
    const code = shownTab(window);
    await expect(code.getByTestId('code-tile')).toHaveAttribute('data-path', 'src/util/strings.ts');
    await expect(code.getByTestId('code-editor')).toContainText('toUpperCase');
    const tabs = window.getByTestId('code-viewer').getByTestId('code-tab');
    await window.waitForTimeout(600);
    await shotAt(app, window, '04-file');

    // An image previews; Markdown renders (with a source toggle).
    await setSize(app, window, [1280, 800]);
    await files.locator('[data-path="docs"]').click();
    await files.locator('[data-path="docs/logo.png"]').click();
    await expect(code.getByTestId('code-image')).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: join(shots, '04b-image-1280x800.png') });
    await files.locator('[data-path="docs/design.md"]').click();
    await expect(code.getByTestId('code-markdown')).toContainText('never own layout');
    // Still one tab: browsing reuses the preview tab. ⌘-click keeps a file as a tab of its own.
    await expect(tabs).toHaveCount(1);
    await files.locator('[data-path="README.md"]').click({ modifiers: ['Meta'] });
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('data-pinned', 'true');

    // ⌘P: fuzzy go to file.
    await window.keyboard.press('Meta+p');
    const goto = window.getByTestId('goto-file');
    await expect(goto).toBeVisible();
    await window.keyboard.type('spark');
    await expect(goto.getByTestId('goto-option').first()).toContainText('sparkline.ts');
    await window.waitForTimeout(250);
    await window.screenshot({ path: join(shots, '05-goto-1280x800.png') });
    await window.keyboard.press('Enter');
    await expect(goto).toHaveCount(0);
    await expect(code.getByTestId('code-tile')).toHaveAttribute('data-path', 'src/sparkline.ts');

    // ⌘⇧F: the panel's search, the caret in its field; open a hit at its line.
    await window.keyboard.press('Meta+Shift+f');
    await expect(window.getByTestId('code-panel')).toHaveAttribute('data-section', 'search');
    const search = window.getByTestId('project-search');
    await expect(search).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe('search-input');
    await window.keyboard.type('TODO');
    await expect(search.getByTestId('search-status')).toContainText('2 results in 2 files');
    await expect(search.getByTestId('search-hit')).toHaveCount(2);
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('Enter');
    await expect(code.getByTestId('code-tile')).toHaveAttribute('data-path', 'src/util/strings.ts');
    await expect(code.getByTestId('code-selection-bar')).toContainText('L7');
    await window.waitForTimeout(500);
    await shotAt(app, window, '06-search');

    // A commit from the history opens as a diff in the viewer.
    await setSize(app, window, [1280, 800]);
    await window.getByTestId('code-section-activity').click();
    await activity.getByTestId('activity-commit').nth(4).click();
    const diff = window.getByTestId('code-viewer').locator('.cw-tab-body:not([hidden])[data-kind="diff"]');
    await expect(diff).toBeVisible();
    await expect(tabs.filter({ hasText: /Commit|[0-9a-f]{7}/ })).toHaveCount(1);
    await expect(diff).toContainText('src/util/strings.ts');
    await window.waitForTimeout(600);
    await shotAt(app, window, '07-commit');

    // Edit and save (⌘S): the file on disk changes. A change made on disk shows up in an untouched editor; under
    // unsaved edits it is flagged, and "Take theirs" takes it.
    await setSize(app, window, [1280, 800]);
    await window.getByTestId('code-section-files').click();
    await files.locator('[data-path="src/scratch.ts"]').click();
    const editor = code.getByTestId('code-editor');
    await expect(editor).toContainText('export const a = 1;');
    await editor.locator('.cm-content').click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('export const b = 2;');
    await expect(code.locator('.cv-state')).toHaveText('Unsaved');
    await window.keyboard.press('Meta+s');
    await expect.poll(() => readFileSync(scratchFile, 'utf8')).toContain('export const b = 2;');
    await expect(code.locator('.cv-state')).toHaveCount(0);
    writeFileSync(scratchFile, 'export const c = 3;\n');
    await expect(editor).toContainText('export const c = 3;', { timeout: 8000 });
    await editor.locator('.cm-content').click();
    await window.keyboard.type('// mine');
    writeFileSync(scratchFile, 'export const d = 4;\n');
    await expect(code.getByTestId('code-conflict')).toBeVisible({ timeout: 8000 });
    await window.waitForTimeout(300);
    await shotAt(app, window, '07b-conflict', [[1280, 800]]);
    await code.getByRole('button', { name: 'Take theirs' }).click();
    await expect(editor).toContainText('export const d = 4;');
    await expect(code.getByTestId('code-conflict')).toHaveCount(0);
    await expect(code.locator('.cv-state')).toHaveCount(0);

    // Select lines in the editor → "Start a run about this…" → the composer with this project.
    await files.locator('[data-path="src/util/strings.ts"]').click();
    await code.locator('.cm-line').nth(5).click();
    await code
      .locator('.cm-line')
      .nth(8)
      .click({ modifiers: ['Shift'] });
    const bar = code.getByTestId('code-selection-bar');
    await expect(bar).toContainText('L6–9');
    await window.waitForTimeout(300);
    await shotAt(app, window, '08-selection');
    await setSize(app, window, [1280, 800]);
    await bar.getByTestId('code-start-run').click();
    const composer = window.getByTestId('composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('textarea')).toHaveValue(/src\/util\/strings\.ts:6-9/);
    await expect(composer.getByTestId('repo-picker')).toHaveAttribute('title', repo);
    await window.waitForTimeout(400);
    await shotAt(app, window, '09-composer');

    // ⌘⇧N from the home preselects the project too; the run shows up under it in the rail.
    await window.keyboard.press('Escape');
    await expect(composer).toHaveCount(0);
    await window.keyboard.press('Meta+Shift+n');
    await expect(composer).toBeVisible();
    await composer.locator('textarea').fill('Make truncate count graphemes');
    await expect(composer.getByTestId('repo-status')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
    await composer.getByTestId('composer-submit').click();
    await expect(composer).toHaveCount(0);
    await expect(window.getByTestId('rail-run')).toHaveCount(1);
    await expect(window.getByTestId('titlebar')).toContainText('widgets');
    // The run opens on its chat, a tile of the project's board. Code still belongs to the project: the same
    // workspace, as you left it.
    await expect(window.getByTestId('chat')).toBeVisible();
    await window.getByTestId('view-code').click();
    await expect(window.getByTestId('view-code')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('code-space')).toHaveCount(1);
    await expect(tabs).not.toHaveCount(0);
    await window.getByTestId('code-section-activity').click();
    await expect(activity.getByTestId('activity-run')).toHaveCount(1);
    await window.waitForTimeout(500);
    await shotAt(app, window, '10-home-with-run');
  } finally {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('project home in demo mode: a project with runs, PRs and history', async () => {
  const home = mkdtempSync(join(tmpdir(), 'legion-e2e-project-demo-'));
  mkdirSync(shots, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ args: [root], cwd: root, env: { ...env, LEGION_HOME: home } });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.evaluate(() => {
      localStorage.setItem('legion.demo', '1');
      localStorage.setItem('legion.demo.live', '0');
    });
    await window.reload();
    await expect(window.getByTestId('titlebar')).toContainText('demo', { timeout: 30_000 });
    // Three projects, the runs grouped under them.
    await expect(window.getByTestId('rail-project')).toHaveCount(3);
    await expect(window.getByTestId('rail-run')).toHaveCount(8);
    await window.getByTestId('rail-project').first().click();
    await expect(window.getByTestId('board').getByTestId('board-tile')).toHaveCount(2);
    await window.getByTestId('view-code').click();
    await expect(window.getByTestId('view-code')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('code-terminal')).toHaveCount(1);
    await window.getByTestId('code-section-activity').click();
    const activity = window.getByTestId('project-activity');
    await expect(activity.getByTestId('activity-run')).toHaveCount(2);
    await expect(activity.getByTestId('activity-pr')).toHaveCount(2);
    await expect(activity.getByTestId('activity-commit').first()).toContainText('Passkeys: enrollment UI');
    // The README's relative image is loaded from the project.
    await window.getByTestId('code-section-files').click();
    await window.getByTestId('project-files').locator('[data-path="README.md"]').click();
    await expect(window.getByTestId('code-markdown').locator('img.md-repo-img')).toHaveCount(1);
    await shotAt(app, window, 'demo-home');
    // ⌘P in demo mode too.
    await setSize(app, window, [1280, 800]);
    await window.keyboard.press('Meta+p');
    await window.keyboard.type('passkeylist');
    await expect(window.getByTestId('goto-option').first()).toContainText('PasskeyList.tsx');
    await window.keyboard.press('Enter');
    await expect(shownTab(window).getByTestId('code-editor')).toContainText('PasskeyList');
    await window.waitForTimeout(600);
    await shotAt(app, window, 'demo-file');
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
