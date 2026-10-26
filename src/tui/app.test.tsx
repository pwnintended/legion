import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeEngine } from '../engine/fake/index.ts';
import { type FixtureRepo, makeRepo } from '../git/test-helpers.ts';
import { Session } from '../session.ts';
import { ROOT } from '../team/team.ts';
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

    // Arrow down to the second option, Enter picks it.
    ui.stdin.write('\u001B[B');
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
    expect(ui.lastFrame()).toContain('color: blue');
    expect(ui.lastFrame()).toContain('note: shorter');
    ui.unmount();
  });

  it('writes a default project config and announces it', async () => {
    expect(session.createdConfig).toBe(join(repo.path, '.legion', 'config.toml'));
    const ui = render(<App controller={new Controller(session)} />);
    await tick();
    expect(ui.lastFrame()).toContain('Created .legion/config.toml');
    ui.unmount();
  });

  it('changes settings in the /config menu and saves them on Esc', async () => {
    const ui = render(<App controller={new Controller(session)} />);
    await tick();
    ui.stdin.write('/config');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('◆ Settings') ?? false);
    // Save to, engine, model, effort, approvals, maxAgents: five rows down, then two steps right.
    for (let i = 0; i < 5; i++) {
      ui.stdin.write('\u001B[B');
      await tick(30);
    }
    ui.stdin.write('\u001B[C');
    await tick(30);
    ui.stdin.write('\u001B[C');
    await until(() => /‹ 6 ›/.test(ui.lastFrame() ?? ''));
    ui.stdin.write('\u001B');
    await until(() => ui.lastFrame()?.includes('Settings changed') ?? false);
    expect(readFileSync(join(repo.path, '.legion', 'config.toml'), 'utf8')).toMatch(/^maxAgents = 6 +# /m);
    expect(session.config.workflows.maxAgents).toBe(6);
    ui.unmount();
  });

  it('sets a workflow agent model in the /workflows menu, and runs use it', async () => {
    const controller = new Controller(session);
    const ui = render(<App controller={controller} />);
    await tick();
    ui.stdin.write('/workflows');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Says hello') ?? false);
    // All workflows, feature, hello: open hello.
    for (let i = 0; i < 2; i++) {
      ui.stdin.write('\u001B[B');
      await tick(30);
    }
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('found by a dry run') ?? false);
    expect(ui.lastFrame()).toMatch(/greet +claude/);
    // Rows: save to, claude agents (selected), codex agents, greet. Down twice to greet, focus is on model.
    const key = async (k: string) => {
      ui.stdin.write(k);
      await tick(30);
    };
    await key('\u001B[B');
    await key('\u001B[B');
    // Model picker: inherit, then the Claude models; the first is opus.
    await key('\r');
    await until(() => ui.lastFrame()?.includes('alias: the newest Opus') ?? false);
    await key('\u001B[B');
    await key('\r');
    await until(() => /opus\s*›●/.test(ui.lastFrame() ?? ''));
    // Engine column: as coded, claude, codex.
    await key('\u001B[D');
    await key('\r');
    await until(() => ui.lastFrame()?.includes('as coded') ?? false);
    await key('\u001B[B');
    await key('\u001B[B');
    await key('\r');
    await until(() => (ui.lastFrame()?.match(/●/g) ?? []).length >= 2);
    ui.stdin.write('\u001B');
    await until(() => ui.lastFrame()?.includes('Models for hello') ?? false);
    ui.stdin.write('\u001B');
    await tick();
    expect(session.config.workflow.hello?.agent.greet).toMatchObject({ model: 'opus', engine: 'codex' });

    const id = await session.runs.start('hello', {});
    await until(() => session.runs.pendingInteractions().length > 0);
    const [ask] = session.runs.pendingInteractions();
    session.runs.answer(ask?.id ?? '', { answer: 'red' });
    await until(() => session.runs.pendingInteractions().length > 0);
    const [gate] = session.runs.pendingInteractions();
    session.runs.answer(gate?.id ?? '', { choice: 'approve', note: null });
    await session.runs.wait(id);
    const fake = session.engine('codex') as unknown as { calls: { opts: { model: string | null } }[] };
    expect(fake.calls.at(-1)?.opts.model).toBe('opus');
    expect(session.runs.journal(id).get('greet')?.meta).toMatchObject({ engine: 'codex', model: 'opus' });
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
    ui.stdin.write('\u001B');
    await until(() => !(ui.lastFrame()?.includes('◆ Workflows') ?? true));
    // The command menu completes a partial command.
    ui.stdin.write('/conf');
    await until(() => ui.lastFrame()?.includes('change them in a menu') ?? false);
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('◆ Settings') ?? false);
    expect(ui.lastFrame()).toContain('.legion/config.toml');
    ui.stdin.write('\u001B');
    await until(() => !(ui.lastFrame()?.includes('◆ Settings') ?? true));
    ui.stdin.write('/nope');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Unknown command /nope') ?? false);
    ui.unmount();
  });

  it('shows the team, talks to a lead, and lets the user answer its gates', async () => {
    const controller = new Controller(session);
    const ui = render(<App controller={controller} />);
    await tick();
    session.team.spawn(ROOT, { role: 'team-lead', name: 'assets', brief: 'Make the assets.' });
    await until(() => /team\s+1 lead/.test(ui.lastFrame() ?? ''));
    expect(ui.lastFrame()).toMatch(/assets team-lead/);

    // A lead's run asks its lead, not the user.
    const id = await session.runs.start('hello', {}, { owner: 'assets' });
    await until(() => session.team.pending('assets').length === 1);
    await tick();
    expect(ui.lastFrame()).not.toContain('1. red');
    expect(ui.lastFrame()).toMatch(/1 waiting/);

    ui.stdin.write('/lead assets');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Talking to assets') ?? false);
    // Attached: its run's question is the user's to answer too.
    await until(() => ui.lastFrame()?.includes('1. red') ?? false);
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Ship the greeting?') ?? false);
    ui.stdin.write('a');
    await until(() => !session.runs.isActive(id));
    expect(session.runs.run(id)?.result).toMatchObject({ color: 'red', approved: true });
    // The lead hears that the user answered for it.
    const lead = () =>
      (session.engine('claude') as FakeEngine).calls.find((c) => c.prompts[0]?.includes('Make the assets.'));
    await until(() => lead()?.prompts.some((p) => p.includes('The user answered')) ?? false);

    // Messages go to the lead; its replies show under its name.
    ui.stdin.write('how is it going?');
    await tick();
    ui.stdin.write('\r');
    await until(() => lead()?.prompts.includes('[User] how is it going?') ?? false);
    expect(ui.lastFrame()).toMatch(/assets ›/);

    ui.stdin.write('/lead');
    await tick();
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Back to the orchestrator.') ?? false);
    ui.unmount();
  });
});
