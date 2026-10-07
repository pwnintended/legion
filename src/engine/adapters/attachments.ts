/**
 * Attachment handling shared by the adapters: the text part of a message with attachments. Each adapter
 * sends what its engine takes natively (Claude: images and PDFs as content blocks; Codex: images as
 * `localImage`) and lets this module inline text files and reference everything else by path.
 */
import { readFileSync } from 'node:fs';
import { formatBytes } from '@shared/attachments';
import type { SessionAttachment } from '@shared/engine';

export type ReadFile = (path: string) => Buffer;
const readDisk: ReadFile = (path) => readFileSync(path);

/** Characters of one text file inlined into a message; longer files are cut and referenced by path. */
export const INLINE_TEXT_CHARS = 100_000;

function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}

const quoted = (name: string) => `\`${name.replace(/`/g, "'")}\``;

function langOf(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'text';
}

/** A text file as a fenced block headed by its name (cut at `INLINE_TEXT_CHARS`, then referenced by path). */
export function inlineTextAttachment(attachment: SessionAttachment, read: ReadFile = readDisk): string {
  let text: string;
  try {
    text = read(attachment.path).toString('utf8');
  } catch (error) {
    return `Attached file ${quoted(attachment.name)} could not be read: ${(error as Error).message}`;
  }
  const cut = text.length > INLINE_TEXT_CHARS;
  const head = `Attached file ${quoted(attachment.name)} (${formatBytes(attachment.size)}${cut ? `, first ${INLINE_TEXT_CHARS.toLocaleString('en-US')} characters; the full file is at ${attachment.path}` : ''}):`;
  return `${head}\n${fenced(cut ? text.slice(0, INLINE_TEXT_CHARS) : text, langOf(attachment.name))}`;
}

/** A file the engine can't take natively and that isn't text: named, with its path. */
export function referencedAttachment(attachment: SessionAttachment): string {
  return `Attached file ${quoted(attachment.name)} (${attachment.mime}, ${formatBytes(attachment.size)}) is at ${attachment.path}.`;
}

/**
 * The message text followed by the attachments `native` does not cover: text files inlined, the rest
 * referenced by path. Natively sent files are named too, so the agent can refer to them.
 */
export function messageText(
  text: string,
  attachments: readonly SessionAttachment[] | null | undefined,
  native: (attachment: SessionAttachment) => boolean,
  read: ReadFile = readDisk,
): string {
  if (!attachments?.length) return text;
  const sent = attachments.filter(native);
  const parts = [text.replace(/\s+$/, '')];
  if (sent.length) {
    parts.push(
      `Attached ${sent.length === 1 ? 'file' : 'files'} (included with this message): ${sent.map((a) => quoted(a.name)).join(', ')}.`,
    );
  }
  for (const attachment of attachments) {
    if (native(attachment)) continue;
    parts.push(attachment.kind === 'text' ? inlineTextAttachment(attachment, read) : referencedAttachment(attachment));
  }
  return parts.filter(Boolean).join('\n\n');
}

export function readBase64(attachment: SessionAttachment, read: ReadFile = readDisk): string {
  return read(attachment.path).toString('base64');
}
