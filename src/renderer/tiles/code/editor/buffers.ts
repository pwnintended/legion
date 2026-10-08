/**
 * Open files being edited, one buffer per viewer tab: the editor state (text, selection, undo history) outlives
 * the editor on screen, so switching tabs or workspaces never loses an edit. Each buffer remembers the file
 * version its text came from: saving refuses when the file moved on since (`files.write` → conflict), and a file
 * that changes on disk reloads on its own when the buffer has no edits, or says so when it has.
 */
import type { EditorState } from '@codemirror/state';
import type { FileStat } from '@shared/rpc';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { confirmAction } from '../../../app/confirm';
import { rpc } from '../../../app/hooks';
import { invalidateQueries } from '../../../app/query';
import { toast } from '../../../overlays/nav';
import { fileKey } from '../../project/kit';

export interface BufferMeta {
  projectId: string;
  checkout: string | null;
  path: string;
  /** The file version the buffer's saved text came from. */
  version: string;
  /** The text last read from or written to disk. */
  saved: string;
  dirty: boolean;
  saving: boolean;
  /** The file changed on disk under unsaved edits (or a save was refused for it). */
  conflict: boolean;
}

interface BufferStore {
  buffers: Record<string, BufferMeta>;
}

export const bufferStore = createStore<BufferStore>(() => ({ buffers: {} }));

/** Editor states by tab id (outside the store: they are large and change on every keystroke). */
const states = new Map<string, EditorState>();
/** The live editor's text accessor and doc replacer, while a tab's editor is mounted. */
const live = new Map<string, { text: () => string; replace: (text: string) => void }>();

export function bufferOf(tabId: string): BufferMeta | null {
  return bufferStore.getState().buffers[tabId] ?? null;
}

export function useBuffer<T>(tabId: string, select: (meta: BufferMeta | null) => T): T {
  return useStore(bufferStore, (s) => select(s.buffers[tabId] ?? null));
}

export function useDirtyTabs(tabIds: readonly string[]): string {
  return useStore(bufferStore, (s) => tabIds.filter((id) => s.buffers[id]?.dirty).join(' '));
}

function patch(tabId: string, change: Partial<BufferMeta>): void {
  const current = bufferStore.getState().buffers[tabId];
  if (!current) return;
  bufferStore.setState((s) => ({ buffers: { ...s.buffers, [tabId]: { ...current, ...change } } }));
}

/** Start (or find) the buffer of a tab, from text read at `version`. */
export function openBuffer(
  tabId: string,
  file: { projectId: string; checkout: string | null; path: string; version: string; text: string },
): BufferMeta {
  const existing = bufferOf(tabId);
  if (existing && existing.path === file.path && existing.checkout === file.checkout) return existing;
  const meta: BufferMeta = { ...file, saved: file.text, dirty: false, saving: false, conflict: false };
  bufferStore.setState((s) => ({ buffers: { ...s.buffers, [tabId]: meta } }));
  states.delete(tabId);
  return meta;
}

export function savedState(tabId: string): EditorState | null {
  return states.get(tabId) ?? null;
}

export function keepState(tabId: string, state: EditorState): void {
  states.set(tabId, state);
}

export function attach(tabId: string, editor: { text: () => string; replace: (text: string) => void }): () => void {
  live.set(tabId, editor);
  return () => {
    if (live.get(tabId) === editor) live.delete(tabId);
  };
}

/** The editor's text changed: is it different from what is on disk? */
export function noteEdit(tabId: string, text: string): void {
  const meta = bufferOf(tabId);
  if (!meta) return;
  const dirty = text !== meta.saved;
  if (dirty !== meta.dirty) patch(tabId, { dirty });
}

function currentText(tabId: string): string | null {
  return live.get(tabId)?.text() ?? states.get(tabId)?.doc.toString() ?? null;
}

/** Save the buffer (⌘S). Refused, with the conflict shown, when the file changed on disk since it was read. */
export async function saveBuffer(tabId: string, options: { overwrite?: boolean } = {}): Promise<boolean> {
  const meta = bufferOf(tabId);
  const text = currentText(tabId);
  if (!meta || text === null || meta.saving) return false;
  let expected = meta.version;
  if (options.overwrite) {
    const stat = await rpc('files.stat', { projectId: meta.projectId, checkout: meta.checkout, path: meta.path });
    if (stat.version) expected = stat.version;
  }
  patch(tabId, { saving: true });
  try {
    const result = await rpc('files.write', {
      projectId: meta.projectId,
      checkout: meta.checkout,
      path: meta.path,
      text,
      expectedVersion: expected,
    });
    patch(tabId, {
      saving: false,
      version: result.version ?? expected,
      saved: text,
      dirty: currentText(tabId) !== text,
      conflict: false,
    });
    invalidateQueries(fileKey(meta.projectId, meta.path, meta.checkout));
    return true;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    patch(tabId, { saving: false, conflict: code === 'conflict' ? true : meta.conflict });
    if (code !== 'conflict')
      toast(`Couldn't save ${meta.path}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return false;
  }
}

/** Throw the edits away and show what is on disk now. */
export async function reloadBuffer(tabId: string): Promise<void> {
  const meta = bufferOf(tabId);
  if (!meta) return;
  const file = await rpc('files.read', { projectId: meta.projectId, checkout: meta.checkout, path: meta.path });
  if (file.kind !== 'text' || file.text === null) return;
  const text = file.text;
  patch(tabId, { version: file.version ?? meta.version, saved: text, dirty: false, conflict: false });
  const editor = live.get(tabId);
  if (editor) editor.replace(text);
  else states.delete(tabId);
  invalidateQueries(fileKey(meta.projectId, meta.path, meta.checkout));
}

/** Keep the edits over what changed on disk: the next save overwrites it. */
export function keepMine(tabId: string): void {
  patch(tabId, { conflict: false });
  void saveBuffer(tabId, { overwrite: true });
}

/**
 * Look at the file on disk (the editor on screen does this every couple of seconds): a new version reloads a
 * buffer without edits and marks one with edits as in conflict.
 */
export async function checkDisk(tabId: string): Promise<void> {
  const meta = bufferOf(tabId);
  if (!meta || meta.saving) return;
  let stat: FileStat;
  try {
    stat = await rpc('files.stat', { projectId: meta.projectId, checkout: meta.checkout, path: meta.path });
  } catch {
    return;
  }
  const now = bufferOf(tabId);
  if (!now || now.saving || stat.version === null || stat.version === now.version) return;
  if (now.dirty) {
    if (!now.conflict) patch(tabId, { conflict: true });
    return;
  }
  await reloadBuffer(tabId);
}

/** Forget buffers (their tabs closed). */
export function dropBuffers(tabIds: readonly string[]): void {
  const gone = tabIds.filter((id) => bufferStore.getState().buffers[id]);
  for (const id of tabIds) states.delete(id);
  if (!gone.length) return;
  bufferStore.setState((s) => {
    const buffers = { ...s.buffers };
    for (const id of gone) delete buffers[id];
    return { buffers };
  });
}

/**
 * Before tabs close: when any has unsaved edits, ask whether to throw them away (keeping them is the safe answer:
 * Esc keeps editing). Resolves true when the tabs may close; their buffers are dropped then.
 */
export async function confirmClose(tabIds: readonly string[]): Promise<boolean> {
  const dirty = tabIds.map((id) => bufferOf(id)).filter((m): m is BufferMeta => !!m?.dirty);
  if (dirty.length > 0) {
    const names = dirty.map((m) => m.path);
    const discard = await confirmAction({
      title: dirty.length === 1 ? `Discard your changes to ${names[0]}?` : `Discard changes to ${dirty.length} files?`,
      body: ['They are not saved (⌘S saves). Closing throws them away.'],
      items: dirty.length > 1 ? names : undefined,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
    if (!discard) return false;
  }
  dropBuffers(tabIds);
  return true;
}
