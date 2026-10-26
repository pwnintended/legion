import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, type FakeScript } from '../engine/fake/index.ts';
import { tmp } from '../git/test-helpers.ts';
import type { GitOps } from './host.ts';
import { RunManager } from './manager.ts';

let dir: { path: string; cleanup: () => void };
let script: FakeScript;
let engine: FakeEngine;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick();
  }
}

beforeEach(() => {
  dir = tmp('legion-manager-');
  mkdirSync(join(dir.path, '.legion', 'workflows'), { recursive: true });
  writeFileSync(
    join(dir.path, '.legion', 'workflows', 'two.ts'),
    `import { agent, workflow, z } from 'legion';
export default workflow({ name: 'two', description: 'Draft, then polish', input: z.object({}) }, async () => {
  const draft = await agent('draft', { prompt: 'draft it' });
  const polish = await agent('polish', { prompt: 'polish: ' + draft });
  return { draft, polish };
});
`,
  );
  engine = new FakeEngine('claude', (call, turn) => script(call, turn), 'claude-1');
});

afterEach(() => dir.cleanup());

function manager() {
  return new RunManager({
    repo: dir.path,
    engine: () => engine,
    profiles: () => ({ claude: 'claude-1' }),
    git: {} as GitOps,
    approvals: 'auto',
  });
}

const promptOf = (key: string) => engine.calls.filter((c) => c.prompts[0]?.startsWith(key)).at(-1)?.prompts ?? [];

describe('steering runs', () => {
  it('sends a message into a running agent', async () => {
    let release: (() => void) | null = null;
    script = async (call) => {
      if (call.prompts[0] === 'draft it') {
        // Works until it is told something.
        await new Promise<void>((r) => {
          release = r;
        });
        return { text: `draft (${call.prompts[1]})` };
      }
      return { text: 'polished' };
    };
    const runs = manager();
    const id = await runs.start('two', {});
    await until(() => runs.liveAgents(id).includes('draft'));
    await expect(runs.messageAgent(id, 'polish', 'x')).rejects.toThrow(/running: draft/);
    await runs.messageAgent(id, 'draft', 'use British spelling');
    (release as (() => void) | null)?.();
    const record = await runs.wait(id);
    expect(record?.result).toEqual({ draft: 'draft (use British spelling)', polish: 'polished' });
    expect(runs.liveAgents(id)).toEqual([]);
  });

  it('retries a failed step with notes', async () => {
    script = (call) =>
      call.prompts[0]?.startsWith('polish') && !call.prompts[0].includes('Notes for this attempt')
        ? { error: 'too long' }
        : { text: call.prompts[0]?.startsWith('polish') ? 'short' : 'a draft' };
    const runs = manager();
    const id = await runs.start('two', {});
    expect((await runs.wait(id))?.status).toBe('failed');
    await runs.resume(id, { notes: 'Keep it under ten words.', step: 'polish' });
    const record = await runs.wait(id);
    expect(record?.result).toEqual({ draft: 'a draft', polish: 'short' });
    expect(promptOf('polish')[0]).toContain('Keep it under ten words.');
    // The draft came from the journal.
    expect(engine.calls.filter((c) => c.prompts[0] === 'draft it')).toHaveLength(1);
  });

  it('rewinds a finished step and redoes what came after it', async () => {
    let n = 0;
    script = (call) => ({
      text: call.prompts[0]?.startsWith('polish') ? `polished ${call.prompts[0]}` : `draft ${++n}`,
    });
    const runs = manager();
    const id = await runs.start('two', {});
    expect((await runs.wait(id))?.result).toEqual({ draft: 'draft 1', polish: 'polished polish: draft 1' });
    await expect(runs.resume(id)).rejects.toThrow(/already finished/);
    await runs.resume(id, { step: 'draft', rewind: true, notes: 'Bolder.' });
    const record = await runs.wait(id);
    expect(record?.status).toBe('done');
    expect(record?.result).toEqual({ draft: 'draft 2', polish: 'polished polish: draft 2' });
    expect(promptOf('draft it').at(0)).toContain('Bolder.');
  });
});
