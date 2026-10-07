import { customAlphabet } from 'nanoid';
import { z } from 'zod';

/**
 * Entity ids are `<prefix>_<12 lowercase alphanumerics>`, e.g. `run_k3x9a0q2m7bz`.
 * They are plain strings at the type level (no branding) to keep zod/JSON round trips simple;
 * the prefix makes them self-describing in logs and in the event log.
 */
export const ID_PREFIXES = {
  run: 'run',
  plan: 'plan',
  task: 'task',
  attempt: 'att',
  review: 'rev',
  inbox: 'inb',
  terminal: 'term',
  merge: 'mrg',
  verification: 'ver',
  attachment: 'file',
  project: 'prj',
  message: 'msg',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ID_BODY_LENGTH = 12;
const randomBody = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', ID_BODY_LENGTH);

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomBody()}`;
}

export function isId(kind: IdKind, value: string): boolean {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-z]{${ID_BODY_LENGTH}}$`).test(value);
}

/** Short, branch-safe form of a run id used in git refs: `legion/<runShort>/...`. */
export function runShort(runId: string): string {
  const body = runId.slice(runId.indexOf('_') + 1);
  return body.slice(0, 8);
}

/** Lowercase, dash-separated, ascii-only slug for branch names. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'task';
}

export const IdSchema = z.string().min(1);
/** Plan node ids: `T1`, `T2`, ... */
export const NodeIdSchema = z.string().regex(/^T[0-9]+$/, 'node ids look like T1, T2, ...');
