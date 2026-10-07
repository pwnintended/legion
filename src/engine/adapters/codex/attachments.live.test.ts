/**
 * Live: an image attachment reaches the model through the real `codex app-server` (`localImage` input, low
 * effort, temp Legion CODEX_HOME). `pnpm test:live`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionProfileFor } from '@shared/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sevenPng } from '../../attachments/testing';
import { CodexEngine } from './index';
import { collectEvents } from './test-utils';

const LIVE = process.env.LEGION_LIVE === '1';

let root: string;
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;

describe.skipIf(!LIVE)('codex attachments (live)', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'legion-codex-attachments-live-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a localImage input reaches the model', async () => {
    const engine = new CodexEngine({ codexHome: join(root, 'codex-home'), env, clientVersion: 'live-test' });
    const image = join(root, 'seven.png');
    const png = sevenPng();
    await writeFile(image, png);
    const session = await engine.start({
      role: 'planner',
      cwd: root,
      prompt: 'What number is in the attached image? Reply with just the digit.',
      effort: 'low',
      permission: permissionProfileFor('planner'),
      mcp: null,
      env,
      attachments: [{ name: 'seven.png', mime: 'image/png', kind: 'image', path: image, size: png.length }],
    });
    const stream = collectEvents(session);
    const done = await stream.next('turn_complete');
    expect(done.isError).toBe(false);
    const text = stream.events.flatMap((e) => (e.type === 'message' ? [e.text] : [])).join('\n');
    expect(text).toMatch(/\b7\b/);
    await session.close();
  });
});
