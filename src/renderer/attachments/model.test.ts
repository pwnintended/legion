import { ATTACHMENT_LIMITS, type AttachmentRef } from '@shared/attachments';
import { describe, expect, it } from 'vitest';
import { AttachmentDraft, blobToBase64, type DraftDeps, dragIntent, nameForFile, type UploadInput } from './model';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function deps(overrides: Partial<DraftDeps> = {}) {
  const uploads: UploadInput[] = [];
  const revoked: string[] = [];
  let n = 0;
  const d: DraftDeps = {
    upload: async (input) => {
      uploads.push(input);
      const name = input.name;
      const image = /\.(png|jpg)$/.test(name);
      return {
        id: `file_${String(++n).padStart(12, '0')}`,
        name,
        mime: image ? 'image/png' : 'text/plain',
        kind: image ? 'image' : 'text',
        size: 'dataBase64' in input ? atob(input.dataBase64).length : 99,
        sha256: 'x',
      } satisfies AttachmentRef;
    },
    thumbnail: async (ref) => `blob:thumb-${ref.id}`,
    createUrl: () => `blob:local-${++n}`,
    revokeUrl: (url) => revoked.push(url),
    ...overrides,
  };
  return { d, uploads, revoked };
}

describe('AttachmentDraft', () => {
  it('uploads pasted bytes with a dated name and keeps a local thumbnail for images', async () => {
    const { d, uploads } = deps();
    const draft = new AttachmentDraft(d);
    const seen: number[] = [];
    draft.subscribe(() => seen.push(draft.items.length));
    await draft.addFiles([new File([PNG], 'image.png', { type: 'image/png' })]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ name: expect.stringMatching(/^Pasted image \d{4}-\d\d-\d\d at .+\.png$/) });
    expect(draft.items[0]).toMatchObject({ status: 'ready', kind: 'image', url: 'blob:local-1' });
    expect(draft.ids).toEqual(['file_000000000002']);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('rejects unsupported or oversized files before uploading, with one line each', async () => {
    const { d, uploads } = deps();
    const draft = new AttachmentDraft(d);
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]);
    const big = new File([new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1).fill(0x61)], 'big.txt', {
      type: 'text/plain',
    });
    await draft.addFiles([
      new File([elf], 'tool'),
      new File(['x'], 'clip.mov', { type: 'video/quicktime' }),
      big,
      new File(['hello'], 'ok.txt', { type: 'text/plain' }),
    ]);
    expect(uploads.map((u) => u.name)).toEqual(['ok.txt']);
    expect(draft.get().errors).toEqual([
      'clip.mov: Only images (PNG, JPEG, GIF, WebP), text or code files and PDFs can be attached.',
      'tool: Only images (PNG, JPEG, GIF, WebP), text or code files and PDFs can be attached.',
      'big.txt is 2.0 MB. Text files can be up to 2.0 MB.',
    ]);
    draft.dismissErrors();
    expect(draft.get().errors).toEqual([]);
  });

  it('caps the count at 10 and names what was left out', async () => {
    const { d } = deps();
    const draft = new AttachmentDraft(d);
    await draft.addFiles(Array.from({ length: 9 }, (_, i) => new File([`f${i}`], `f${i}.txt`, { type: 'text/plain' })));
    await draft.addFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt'), new File(['c'], 'c.txt')]);
    expect(draft.items).toHaveLength(10);
    expect(draft.get().errors).toEqual(['You can attach up to 10 files. Left out: b.txt, c.txt.']);
  });

  it('picked paths upload by path and fetch a thumbnail for images', async () => {
    const { d, uploads } = deps();
    const draft = new AttachmentDraft(d);
    await draft.addPaths(['/Users/me/Desktop/mock.png', '/Users/me/notes.txt']);
    expect(uploads).toEqual([
      { name: 'mock.png', path: '/Users/me/Desktop/mock.png' },
      { name: 'notes.txt', path: '/Users/me/notes.txt' },
    ]);
    expect(draft.items.map((i) => [i.name, i.size, i.url])).toEqual([
      ['mock.png', 99, 'blob:thumb-file_000000000001'],
      ['notes.txt', 99, null],
    ]);
  });

  it('a failed upload leaves the tray with the engine reason', async () => {
    const { d, revoked } = deps({
      upload: async () => {
        throw Object.assign(new Error("bad_request: cat.png isn't a valid PNG image."), { code: 'bad_request' });
      },
    });
    const draft = new AttachmentDraft(d);
    await draft.addFiles([new File([PNG], 'cat.png', { type: 'image/png' })]);
    expect(draft.items).toEqual([]);
    expect(draft.get().errors).toEqual(["cat.png: cat.png isn't a valid PNG image."]);
    expect(revoked).toHaveLength(1);
  });

  it('remove releases the thumbnail; take hands ready items over and empties the draft', async () => {
    const { d, revoked } = deps();
    const draft = new AttachmentDraft(d);
    await draft.addFiles([
      new File([PNG], 'a.png', { type: 'image/png' }),
      new File([PNG], 'b.png', { type: 'image/png' }),
    ]);
    draft.remove(draft.items[0]?.key as string);
    expect(revoked).toEqual(['blob:local-1']);
    const taken = draft.take();
    expect(taken.map((i) => i.name)).toEqual(['b.png']);
    expect(draft.items).toEqual([]);
    expect(revoked).toEqual(['blob:local-1']);
  });
});

describe('helpers', () => {
  it('names, drag intent and base64', async () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(nameForFile({ name: 'image.png', type: 'image/png' }, at)).toBe('Pasted image 2026-01-02 at 03.04.05.png');
    expect(nameForFile({ name: 'design v2.png', type: 'image/png' }, at)).toBe('design v2.png');
    expect(dragIntent([{ kind: 'file', type: 'image/png' }])).toBe('files');
    expect(dragIntent([{ kind: 'file', type: '' }])).toBe('either');
    expect(dragIntent([])).toBe('either');
    expect(await blobToBase64(new Blob(['hello']))).toBe(btoa('hello'));
  });
});
