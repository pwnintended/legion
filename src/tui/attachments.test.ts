import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentNote, imagePaths, saveAttachment } from './attachments.ts';

// A 1×1 PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legion-attach-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attachments', () => {
  it('takes pasted or dropped image paths, escaped or quoted, and nothing else', () => {
    mkdirSync(join(dir, 'Screen Shots'));
    const a = join(dir, 'Screen Shots', 'shot 1.png');
    const b = join(dir, 'b.JPG');
    writeFileSync(a, PIXEL);
    writeFileSync(b, PIXEL);
    writeFileSync(join(dir, 'notes.txt'), 'hi');
    expect(imagePaths(a.replace(/ /g, '\\ '))).toEqual([a]);
    expect(imagePaths(`'${a}' ${b}\n`)).toEqual([a, b]);
    expect(imagePaths(`"${a}"`)).toEqual([a]);
    expect(imagePaths(`file://${encodeURI(b)}`)).toEqual([b]);
    expect(imagePaths('b.JPG', dir)).toEqual([b]);
    // Text, a file that is not an image, a path that is not there, an image path inside a sentence.
    expect(imagePaths('hello there')).toBeNull();
    expect(imagePaths(join(dir, 'notes.txt'))).toBeNull();
    expect(imagePaths(join(dir, 'gone.png'))).toBeNull();
    expect(imagePaths(`look at ${b}`)).toBeNull();
    expect(imagePaths('  ')).toBeNull();
    expect(imagePaths(`'${a}`)).toBeNull();
  });

  it('keeps an image as a numbered PNG with its size, and notes where it is', async () => {
    const out = join(dir, 'attachments');
    const first = { n: 1, path: join(out, '1.png'), width: 1, height: 1 };
    expect(await saveAttachment(out, 1, PIXEL)).toEqual(first);
    expect(readFileSync(join(out, '1.png'))).toEqual(PIXEL);
    const file = join(dir, 'shot.png');
    writeFileSync(file, PIXEL);
    // Number 1 again (a new session): the file already there is kept.
    expect((await saveAttachment(out, 1, file))?.path).toBe(join(out, '1-2.png'));
    expect(await saveAttachment(out, 3, Buffer.from('not an image'))).toBeNull();
    expect(attachmentNote([first, { n: 2, path: '/x/2.png', width: 4, height: 4 }])).toBe(
      `[Image #1: ${join(out, '1.png')}]\n[Image #2: /x/2.png]`,
    );
  });
});
