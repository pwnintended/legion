import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureRepo, makeRepo } from '../git/test-helpers.ts';
import { Session } from '../session.ts';
import { App } from './app.tsx';
import { Controller } from './controller.ts';

let repo: FixtureRepo;
let session: Session;

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(20);
  }
}

beforeEach(async () => {
  repo = await makeRepo();
  // A workflow with a gate and a question, run on fake engines.
  mkdirSync(join(repo.path, '.legion', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo.path, '.legion', 'workflows', 'hello.ts'),
    `import { workflow, agent, gate, ask, z } from 'legion';
export default workflow({ name: 'hello', description: 'Says hello', input: z.object({ who: z.string().default('world') }) },
  async ({ who }) => {
    const color = await ask('color', 'Favourite color?', { options: ['red', 'blue'] });
    const text = await agent('greet', { prompt: 'greet ' + who });
    const ok = await gate('ok', { title: 'Ship the greeting?', show: text });
    return { color, approved: ok.approved, note: ok.note };
  });
`,
  );
  session = await Session.open({ cwd: repo.path, fake: true });
});

afterEach(async () => {
  await session.close();
  repo.cleanup();
});

describe('App', () => {
  it('chats with the assistant and runs a workflow through its gates', async () => {
    const controller = new Controller(session);
    const ui = render(<App controller={controller} />);
    await tick();

    ui.stdin.write('hi there');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('(fake claude reply)') ?? false);
    expect(ui.lastFrame()).toContain('› hi there');

    ui.stdin.write('/run hello {"who":"ada"}');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Favourite color?') ?? false);
    expect(ui.lastFrame()).toContain('1. red');

    ui.stdin.write('2');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Ship the greeting?') ?? false);

    // Request changes with a note.
    ui.stdin.write('c');
    await tick();
    ui.stdin.write('shorter');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('hello finished') ?? false);
    expect(ui.lastFrame()).toContain('"color": "blue"');
    expect(ui.lastFrame()).toContain('"note": "shorter"');
    ui.unmount();
  });

  it('lists workflows and reports unknown commands', async () => {
    const controller = new Controller(session);
    const ui = render(<App controller={controller} />);
    await tick();
    ui.stdin.write('/workflows');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Says hello') ?? false);
    expect(ui.lastFrame()).toMatch(/feature\s+builtin/);
    ui.stdin.write('/nope');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Unknown command /nope') ?? false);
    ui.unmount();
  });
});
