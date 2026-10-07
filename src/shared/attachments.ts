/**
 * Attachments (screenshots, text/code files, PDFs) a human adds to a run, a clarify answer or a steer
 * message. Pure: shared by the engine (authoritative validation, storage) and the renderer (instant
 * feedback before uploading). The type is decided by the file's leading bytes, never by its name alone.
 */
import { z } from 'zod';
import { IdSchema } from './ids';

export const ATTACHMENT_LIMITS = {
  /** PNG / JPEG / GIF / WebP. */
  imageBytes: 10 * 1024 * 1024,
  /** Text, code and PDF files. */
  fileBytes: 2 * 1024 * 1024,
  /** Per run, clarify answer or message. */
  maxCount: 10,
  /** `attachments.get` returns at most this many characters of a text file. */
  previewChars: 200_000,
  /** Unclaimed (draft) attachments older than this are garbage-collected. */
  draftTtlMs: 24 * 60 * 60 * 1000,
} as const;

export const ATTACHMENT_KINDS = ['image', 'text', 'file'] as const;
export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentRefSchema = z.object({
  id: IdSchema,
  /** The file name as the user knows it (no directories). */
  name: z.string().min(1),
  /** Sniffed from the content. */
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: AttachmentKindSchema,
  sha256: z.string(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Extensions the native file dialog offers (anything else is still sniffed and may be accepted). */
export const ATTACHMENT_EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  file: [
    'pdf',
    'txt',
    'md',
    'markdown',
    'json',
    'jsonl',
    'yaml',
    'yml',
    'toml',
    'csv',
    'tsv',
    'log',
    'xml',
    'html',
    'css',
    'scss',
    'svg',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'ts',
    'tsx',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'swift',
    'c',
    'h',
    'cc',
    'cpp',
    'hpp',
    'cs',
    'php',
    'sh',
    'zsh',
    'bash',
    'sql',
    'graphql',
    'proto',
    'diff',
    'patch',
    'ini',
    'env',
  ],
} as const;

const TEXT_MIMES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/jsonl',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
};

export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? (match[1] as string).toLowerCase() : '';
}

/** The last path segment, trimmed; a fallback for nameless clipboard images. */
export function cleanName(name: string, fallback = 'attachment'): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from file names
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  return cleaned || fallback;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The image type of `bytes` by its magic number, or null. */
export function sniffImage(bytes: Uint8Array): (typeof IMAGE_MIMES)[number] | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

export const isPdf = (bytes: Uint8Array) => startsWith(bytes, ascii('%PDF-'));

/**
 * Text if it has no NUL bytes and decodes as UTF-8 (a multi-byte sequence cut off at the very end of a
 * sample is fine). An empty file counts as text.
 */
export function looksLikeText(bytes: Uint8Array, sample = bytes.length): boolean {
  const view = bytes.subarray(0, Math.min(sample, bytes.length));
  if (view.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(view, { stream: view.length < bytes.length });
    return true;
  } catch {
    return false;
  }
}

export type SniffResult = { ok: true; mime: string; kind: AttachmentKind } | { ok: false; reason: string };

export const UNSUPPORTED_REASON = 'Only images (PNG, JPEG, GIF, WebP), text or code files and PDFs can be attached.';

/** What `bytes` are, by content (the name only refines the mime type of text files). */
export function sniffAttachment(bytes: Uint8Array, name: string): SniffResult {
  const image = sniffImage(bytes);
  if (image) return { ok: true, mime: image, kind: 'image' };
  if (isPdf(bytes)) return { ok: true, mime: 'application/pdf', kind: 'file' };
  const ext = extensionOf(name);
  if (looksLikeText(bytes)) return { ok: true, mime: TEXT_MIMES[ext] ?? 'text/plain', kind: 'text' };
  if ((ATTACHMENT_EXTENSIONS.image as readonly string[]).includes(ext)) {
    return { ok: false, reason: `${name} isn't a valid ${ext.toUpperCase()} image.` };
  }
  if (ext === 'pdf') return { ok: false, reason: `${name} isn't a valid PDF.` };
  return { ok: false, reason: `${name}: ${UNSUPPORTED_REASON}` };
}

export function sizeLimit(kind: AttachmentKind): number {
  return kind === 'image' ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
}

/** null when `size` is within the limit for `kind`, else a sentence for the user. */
export function sizeProblem(name: string, kind: AttachmentKind, size: number): string | null {
  const limit = sizeLimit(kind);
  if (size <= limit) return null;
  const what = kind === 'image' ? 'Images' : kind === 'text' ? 'Text files' : 'PDFs';
  return `${name} is ${formatBytes(size)}. ${what} can be up to ${formatBytes(limit)}.`;
}

/**
 * A quick guess from the name and size alone (before reading the file): rejects what can never be
 * accepted (too big for any kind, an extension that is clearly binary). The engine sniffs the content.
 */
export function precheck(name: string, size: number, mime = ''): string | null {
  const ext = extensionOf(name);
  const image =
    (ATTACHMENT_EXTENSIONS.image as readonly string[]).includes(ext) || /^image\/(png|jpe?g|gif|webp)$/.test(mime);
  if (image) return sizeProblem(name, 'image', size);
  if (/^(video|audio)\//.test(mime) || BINARY_EXTENSIONS.has(ext)) return `${name}: ${UNSUPPORTED_REASON}`;
  if (size > ATTACHMENT_LIMITS.imageBytes) return sizeProblem(name, 'text', size);
  return null;
}

const BINARY_EXTENSIONS = new Set([
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'dmg',
  'pkg',
  'app',
  'exe',
  'dll',
  'so',
  'dylib',
  'o',
  'a',
  'class',
  'jar',
  'mov',
  'mp4',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'mp3',
  'wav',
  'aiff',
  'flac',
  'm4a',
  'heic',
  'heif',
  'tiff',
  'tif',
  'bmp',
  'ico',
  'icns',
  'psd',
  'sketch',
  'fig',
  'key',
  'pages',
  'numbers',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'sqlite',
  'db',
  'wasm',
]);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A short type label for chips: `PNG`, `PDF`, `TS`, `TEXT`. */
export function typeLabel(ref: Pick<AttachmentRef, 'name' | 'mime' | 'kind'>): string {
  if (ref.kind === 'image') return (ref.mime.split('/')[1] ?? 'image').replace('jpeg', 'jpg').toUpperCase();
  if (ref.mime === 'application/pdf') return 'PDF';
  return (extensionOf(ref.name) || 'text').toUpperCase().slice(0, 5);
}

/** Default name for an image pasted from the clipboard (screenshots have none). */
export function pastedImageName(mime: string, at: Date = new Date()): string {
  const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Pasted image ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}.${ext}`;
}
