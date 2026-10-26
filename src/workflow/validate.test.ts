import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from './validate.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-validate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe('validateWorkflow', () => {
  it('passes a correct workflow and records the dry-run steps', async () => {
    const path = file(
      'ok.ts',
      `import { workflow, agent, gate, loop, z } from 'legion';
export default workflow({ name: 'ok', description: 'fine', input: z.object({ task: z.string() }) }, async ({ task }) => {
  const plan = await agent('plan', { mode: 'read', prompt: task, output: z.object({ steps: z.array(z.object({ id: z.string() })) }) });
  await gate('approve', { title: 'ok?', show: plan });
  await loop('fix', { max: 2 }, async () => ({ done: true }));
  return plan.steps.length;
});
`,
    );
    const report = await validateWorkflow(path, { repo: dir });
    expect(report.typeErrors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.dryRun?.steps).toContain('✓ agent plan');
  }, 30_000);

  it('reports type errors and dry-run failures', async () => {
    const path = file(
      'bad.ts',
      `import { workflow, agent, step, z } from 'legion';
export default workflow({ name: 'bad', description: 'broken', input: z.object({}) }, async () => {
  const r = await agent('a', { prompt: 'x', output: z.object({ items: z.array(z.string()) }) });
  await step('s', async () => 1);
  await step('s', async () => 2);
  return r.itemz;
});
`,
    );
    const report = await validateWorkflow(path, { repo: dir });
    expect(report.ok).toBe(false);
    expect(report.typeErrors.join('\n')).toMatch(/itemz/);
    expect(report.dryRun?.error).toMatch(/Duplicate step key "s"/);
  }, 30_000);

  it('reports a file without a workflow export', async () => {
    const report = await validateWorkflow(file('none.ts', 'export const x = 1;\n'), { repo: dir });
    expect(report.loadError).toMatch(/export default workflow/);
  }, 30_000);
});
