import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENT_LIMITS } from '@shared/attachments';
import { RpcError } from '@shared/rpc-transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../context';
import { type OpenedStore, openStore } from '../db';
import { tempDir } from '../test/helpers';
import { AttachmentService } from './index';
import { sevenPng, textPdf } from './testing';

let dir: ReturnType<typeof tempDir>;
let opened: OpenedStore;
let now: number;
let service: AttachmentService;

beforeEach(() => {
  dir = tempDir('legion-attachments-');
  now = 1_800_000_000_000;
  opened = openStore(join(dir.path, 'legion.db'), { now: () => now });
  service = new AttachmentService({ dataDir: dir.path, store: opened.store, log: silentLogger, now: () => now });
});
afterEach(() => {
  opened.close();
  dir.cleanup();
});

const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64');
const files = () => readdirSync(service.dir).sort();

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

function createRun(): string {
  return opened.store.createRun({
    repoPath: '/repo',
    baseRef: 'main',
    title: 't',
    issueText: 'x',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
  }).id;
}

describe('AttachmentService.add', () => {
  it('stores pasted bytes content-addressed and sniffs the type', async () => {
    const png = sevenPng();
    const ref = await service.add({ name: 'Pasted image.png', mime: 'image/png', dataBase64: b64(png) });
    expect(ref).toMatchObject({ name: 'Pasted image.png', mime: 'image/png', kind: 'image', size: png.length });
    expect(ref.id).toMatch(/^file_/);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files()).toEqual([`${ref.sha256}.png`]);
    expect(opened.store.getAttachment(ref.id)).toMatchObject({ runId: null, createdAt: now });
  });

  it('reads local files by path; the same content is stored once', async () => {
    const path = join(dir.path, 'notes.md');
    writeFileSync(path, '# Notes\n\nUse the red button.\n');
    const a = await service.add({ name: 'notes.md', path });
    const b = await service.add({ name: 'copy.md', dataBase64: b64('# Notes\n\nUse the red button.\n') });
    expect(a).toMatchObject({ kind: 'text', mime: 'text/markdown' });
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).toBe(b.sha256);
    expect(files()).toEqual([`${a.sha256}.md`]);
  });

  it('accepts PDFs and judges a mislabelled image by its content', async () => {
    const pdf = await service.add({ name: 'spec.pdf', dataBase64: b64(textPdf('hello')) });
    expect(pdf).toMatchObject({ kind: 'file', mime: 'application/pdf' });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect(await service.add({ name: 'photo.png', dataBase64: b64(jpeg) })).toMatchObject({
      mime: 'image/jpeg',
      kind: 'image',
    });
  });

  it('refuses unsupported content, folders and files over the limits', async () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]);
    expect((await rejection(service.add({ name: 'cat.png', dataBase64: b64(elf) }))).message).toBe(
      "cat.png isn't a valid PNG image.",
    );
    expect((await rejection(service.add({ name: 'dir', path: dir.path }))).message).toMatch(/is a folder/);
    expect((await rejection(service.add({ name: 'gone.txt', path: join(dir.path, 'gone.txt') }))).code).toBe(
      'not_found',
    );
    const bigText = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1, 0x61);
    expect((await rejection(service.add({ name: 'big.log', dataBase64: b64(bigText) }))).message).toBe(
      'big.log is 2.0 MB. Text files can be up to 2.0 MB.',
    );
    const hugePath = join(dir.path, 'huge.txt');
    writeFileSync(hugePath, Buffer.alloc(ATTACHMENT_LIMITS.imageBytes + 10, 0x61));
    expect((await rejection(service.add({ name: 'huge.txt', path: hugePath }))).message).toMatch(
      /Text files can be up to 2.0 MB/,
    );
    expect((await rejection(service.add({ name: 'x' }))).code).toBe('bad_request');
    expect(files()).toEqual([]);
  });
});

describe('refs, claims and content', () => {
  it('resolves ids in order without duplicates and refuses unknown ids or too many', async () => {
    const a = await service.add({ name: 'a.txt', dataBase64: b64('a') });
    const b = await service.add({ name: 'b.txt', dataBase64: b64('b') });
    expect(service.refs([b.id, a.id, b.id]).map((r) => r.name)).toEqual(['b.txt', 'a.txt']);
    expect(service.refs(null)).toEqual([]);
    expect(() => service.refs(['file_nonexistent1'])).toThrow(/not found/);
    expect(() => service.refs(Array.from({ length: 11 }, (_, i) => `file_${String(i).padStart(12, '0')}`))).toThrow(
      /at most 10/,
    );
  });

  it('forSession hands adapters the stored path and skips files missing on disk', async () => {
    const a = await service.add({ name: 'a.txt', dataBase64: b64('hello') });
    expect(service.forSession([a])).toEqual([
      { name: 'a.txt', mime: 'text/plain', kind: 'text', path: join(service.dir, `${a.sha256}.txt`), size: 5 },
    ]);
    expect(service.forSession([{ ...a, sha256: '0'.repeat(64) }])).toEqual([]);
  });

  it('content returns images as base64 and text capped at the preview limit', async () => {
    const png = sevenPng();
    const image = await service.add({ name: 'seven.png', dataBase64: b64(png) });
    expect(await service.content(image.id)).toMatchObject({ dataBase64: b64(png), text: null, truncated: false });
    const long = 'x'.repeat(ATTACHMENT_LIMITS.previewChars + 5);
    const text = await service.add({ name: 'long.txt', dataBase64: b64(long) });
    const preview = await service.content(text.id);
    expect(preview.text?.length).toBe(ATTACHMENT_LIMITS.previewChars);
    expect(preview.truncated).toBe(true);
    const pdf = await service.add({ name: 'p.pdf', dataBase64: b64(textPdf('x')) });
    expect(await service.content(pdf.id)).toMatchObject({ dataBase64: null, text: null });
  });
});

describe('garbage collection', () => {
  it('drops drafts older than a day, keeps claimed ones and content still referenced', async () => {
    const runId = createRun();
    const claimed = await service.add({ name: 'claimed.txt', dataBase64: b64('claimed') });
    service.claim([claimed], runId);
    const stale = await service.add({ name: 'stale.txt', dataBase64: b64('stale') });
    const shared = await service.add({ name: 'shared-old.txt', dataBase64: b64('shared') });
    now += ATTACHMENT_LIMITS.draftTtlMs + 1;
    const fresh = await service.add({ name: 'shared-new.txt', dataBase64: b64('shared') });

    expect(await service.gc()).toEqual({ files: 1 });
    expect(opened.store.getAttachment(stale.id)).toBeNull();
    expect(opened.store.getAttachment(shared.id)).toBeNull();
    expect(opened.store.getAttachment(claimed.id)).toMatchObject({ runId });
    expect(opened.store.getAttachment(fresh.id)).not.toBeNull();
    expect(existsSync(service.pathOf(stale))).toBe(false);
    expect(existsSync(service.pathOf(shared))).toBe(true);
    expect(existsSync(service.pathOf(claimed))).toBe(true);
  });

  it('removes old files no row references (a crash between writing and recording)', async () => {
    const orphan = join(service.dir, `${'a'.repeat(64)}.png`);
    const recent = join(service.dir, `${'b'.repeat(64)}.png`);
    writeFileSync(orphan, 'x');
    writeFileSync(recent, 'x');
    const old = (now - ATTACHMENT_LIMITS.draftTtlMs - 1000) / 1000;
    utimesSync(orphan, old, old);
    const later = now / 1000;
    utimesSync(recent, later, later);
    expect(await service.gc()).toEqual({ files: 1 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});
