import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  cleanName,
  formatBytes,
  looksLikeText,
  pastedImageName,
  precheck,
  sizeProblem,
  sniffAttachment,
  sniffImage,
  typeLabel,
} from './attachments';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (s: string) => new TextEncoder().encode(s);

describe('sniffing', () => {
  it('recognises images by their magic numbers, whatever the name says', () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImage(text('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(text('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    // A JPEG named .png is a JPEG.
    expect(sniffAttachment(bytes(0xff, 0xd8, 0xff, 0xdb), 'shot.png')).toEqual({
      ok: true,
      mime: 'image/jpeg',
      kind: 'image',
    });
  });

  it('PDFs and text files; the extension only refines the text mime type', () => {
    expect(sniffAttachment(text('%PDF-1.7\n...'), 'spec.bin')).toEqual({
      ok: true,
      mime: 'application/pdf',
      kind: 'file',
    });
    expect(sniffAttachment(text('# Title\n'), 'README.md')).toEqual({ ok: true, mime: 'text/markdown', kind: 'text' });
    expect(sniffAttachment(text('const a = 1;\n'), 'a.ts')).toMatchObject({ mime: 'text/typescript', kind: 'text' });
    expect(sniffAttachment(text('plain'), 'Makefile')).toMatchObject({ mime: 'text/plain', kind: 'text' });
    expect(sniffAttachment(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg')).toMatchObject({
      kind: 'text',
    });
    expect(sniffAttachment(new Uint8Array(0), 'empty.txt')).toMatchObject({ ok: true, kind: 'text' });
  });

  it('refuses binaries, including ones pretending to be images or PDFs', () => {
    const elf = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00);
    expect(sniffAttachment(elf, 'tool')).toMatchObject({ ok: false });
    expect(sniffAttachment(elf, 'cute.png')).toEqual({ ok: false, reason: "cute.png isn't a valid PNG image." });
    expect(sniffAttachment(elf, 'paper.pdf')).toEqual({ ok: false, reason: "paper.pdf isn't a valid PDF." });
    expect(sniffAttachment(bytes(0xc3, 0x28), 'bad.txt')).toMatchObject({ ok: false });
  });

  it('text detection tolerates a multi-byte character cut by the sample', () => {
    const euro = text('price: 5€');
    expect(looksLikeText(euro, euro.length - 1)).toBe(true);
    expect(looksLikeText(euro.subarray(0, euro.length - 1))).toBe(false);
  });
});

describe('limits', () => {
  it('images up to 10 MB, text and PDFs up to 2 MB', () => {
    expect(sizeProblem('a.png', 'image', ATTACHMENT_LIMITS.imageBytes)).toBeNull();
    expect(sizeProblem('a.png', 'image', ATTACHMENT_LIMITS.imageBytes + 1)).toBe(
      'a.png is 10 MB. Images can be up to 10 MB.',
    );
    expect(sizeProblem('a.txt', 'text', 3 * 1024 * 1024)).toBe('a.txt is 3.0 MB. Text files can be up to 2.0 MB.');
    expect(sizeProblem('a.pdf', 'file', 2 * 1024 * 1024 + 1)).toMatch(/PDFs can be up to 2.0 MB/);
  });

  it('precheck rejects what can never be accepted before reading it', () => {
    expect(precheck('movie.mov', 10)).toMatch(/Only images/);
    expect(precheck('x', 10, 'video/mp4')).toMatch(/Only images/);
    expect(precheck('big.png', 11 * 1024 * 1024)).toMatch(/Images can be up to 10 MB/);
    expect(precheck('huge.log', 11 * 1024 * 1024)).toMatch(/Text files can be up to/);
    expect(precheck('notes.md', 3 * 1024 * 1024)).toBeNull(); // decided by the engine once sniffed
    expect(precheck('shot.png', 1024)).toBeNull();
  });
});

describe('labels', () => {
  it('formats sizes, names and type labels', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    expect(cleanName('/Users/me/Desktop/shot.png')).toBe('shot.png');
    expect(cleanName('  ', 'Pasted image')).toBe('Pasted image');
    expect(cleanName('a\u0000b.txt')).toBe('ab.txt');
    expect(typeLabel({ name: 'x.jpeg', mime: 'image/jpeg', kind: 'image' })).toBe('JPG');
    expect(typeLabel({ name: 'spec.pdf', mime: 'application/pdf', kind: 'file' })).toBe('PDF');
    expect(typeLabel({ name: 'main.tsx', mime: 'text/typescript', kind: 'text' })).toBe('TSX');
    expect(pastedImageName('image/png', new Date(2026, 9, 7, 9, 5, 3))).toBe('Pasted image 2026-10-07 at 09.05.03.png');
  });
});
