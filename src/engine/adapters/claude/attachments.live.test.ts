/**
 * Live: attachments reach the model through the real `claude` CLI (haiku, `pnpm test:live`). A PNG with a
 * big red "7" as an image block; a PDF with a code word as a document block on a follow-up message.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { permissionProfileFor, type SessionAttachment } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sevenPng, textPdf } from '../../attachments/testing';
import { tempDir } from '../../test/helpers';
import { ClaudeEngine } from './index';

const LIVE = process.env.LEGION_LIVE === '1';

let dir: ReturnType<typeof tempDir>;
beforeAll(() => {
  dir = tempDir('legion-claude-attachments-live-');
});
afterAll(() => dir.cleanup());

function attachment(name: string, content: Buffer, mime: string, kind: SessionAttachment['kind']): SessionAttachment {
  const path = join(dir.path, name);
  writeFileSync(path, content);
  return { name, mime, kind, path, size: content.length };
}

async function turnText(iterator: AsyncIterator<AgentEvent>): Promise<string> {
  let text = '';
  for (;;) {
    const next = await iterator.next();
    if (next.done) return text;
    if (next.value.type === 'message') text += next.value.text;
    if (next.value.type === 'turn_complete') {
      expect(next.value.isError).toBe(false);
      return text;
    }
  }
}

describe.skipIf(!LIVE)('claude attachments (live)', () => {
  it('an image block and a PDF document block reach the model', async () => {
    const env = process.env as Record<string, string>;
    const engine = new ClaudeEngine({
      env,
      spawn: (command, args, options) =>
        nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }),
    });
    const session = await engine.start({
      role: 'planner',
      cwd: dir.path,
      prompt: 'What number is in the attached image? Reply with just the digit.',
      model: 'haiku',
      effort: 'low',
      permission: permissionProfileFor('planner'),
      mcp: null,
      env,
      attachments: [attachment('seven.png', sevenPng(), 'image/png', 'image')],
    });
    const iterator = session.events[Symbol.asyncIterator]();
    expect(await turnText(iterator)).toMatch(/\b7\b/);

    await session.send('What is the code word in the attached PDF? Reply with just the word.', 'next', [
      attachment('code.pdf', textPdf('The code word is MANGO.'), 'application/pdf', 'file'),
    ]);
    expect((await turnText(iterator)).toUpperCase()).toContain('MANGO');
    await session.close();
  });
});
