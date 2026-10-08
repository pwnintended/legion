/**
 * Attachment storage: content-addressed files under `<dataDir>/attachments/<sha256>.<ext>` plus one
 * `attachments` row per add (`Store`). The type is sniffed from the bytes (`shared/attachments.ts`); a run,
 * clarify answer or steer message claims the rows it uses, and unclaimed drafts older than a day are
 * garbage-collected together with files no row references.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  type AttachmentRef,
  cleanName,
  extensionOf,
  sizeLimit,
  sizeProblem,
  sniffAttachment,
} from '@shared/attachments';
import type { SessionAttachment } from '@shared/engine';
import { newId } from '@shared/ids';
import type { AttachmentContent } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import type { Logger } from '../context';
import type { AttachmentRow, Store } from '../db/store';
import type { EngineRpcServer } from '../rpc/server';

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** The on-disk extension: the image/PDF type's, else the (sanitized) name's, else `txt`. */
function storedExtension(mime: string, name: string): string {
  const known = EXTENSIONS[mime];
  if (known) return known;
  const ext = extensionOf(name);
  return ext && ext.length <= 10 ? ext : 'txt';
}

export interface AddAttachmentInput {
  name: string;
  mime?: string | null;
  /** Exactly one of `dataBase64` and `path`. */
  dataBase64?: string | null;
  path?: string | null;
}

export interface AttachmentServiceOptions {
  dataDir: string;
  store: Store;
  log: Logger;
  now?: () => number;
}

export class AttachmentService {
  readonly dir: string;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(options: AttachmentServiceOptions) {
    this.dir = join(options.dataDir, 'attachments');
    this.store = options.store;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Validate, store (deduplicated by content) and record a draft attachment. */
  async add(input: AddAttachmentInput): Promise<AttachmentRef> {
    const name = cleanName(input.name, input.path ? 'attachment' : 'Pasted file');
    let bytes: Buffer;
    if (input.dataBase64 != null && input.path == null) bytes = decodeBase64(input.dataBase64);
    else if (input.path != null && input.dataBase64 == null) bytes = await readLocalFile(input.path, name);
    else throw new RpcError('bad_request', 'pass exactly one of dataBase64 and path');
    const sniffed = sniffAttachment(bytes, name);
    if (!sniffed.ok) throw new RpcError('bad_request', sniffed.reason);
    const tooBig = sizeProblem(name, sniffed.kind, bytes.length);
    if (tooBig) throw new RpcError('bad_request', tooBig);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref: AttachmentRef = {
      id: newId('attachment'),
      name,
      mime: sniffed.mime,
      size: bytes.length,
      kind: sniffed.kind,
      sha256,
    };
    const path = this.pathOf(ref);
    if (!(await exists(path))) {
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, path);
    }
    const row = this.store.insertAttachment(ref);
    return toRef(row);
  }

  require(id: string): AttachmentRow {
    const row = this.store.getAttachment(id);
    if (!row) throw new RpcError('not_found', `attachment ${id} not found (drafts expire after a day)`);
    return row;
  }

  /** Refs for `ids` (all must exist), in order, without duplicates. */
  refs(ids: readonly string[] | null | undefined): AttachmentRef[] {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > ATTACHMENT_LIMITS.maxCount) {
      throw new RpcError('bad_request', `at most ${ATTACHMENT_LIMITS.maxCount} attachments`);
    }
    return unique.map((id) => toRef(this.require(id)));
  }

  /** Mark attachments as used by `runId` (they are no longer drafts). */
  claim(refs: readonly AttachmentRef[], runId: string): void {
    if (refs.length)
      this.store.claimAttachments(
        refs.map((r) => r.id),
        runId,
      );
  }

  pathOf(ref: Pick<AttachmentRef, 'sha256' | 'mime' | 'name'>): string {
    return join(this.dir, `${ref.sha256}.${storedExtension(ref.mime, ref.name)}`);
  }

  /** What adapters need to send `refs` to an agent; files missing on disk are left out (with a warning). */
  forSession(refs: readonly AttachmentRef[] | null | undefined): SessionAttachment[] {
    const out: SessionAttachment[] = [];
    for (const ref of refs ?? []) {
      const path = this.pathOf(ref);
      try {
        statSync(path);
      } catch {
        this.log.warn(`attachment ${ref.id} (${ref.name}) is missing on disk: ${path}`);
        continue;
      }
      out.push({ name: ref.name, mime: ref.mime, kind: ref.kind, path, size: ref.size });
    }
    return out;
  }

  /** Content for previews: images as base64, text capped at `previewChars`, nothing for PDFs. */
  async content(id: string): Promise<AttachmentContent> {
    const row = this.require(id);
    const attachment = toRef(row);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathOf(row));
    } catch {
      throw new RpcError('not_found', `attachment ${id} is missing on disk`);
    }
    if (row.kind === 'image') return { attachment, dataBase64: bytes.toString('base64'), text: null, truncated: false };
    if (row.kind === 'text') {
      const text = bytes.toString('utf8');
      const truncated = text.length > ATTACHMENT_LIMITS.previewChars;
      return {
        attachment,
        dataBase64: null,
        text: truncated ? text.slice(0, ATTACHMENT_LIMITS.previewChars) : text,
        truncated,
      };
    }
    return { attachment, dataBase64: null, text: null, truncated: false };
  }

  /**
   * Drop drafts older than `draftTtlMs` and every file no row references (also files left behind by a
   * crash between writing and recording, once they are as old as a draft could be).
   */
  async gc(): Promise<{ files: number }> {
    const before = this.now() - ATTACHMENT_LIMITS.draftTtlMs;
    const orphaned = new Set(this.store.deleteDraftAttachments(before));
    let files = 0;
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return { files };
    }
    for (const entry of entries) {
      const sha = /^([0-9a-f]{64})\.\w+$/.exec(entry)?.[1] ?? null;
      if (sha && this.store.attachmentShaInUse(sha)) continue;
      const path = join(this.dir, entry);
      if (!(sha && orphaned.has(sha))) {
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || info.mtimeMs >= before) continue;
      }
      await rm(path, { force: true }).then(
        () => files++,
        (error: unknown) => this.log.warn(`attachments gc: could not remove ${entry}: ${(error as Error).message}`),
      );
    }
    return { files };
  }
}

function toRef(row: AttachmentRow): AttachmentRef {
  return { id: row.id, name: row.name, mime: row.mime, size: row.size, kind: row.kind, sha256: row.sha256 };
}

function decodeBase64(data: string): Buffer {
  const clean = data.replace(/^data:[^;,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]*$/.test(clean)) throw new RpcError('bad_request', 'dataBase64 is not base64');
  // The largest accepted file, base64-encoded, plus slack: refuse before decoding something huge.
  if (clean.length > Math.ceil((ATTACHMENT_LIMITS.imageBytes * 4) / 3) + 1024) {
    throw new RpcError('bad_request', `Attachments can be up to ${ATTACHMENT_LIMITS.imageBytes / 1024 / 1024} MB.`);
  }
  return Buffer.from(clean, 'base64');
}

async function readLocalFile(path: string, name: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new RpcError('bad_request', 'path must be absolute');
  const info = await stat(path).catch(() => null);
  if (!info) throw new RpcError('not_found', `${name} doesn't exist any more`);
  if (info.isDirectory()) throw new RpcError('bad_request', `${name} is a folder. Attach files, not folders.`);
  if (!info.isFile()) throw new RpcError('bad_request', `${name} is not a regular file`);
  // Before reading: the largest limit applies to any kind (the precise one is checked after sniffing).
  if (info.size > sizeLimit('image')) {
    const head = await readHead(path);
    const sniffed = sniffAttachment(head, name);
    const problem = sizeProblem(name, sniffed.ok ? sniffed.kind : 'file', info.size);
    throw new RpcError('bad_request', problem ?? `${name} is too large`);
  }
  return readFile(path);
}

async function readHead(path: string, length = 4096): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** How often drafts are garbage-collected while the engine runs (also once at start). */
export const ATTACHMENT_GC_INTERVAL_MS = 60 * 60 * 1000;

/** `attachments.add` / `attachments.get`, plus the periodic GC. Returns a disposer. */
export function registerAttachmentHandlers(
  server: EngineRpcServer,
  service: AttachmentService,
  log: Logger,
): () => void {
  server.implement('attachments.add', (input) => service.add(input));
  server.implement('attachments.get', ({ id }) => service.content(id));
  const gc = () =>
    void service.gc().catch((error: unknown) => log.warn(`attachments gc failed: ${(error as Error).message}`));
  gc();
  const timer = setInterval(gc, ATTACHMENT_GC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
