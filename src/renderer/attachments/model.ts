/**
 * Draft attachments of one input (the composer, a steer bar, the clarify form): files being read or uploaded
 * and the uploaded refs, with instant validation (name, size, sniffed bytes) before anything is sent. The
 * engine validates again (`attachments.add`). An `AttachmentDraft` is an external store, so a draft can
 * outlive its component (the composer keeps its attachments while closed).
 */
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentRef,
  cleanName,
  pastedImageName,
  precheck,
  sizeProblem,
  sniffAttachment,
} from '@shared/attachments';

export interface DraftItem {
  /** Local key (stable across the upload). */
  key: string;
  name: string;
  /** null until known (a picked path before the upload). */
  size: number | null;
  /** Guessed until uploaded, then the sniffed kind. */
  kind: AttachmentKind | null;
  status: 'uploading' | 'ready';
  ref: AttachmentRef | null;
  /** Object URL of an image thumbnail (owned by the draft until `take()`). */
  url: string | null;
}

export interface DraftSnapshot {
  readonly items: readonly DraftItem[];
  /** Why the last files were not attached (one line each). */
  readonly errors: readonly string[];
}

export type UploadInput = { name: string; mime: string | null; dataBase64: string } | { name: string; path: string };

export interface DraftDeps {
  upload(input: UploadInput): Promise<AttachmentRef>;
  /** An object URL for an uploaded image (picked by path: no local bytes). */
  thumbnail(ref: AttachmentRef): Promise<string | null>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

/**
 * What a drag from Finder carries, judged while it hovers: only types are known then, and folders (like some
 * text files) have none. `files` = everything typed (attach); `either` = could be a folder.
 */
export type DragIntent = 'files' | 'either';

export function dragIntent(items: readonly { kind: string; type: string }[]): DragIntent {
  const files = items.filter((i) => i.kind === 'file');
  return files.length > 0 && files.every((i) => i.type !== '') ? 'files' : 'either';
}

/** Read a Blob as base64 (no data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBlob(data: string, mime: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const GENERIC_PASTE_NAMES = /^(image|blob|untitled)(\.\w+)?$/i;

/** A pasted screenshot is called `image.png`: give it a dated name like macOS does. */
export function nameForFile(file: { name: string; type: string }, now: Date = new Date()): string {
  if (!file.name || (GENERIC_PASTE_NAMES.test(file.name) && file.type.startsWith('image/'))) {
    return pastedImageName(file.type || 'image/png', now);
  }
  return cleanName(file.name);
}

const errorText = (error: unknown) =>
  (error as { message?: string } | null)?.message?.replace(/^\w+: /, '') ?? String(error);

let counter = 0;

export class AttachmentDraft {
  private state: DraftSnapshot = { items: [], errors: [] };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: DraftDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): DraftSnapshot => this.state;

  get items(): readonly DraftItem[] {
    return this.state.items;
  }

  /** Uploaded attachment ids, in order. */
  get ids(): string[] {
    return this.state.items.flatMap((i) => (i.ref ? [i.ref.id] : []));
  }

  get uploading(): boolean {
    return this.state.items.some((i) => i.status === 'uploading');
  }

  private set(patch: Partial<DraftSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private update(key: string, patch: Partial<DraftItem>): void {
    if (!this.state.items.some((i) => i.key === key)) return;
    this.set({ items: this.state.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
  }

  private reject(messages: string[]): void {
    if (messages.length) this.set({ errors: messages });
  }

  dismissErrors(): void {
    if (this.state.errors.length) this.set({ errors: [] });
  }

  /** Room left under the count limit; `names` beyond it are reported and dropped. */
  private admit<T extends { name: string }>(incoming: T[]): { accepted: T[]; errors: string[] } {
    const room = Math.max(0, ATTACHMENT_LIMITS.maxCount - this.state.items.length);
    if (incoming.length <= room) return { accepted: incoming, errors: [] };
    const left = incoming.slice(room).map((f) => f.name);
    return {
      accepted: incoming.slice(0, room),
      errors: [`You can attach up to ${ATTACHMENT_LIMITS.maxCount} files. Left out: ${left.join(', ')}.`],
    };
  }

  /** Files from a paste, a drop or an `<input type=file>`. */
  async addFiles(files: readonly File[]): Promise<void> {
    const now = new Date();
    const named = files.map((file) => ({ file, name: nameForFile(file, now) }));
    const { accepted, errors } = this.admit(named);
    const checked: { file: File; name: string }[] = [];
    for (const entry of accepted) {
      const problem = precheck(entry.name, entry.file.size, entry.file.type);
      if (problem) errors.push(problem);
      else checked.push(entry);
    }
    // Sniff the first bytes here for an instant answer; the engine checks again.
    const sniffed = await Promise.all(
      checked.map(async ({ file, name }) => {
        const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        const result = sniffAttachment(head, name);
        if (!result.ok) return { file, name, error: result.reason, kind: null };
        // A cut-off sample can look like text; only the engine sees the whole file.
        const tooBig = sizeProblem(name, result.kind, file.size);
        return { file, name, error: tooBig, kind: result.kind };
      }),
    );
    const items: { item: DraftItem; file: File }[] = [];
    for (const entry of sniffed) {
      if (entry.error) {
        errors.push(entry.error);
        continue;
      }
      const url = entry.kind === 'image' ? this.deps.createUrl(entry.file) : null;
      items.push({
        file: entry.file,
        item: {
          key: `att-${++counter}`,
          name: entry.name,
          size: entry.file.size,
          kind: entry.kind,
          status: 'uploading',
          ref: null,
          url,
        },
      });
    }
    this.set({ items: [...this.state.items, ...items.map((i) => i.item)], errors });
    await Promise.all(
      items.map(async ({ item, file }) => {
        try {
          const dataBase64 = await blobToBase64(file);
          await this.finish(item, await this.deps.upload({ name: item.name, mime: file.type || null, dataBase64 }));
        } catch (error) {
          this.fail(item, error);
        }
      }),
    );
  }

  /** Paths from the native file dialog. */
  async addPaths(paths: readonly string[]): Promise<void> {
    const named = paths.map((path) => ({ path, name: cleanName(path) }));
    const { accepted, errors } = this.admit(named);
    const items: { item: DraftItem; path: string }[] = accepted.map(({ path, name }) => ({
      path,
      item: { key: `att-${++counter}`, name, size: null, kind: null, status: 'uploading', ref: null, url: null },
    }));
    this.set({ items: [...this.state.items, ...items.map((i) => i.item)], errors });
    await Promise.all(
      items.map(async ({ item, path }) => {
        try {
          await this.finish(item, await this.deps.upload({ name: item.name, path }));
        } catch (error) {
          this.fail(item, error);
        }
      }),
    );
  }

  private async finish(item: DraftItem, ref: AttachmentRef): Promise<void> {
    let url = this.state.items.find((i) => i.key === item.key)?.url ?? null;
    if (!this.state.items.some((i) => i.key === item.key)) {
      // Removed while uploading: the draft row on the engine expires on its own.
      if (url) this.deps.revokeUrl(url);
      return;
    }
    if (ref.kind !== 'image' && url) {
      this.deps.revokeUrl(url);
      url = null;
    }
    this.update(item.key, { status: 'ready', ref, size: ref.size, kind: ref.kind, name: ref.name, url });
    if (ref.kind === 'image' && !url) {
      const thumb = await this.deps.thumbnail(ref).catch(() => null);
      if (!thumb) return;
      if (this.state.items.some((i) => i.key === item.key)) this.update(item.key, { url: thumb });
      else this.deps.revokeUrl(thumb);
    }
  }

  private fail(item: DraftItem, error: unknown): void {
    const current = this.state.items.find((i) => i.key === item.key);
    if (current?.url) this.deps.revokeUrl(current.url);
    this.set({
      items: this.state.items.filter((i) => i.key !== item.key),
      errors: [...this.state.errors, `${item.name}: ${errorText(error)}`],
    });
  }

  remove(key: string): void {
    const item = this.state.items.find((i) => i.key === key);
    if (!item) return;
    if (item.url) this.deps.revokeUrl(item.url);
    this.set({ items: this.state.items.filter((i) => i.key !== key) });
  }

  /** Hand the ready items over (e.g. to a sent message, which keeps the thumbnails) and empty the draft. */
  take(): DraftItem[] {
    const items = this.state.items.filter((i) => i.status === 'ready');
    for (const item of this.state.items) if (item.status !== 'ready' && item.url) this.deps.revokeUrl(item.url);
    this.set({ items: [], errors: [] });
    return items;
  }

  /** Empty the draft and release its thumbnails. */
  clear(): void {
    for (const item of this.state.items) if (item.url) this.deps.revokeUrl(item.url);
    this.set({ items: [], errors: [] });
  }

  report(message: string): void {
    this.reject([message]);
  }
}
