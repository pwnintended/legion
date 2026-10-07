/**
 * How each adapter puts attachments on the wire (verified against the real CLIs by the live tests):
 * Claude stream-json user messages carry image / document content blocks, Codex `turn/start` and
 * `turn/steer` carry `localImage` inputs; both inline text files and reference other files by path.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBytes } from '@shared/attachments';
import { permissionProfileFor, type SessionAttachment, type SessionOptions } from '@shared/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sevenPng, textPdf } from '../attachments/testing';
import { silentLogger } from '../context';
import { INLINE_TEXT_CHARS, messageText } from './attachments';
import { ClaudeEngine } from './claude/engine';
import { userContent, userMessage } from './claude/protocol';
import { FakeChild } from './claude/testing';
import { turnStartParams, userInput } from './codex/config';
import { REPLAY_SERVER } from './codex/fixtures';
import { CodexSession } from './codex/session';
import { collectEvents } from './codex/test-utils';

let dir: string;
let png: SessionAttachment;
let pdf: SessionAttachment;
let notes: SessionAttachment;
let log: SessionAttachment;
let archive: SessionAttachment;

function file(
  name: string,
  content: Buffer | string,
  mime: string,
  kind: SessionAttachment['kind'],
): SessionAttachment {
  const path = join(dir, name);
  writeFileSync(path, content);
  return { name, mime, kind, path, size: Buffer.byteLength(content) };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-adapter-attachments-'));
  png = file('seven.png', sevenPng(), 'image/png', 'image');
  pdf = file('spec.pdf', textPdf('The code word is MANGO.'), 'application/pdf', 'file');
  notes = file('notes.md', '# Notes\n\nUse `pnpm` here.\n', 'text/markdown', 'text');
  log = file('huge.log', 'y'.repeat(INLINE_TEXT_CHARS + 10), 'text/plain', 'text');
  archive = file('model.bin', 'data', 'application/octet-stream', 'file');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (a: SessionAttachment) => readFileSync(a.path).toString('base64');

describe('message text', () => {
  it('is the plain text without attachments', () => {
    expect(messageText('hi', null, () => true)).toBe('hi');
    expect(messageText('hi', [], () => true)).toBe('hi');
  });

  it('names native files, inlines text files in a fence and references the rest by path', () => {
    const text = messageText('Fix the bug.', [png, notes, archive], (a) => a.kind === 'image');
    expect(text).toBe(
      [
        'Fix the bug.',
        'Attached file (included with this message): `seven.png`.',
        'Attached file `notes.md` (26 B):\n```md\n# Notes\n\nUse `pnpm` here.\n```',
        `Attached file \`model.bin\` (application/octet-stream, 4 B) is at ${archive.path}.`,
      ].join('\n\n'),
    );
  });

  it('cuts long text files and points at the full file', () => {
    const text = messageText('Look', [log], () => false);
    expect(text).toContain(`first 100,000 characters; the full file is at ${log.path}`);
    expect(text.length).toBeLessThan(INLINE_TEXT_CHARS + 500);
  });
});

describe('Claude: stream-json content blocks', () => {
  it('images and PDFs become base64 blocks before one text block', () => {
    expect(userContent('What number?', [png, pdf, notes])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png) } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) },
        title: 'spec.pdf',
      },
      {
        type: 'text',
        text: [
          'What number?',
          'Attached files (included with this message): `seven.png`, `spec.pdf`.',
          'Attached file `notes.md` (26 B):\n```md\n# Notes\n\nUse `pnpm` here.\n```',
        ].join('\n\n'),
      },
    ]);
  });

  it('keeps the plain string form without attachments, and degrades an unreadable image to its path', () => {
    expect(userMessage('hi', 'now')).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
      session_id: '',
      priority: 'now',
    });
    const missing = { ...png, path: join(dir, 'missing.png') };
    expect(userContent('see', [missing])).toEqual([
      {
        type: 'text',
        text: `see\n\nAttached file \`seven.png\` (image/png, ${formatBytes(png.size)}) is at ${missing.path}.`,
      },
    ]);
  });

  it('the session writes the first prompt and steer messages with their attachments', async () => {
    const children: FakeChild[] = [];
    const engine = new ClaudeEngine({
      binaryPath: process.execPath,
      log: silentLogger,
      timing: { coalesceMs: 0, interruptTimeoutMs: 50, closeGraceMs: 50, killTimeoutMs: 50 },
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    const opts: SessionOptions = {
      role: 'planner',
      cwd: dir,
      prompt: 'Plan this.',
      permission: permissionProfileFor('planner'),
      mcp: null,
      env: { PATH: '/usr/bin:/bin' },
      attachments: [png],
    };
    const session = await engine.start(opts);
    const child = children[0] as FakeChild;
    const first = child.written[0] as { message: { content: unknown[] } };
    expect(first.message.content).toHaveLength(2);
    expect(first.message.content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    await session.send('And this file', 'next', [notes]);
    expect(child.written[1]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: expect.stringContaining('```md\n# Notes') }] },
    });
    child.exit(0, null);
    await session.close();
  });
});

describe('Codex: app-server user input', () => {
  it('one text input, then a localImage per image; PDFs are referenced by path', () => {
    expect(userInput('What number?', [png, notes, pdf])).toEqual([
      {
        type: 'text',
        text: [
          'What number?',
          'Attached file (included with this message): `seven.png`.',
          'Attached file `notes.md` (26 B):\n```md\n# Notes\n\nUse `pnpm` here.\n```',
          `Attached file \`spec.pdf\` (application/pdf, ${formatBytes(pdf.size)}) is at ${pdf.path}.`,
        ].join('\n\n'),
        text_elements: [],
      },
      { type: 'localImage', path: png.path },
    ]);
    expect(userInput('hi')).toEqual([{ type: 'text', text: 'hi', text_elements: [] }]);
    const opts = { effort: 'low' } as SessionOptions;
    expect(turnStartParams('t1', 'x', opts, [png]).input.at(-1)).toEqual({ type: 'localImage', path: png.path });
  });

  it('turn/start and turn/steer carry the attachments (replayed app-server checks the params)', async () => {
    const transcript = join(dir, 'attachments.jsonl');
    const start = userInput('Plan this.', [png]);
    const steer = userInput('Also this', [notes, png]);
    const entries = [
      { dir: 'out', msg: { id: 1, method: 'initialize' } },
      { dir: 'in', msg: { id: 1, result: { userAgent: 'legion/0.160.0 (test)', codexHome: '/h' } } },
      { dir: 'out', msg: { method: 'initialized' } },
      { dir: 'out', msg: { id: 2, method: 'thread/start' } },
      { dir: 'in', msg: { id: 2, result: { thread: { id: 't1' }, model: 'gpt-test' } } },
      { dir: 'out', msg: { id: 3, method: 'turn/start' }, expectParams: { input: start } },
      { dir: 'in', msg: { id: 3, result: { turn: { id: 'u1', status: 'inProgress' } } } },
      { dir: 'in', msg: { method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } } },
      { dir: 'out', msg: { id: 4, method: 'turn/steer' }, expectParams: { input: steer, expectedTurnId: 'u1' } },
      { dir: 'in', msg: { id: 4, result: { turnId: 'u1' } } },
      {
        dir: 'in',
        msg: { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1', status: 'completed' } } },
      },
    ];
    writeFileSync(transcript, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const session = await CodexSession.open(
      {
        role: 'planner',
        cwd: dir,
        prompt: 'Plan this.',
        permission: permissionProfileFor('planner'),
        mcp: null,
        env: { PATH: process.env.PATH ?? '' },
        attachments: [png],
      },
      { kind: 'start' },
      {
        command: process.execPath,
        args: [REPLAY_SERVER, transcript],
        codexHome: join(dir, 'home'),
        clientVersion: 't',
      },
    );
    const stream = collectEvents(session);
    await session.send('Also this', 'next', [notes, png]);
    await stream.next('turn_complete');
    await session.close();
    await stream.done;
    // A params mismatch makes the replay server exit with code 3.
    expect(stream.events.at(-1)).toEqual({ type: 'exited', code: 0 });
  });
});
