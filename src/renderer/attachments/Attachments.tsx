/**
 * Attachments UI shared by the composer, the steer bar and the clarify form: the chip tray (image thumbnails,
 * file chips, remove with × or Backspace), the Attach button (native dialog, ⌘⇧A), paste / drop helpers and
 * the preview (a lightbox for images, a text viewer for text files) hosted once at the overlay root.
 */
import {
  ATTACHMENT_EXTENSIONS,
  type AttachmentKind,
  type AttachmentRef,
  formatBytes,
  typeLabel,
} from '@shared/attachments';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { rpc } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { Icon } from '../chrome/icons';
import { SPRING } from '../theme/motion';
import { AttachmentDraft, base64ToBlob, type DraftItem, type DraftSnapshot } from './model';
import './attachments.css';

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

/** Object URLs of uploaded images fetched for display (refs without local bytes), by attachment id. */
const fetched = new Map<string, Promise<string | null>>();

/** An object URL for an uploaded image, fetched once per attachment. */
export function imageUrl(ref: AttachmentRef): Promise<string | null> {
  let url = fetched.get(ref.id);
  if (!url) {
    url = rpc('attachments.get', { id: ref.id }).then(
      (content) => (content.dataBase64 ? URL.createObjectURL(base64ToBlob(content.dataBase64, ref.mime)) : null),
      () => null,
    );
    fetched.set(ref.id, url);
  }
  return url;
}

export function createDraft(): AttachmentDraft {
  return new AttachmentDraft({
    upload: (input) => rpc('attachments.add', input),
    thumbnail: async (ref) => {
      const content = await rpc('attachments.get', { id: ref.id });
      return content.dataBase64 ? URL.createObjectURL(base64ToBlob(content.dataBase64, ref.mime)) : null;
    },
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  });
}

export function useDraft(draft: AttachmentDraft): DraftSnapshot {
  return useSyncExternalStore(draft.subscribe, draft.get);
}

type Bridge = { pickFiles?: (o: { title?: string; extensions?: readonly string[] }) => Promise<string[]> };
const bridge = () => (window as unknown as { legion?: Bridge & { pathForFile?: (f: File) => string } }).legion;

const PICK_EXTENSIONS = [...ATTACHMENT_EXTENSIONS.image, ...ATTACHMENT_EXTENSIONS.file];

/** Open the native file dialog (or a plain file input outside Electron) and add what was picked. */
export async function pickInto(draft: AttachmentDraft): Promise<void> {
  const pickFiles = bridge()?.pickFiles;
  if (pickFiles) {
    const paths = await pickFiles({ title: 'Attach files', extensions: PICK_EXTENSIONS });
    if (paths.length) await draft.addPaths(paths);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = PICK_EXTENSIONS.map((e) => `.${e}`).join(',');
  input.onchange = () => void draft.addFiles([...(input.files ?? [])]);
  input.click();
}

/** Files on the clipboard (a screenshot, files copied in Finder); [] for plain text. */
export function clipboardFiles(event: React.ClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data) return [];
  const files = [...data.files];
  if (files.length) return files;
  return [...data.items].flatMap((item) => {
    if (item.kind !== 'file') return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

/** Attach the clipboard's files on ⌘V; plain text pastes as usual. Returns whether it took the paste. */
export function pasteInto(draft: AttachmentDraft, event: React.ClipboardEvent): boolean {
  const files = clipboardFiles(event);
  if (files.length === 0) return false;
  event.preventDefault();
  void draft.addFiles(files);
  return true;
}

/** `file://` URLs of folders (trailing slash) in a drop's uri-list, by their last path segment. */
function folderUrls(data: DataTransfer): Map<string, string> {
  const folders = new Map<string, string>();
  for (const line of data.getData('text/uri-list').split(/\r?\n/)) {
    const url = line.trim();
    if (!url.startsWith('file://') || !url.endsWith('/')) continue;
    try {
      const path = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
      if (path) folders.set(path.split('/').pop() ?? path, path);
    } catch {
      // not a usable URL
    }
  }
  return folders;
}

/**
 * A drop split into folders (paths) and files. A folder is an entry the browser reports as a directory, or,
 * without entries (synthetic drops), an empty untyped File named like a folder URL in the uri-list.
 * Call synchronously in the drop handler.
 */
export function splitDrop(data: DataTransfer): { folders: string[]; files: File[] } {
  const folders: string[] = [];
  const files: File[] = [];
  const urls = folderUrls(data);
  const items = [...data.items].filter((i) => i.kind === 'file');
  items.forEach((item, i) => {
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }
    ).webkitGetAsEntry?.();
    const file = item.getAsFile() ?? data.files[i] ?? null;
    if (!file) return;
    const fromUrl = !entry && file.size === 0 && file.type === '' ? urls.get(file.name) : undefined;
    if (entry?.isDirectory || fromUrl) {
      const path = bridge()?.pathForFile?.(file) || fromUrl || '';
      if (path) folders.push(path);
    } else {
      files.push(file);
    }
  });
  return { folders, files };
}

/** Accept file drags on an element: `{ dragging, handlers }`; `onDrop` gets the DataTransfer. */
export function useFileDrop(onDrop: (data: DataTransfer) => void, enabled = true) {
  // A snapshot of the items' kind/type: DataTransferItems are emptied once the event is over.
  const [dragging, setDragging] = useState<{ kind: string; type: string }[] | null>(null);
  const depth = useRef(0);
  const hasFiles = (event: React.DragEvent) => [...event.dataTransfer.types].includes('Files');
  return {
    dragging,
    handlers: enabled
      ? {
          onDragEnter: (event: React.DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            depth.current += 1;
            setDragging([...event.dataTransfer.items].map(({ kind, type }) => ({ kind, type })));
          },
          onDragOver: (event: React.DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          },
          onDragLeave: () => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setDragging(null);
          },
          onDrop: (event: React.DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            depth.current = 0;
            setDragging(null);
            onDrop(event.dataTransfer);
          },
        }
      : {},
  };
}

// ---------------------------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------------------------

/** What a chip shows: a draft item or an attachment already sent. */
export interface ChipData {
  key: string;
  name: string;
  size: number | null;
  kind: AttachmentKind | null;
  mime: string;
  ref: AttachmentRef | null;
  url: string | null;
  busy: boolean;
}

export const chipOfDraft = (item: DraftItem): ChipData => ({
  key: item.key,
  name: item.name,
  size: item.size,
  kind: item.kind,
  mime: item.ref?.mime ?? '',
  ref: item.ref,
  url: item.url,
  busy: item.status === 'uploading',
});

export const chipOfRef = (ref: AttachmentRef, url: string | null = null): ChipData => ({
  key: ref.id,
  name: ref.name,
  size: ref.size,
  kind: ref.kind,
  mime: ref.mime,
  ref,
  url,
  busy: false,
});

function tone(chip: Pick<ChipData, 'kind' | 'mime'>): string {
  if (chip.mime === 'application/pdf') return 'var(--red)';
  if (chip.kind === 'text') return 'var(--blue)';
  return 'var(--overlay2)';
}

function label(chip: ChipData): string {
  if (!chip.ref) return chip.name.includes('.') ? (chip.name.split('.').pop() ?? '').toUpperCase().slice(0, 4) : '…';
  return typeLabel(chip.ref);
}

/** A ref's image thumbnail: the local URL if any, else fetched once. */
function useImageUrl(chip: ChipData): string | null {
  const [url, setUrl] = useState<string | null>(chip.url);
  useEffect(() => {
    if (chip.url) {
      setUrl(chip.url);
      return;
    }
    if (chip.kind !== 'image' || !chip.ref) return;
    let live = true;
    void imageUrl(chip.ref).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [chip.url, chip.kind, chip.ref]);
  return url;
}

function Chip({
  chip,
  size,
  onOpen,
  onRemove,
}: {
  chip: ChipData;
  size: 'md' | 'sm';
  onOpen: (element: HTMLElement) => void;
  onRemove: ((direction: 'back' | 'forward') => void) | null;
}) {
  const url = useImageUrl(chip);
  const image = chip.kind === 'image' || (chip.kind === null && url !== null);
  const meta = [label(chip), chip.size !== null ? formatBytes(chip.size) : null].filter(Boolean).join(' · ');
  const title = chip.busy ? `${chip.name} · uploading…` : `${chip.name} · ${meta}`;
  return (
    <li className={`at-chip at-${size} ${image ? 'at-img' : 'at-file'}`} data-busy={chip.busy || undefined}>
      <button
        type="button"
        className="at-open"
        title={title}
        aria-label={`${chip.name}${chip.busy ? ', uploading' : `, ${meta}`}. Open preview${onRemove ? ', Backspace removes it' : ''}`}
        data-testid="attachment-chip"
        data-name={chip.name}
        disabled={chip.busy && !url}
        onClick={(event) => onOpen(event.currentTarget)}
        onKeyDown={(event) => {
          if (!onRemove) return;
          if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            onRemove(event.key === 'Backspace' ? 'back' : 'forward');
          }
        }}
      >
        {image ? (
          url ? (
            <img className="at-thumb" src={url} alt="" draggable={false} />
          ) : (
            <span className="at-thumb at-thumb-empty">
              <Icon name="image" size={size === 'sm' ? 14 : 18} />
            </span>
          )
        ) : (
          <>
            <span className="at-badge" style={{ '--at-tone': tone(chip) } as React.CSSProperties}>
              <Icon name="file" size={size === 'sm' ? 15 : 20} strokeWidth={1.6} />
              <span className="at-badge-label">{label(chip)}</span>
            </span>
            <span className="at-text">
              <span className="at-name">{chip.name}</span>
              <span className="at-meta">
                {chip.busy ? 'uploading…' : chip.size !== null ? formatBytes(chip.size) : ''}
              </span>
            </span>
          </>
        )}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="at-x"
          tabIndex={-1}
          aria-label={`Remove ${chip.name}`}
          title="Remove"
          data-testid="attachment-remove"
          onClick={() => onRemove('forward')}
        >
          <Icon name="close" size={10} strokeWidth={2.8} />
        </button>
      ) : null}
    </li>
  );
}

/** A row of chips; with `onRemove`, removable (focus moves to a neighbour, else to `returnFocus`). */
export function ChipList({
  chips,
  size = 'md',
  onRemove,
  returnFocus,
  label: listLabel = 'Attachments',
}: {
  chips: readonly ChipData[];
  size?: 'md' | 'sm';
  onRemove?: (key: string) => void;
  returnFocus?: () => void;
  label?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  if (chips.length === 0) return null;
  const focusAt = (index: number) => {
    requestAnimationFrame(() => {
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.at-open') ?? [])];
      const target = buttons[Math.min(index, buttons.length - 1)];
      if (target) target.focus();
      else returnFocus?.();
    });
  };
  return (
    <ul className={`at-list at-list-${size}`} ref={ref} aria-label={listLabel} data-testid="attachment-list">
      {chips.map((chip, i) => (
        <Chip
          key={chip.key}
          chip={chip}
          size={size}
          onOpen={(element) => openPreview(chips, i, element)}
          onRemove={
            onRemove
              ? (direction) => {
                  onRemove(chip.key);
                  focusAt(direction === 'back' ? Math.max(0, i - 1) : i);
                }
              : null
          }
        />
      ))}
    </ul>
  );
}

/** The draft's chips plus its inline errors. */
export function AttachmentTray({
  draft,
  returnFocus,
  size = 'md',
}: {
  draft: AttachmentDraft;
  returnFocus?: () => void;
  size?: 'md' | 'sm';
}) {
  const { items, errors } = useDraft(draft);
  if (items.length === 0 && errors.length === 0) return null;
  return (
    <div className="at-tray" data-testid="attachment-tray">
      <ChipList
        chips={items.map(chipOfDraft)}
        size={size}
        onRemove={(key) => draft.remove(key)}
        {...(returnFocus ? { returnFocus } : {})}
      />
      {errors.length ? (
        <div className="at-errors" role="alert" data-testid="attachment-error">
          <Icon name="alert" size={12} className="flex-none" />
          <span className="at-errors-text">
            {errors.slice(0, 3).map((e) => (
              <span key={e}>{e}</span>
            ))}
            {errors.length > 3 ? <span>…and {errors.length - 3} more.</span> : null}
          </span>
          <button
            type="button"
            className="at-errors-x"
            aria-label="Dismiss"
            onClick={() => {
              draft.dismissErrors();
              returnFocus?.();
            }}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The paperclip button. */
export function AttachButton({
  draft,
  label: text,
  className = '',
  testId = 'attach-button',
}: {
  draft: AttachmentDraft;
  label?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`at-attach ${text ? '' : 'at-attach-icon'} ${className}`}
      title="Attach files (⌘⇧A) · or paste / drop them"
      aria-label="Attach files"
      aria-keyshortcuts="Meta+Shift+A"
      data-testid={testId}
      // Keep focus (and the caret) in the text field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void pickInto(draft)}
    >
      <Icon name="paperclip" size={14} strokeWidth={1.9} />
      {text ? <span>{text}</span> : null}
    </button>
  );
}

/** ⌘⇧A → the file dialog. Returns whether it handled the key. */
export function attachShortcut(draft: AttachmentDraft, event: React.KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'a' || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey)
    return false;
  event.preventDefault();
  event.stopPropagation();
  void pickInto(draft);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Preview (lightbox / text viewer), hosted once by the overlay root
// ---------------------------------------------------------------------------------------------

interface PreviewState {
  chips: readonly ChipData[];
  index: number;
  returnTo: HTMLElement | null;
}

let preview: PreviewState | null = null;
const previewListeners = new Set<() => void>();
const setPreview = (next: PreviewState | null) => {
  preview = next;
  for (const listener of previewListeners) listener();
};

export function openPreview(chips: readonly ChipData[], index: number, returnTo: HTMLElement | null = null): void {
  setPreview({ chips, index, returnTo });
}

export function closePreview(): void {
  const returnTo = preview?.returnTo ?? null;
  setPreview(null);
  if (returnTo?.isConnected) requestAnimationFrame(() => returnTo.focus({ preventScroll: true }));
}

export function PreviewHost() {
  const state = useSyncExternalStore(
    (listener) => {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    () => preview,
  );
  return <AnimatePresence>{state ? <Preview key="preview" state={state} /> : null}</AnimatePresence>;
}

type Content =
  | { status: 'loading' }
  | { status: 'image'; url: string }
  | { status: 'text'; text: string; truncated: boolean }
  | { status: 'none' }
  | { status: 'error'; message: string };

function useContent(chip: ChipData): Content {
  const [content, setContent] = useState<Content>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    const set = (c: Content) => live && setContent(c);
    if (chip.kind === 'image') {
      if (chip.url) set({ status: 'image', url: chip.url });
      else if (chip.ref)
        void imageUrl(chip.ref).then((url) =>
          set(url ? { status: 'image', url } : { status: 'error', message: 'The image could not be loaded.' }),
        );
      else set({ status: 'loading' });
    } else if (chip.kind === 'text' && chip.ref) {
      set({ status: 'loading' });
      rpc('attachments.get', { id: chip.ref.id }).then(
        (c) => set({ status: 'text', text: c.text ?? '', truncated: c.truncated }),
        (error: unknown) => set({ status: 'error', message: (error as Error).message }),
      );
    } else {
      set(chip.ref ? { status: 'none' } : { status: 'loading' });
    }
    return () => {
      live = false;
    };
  }, [chip]);
  return content;
}

function Preview({ state }: { state: PreviewState }) {
  const reduced = useReducedMotionPref();
  const [index, setIndex] = useState(state.index);
  const chip = state.chips[Math.min(index, state.chips.length - 1)] as ChipData;
  const content = useContent(chip);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [dims, setDims] = useState<string | null>(null);
  const count = state.chips.length;

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per shown attachment
  useEffect(() => setDims(null), [chip.key]);

  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closePreview();
    } else if (event.key === 'ArrowRight' && count > 1) {
      event.preventDefault();
      go(1);
    } else if (event.key === 'ArrowLeft' && count > 1) {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'Tab') {
      // Keep focus inside the preview.
      const items = [...(event.currentTarget.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? [])];
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const meta = [chip.ref ? typeLabel(chip.ref) : null, dims, chip.size !== null ? formatBytes(chip.size) : null]
    .filter(Boolean)
    .join(' · ');
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the dialog owns its keys (Esc, arrows, Tab)
    <div className="at-lb" data-local-keys data-testid="attachment-preview" onKeyDown={onKeyDown}>
      <motion.button
        type="button"
        tabIndex={-1}
        aria-label="Close preview"
        className="at-lb-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
        onClick={closePreview}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${chip.name}`}
        className={`at-lb-panel at-lb-${content.status === 'image' ? 'image' : content.status === 'text' ? 'text' : 'card'}`}
        initial={hidden}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ ...hidden, transition: { duration: 0.1 } }}
        transition={reduced ? { duration: 0.12 } : SPRING}
      >
        <div className="at-lb-head">
          {content.status !== 'image' ? (
            <span className="at-badge at-badge-lg" style={{ '--at-tone': tone(chip) } as React.CSSProperties}>
              <Icon name="file" size={22} strokeWidth={1.6} />
              <span className="at-badge-label">{label(chip)}</span>
            </span>
          ) : null}
          <span className="at-lb-title">
            <span className="at-lb-name" data-testid="attachment-preview-name">
              {chip.name}
            </span>
            <span className="at-lb-meta">{meta}</span>
          </span>
          {count > 1 ? (
            <span className="at-lb-nav">
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous" onClick={() => go(-1)}>
                <Icon name="chevronLeft" size={15} />
              </button>
              <span className="at-lb-count">
                {index + 1} / {count}
              </span>
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Next" onClick={() => go(1)}>
                <Icon name="chevronRight" size={15} />
              </button>
            </span>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost btn-icon at-lb-close"
            aria-label="Close preview"
            title="Close (Esc)"
            onClick={closePreview}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="at-lb-body">
          {content.status === 'image' ? (
            <img
              className="at-lb-img"
              src={content.url}
              alt={chip.name}
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget;
                setDims(`${img.naturalWidth}×${img.naturalHeight}`);
              }}
            />
          ) : content.status === 'text' ? (
            <TextView text={content.text} truncated={content.truncated} />
          ) : content.status === 'loading' ? (
            <div className="at-lb-note faint">Loading…</div>
          ) : content.status === 'error' ? (
            <div className="at-lb-note at-lb-error">{content.message}</div>
          ) : (
            <div className="at-lb-note">
              {chip.mime === 'application/pdf'
                ? 'Claude reads the PDF itself; Codex gets the path of the file. No preview here.'
                : 'No preview for this file.'}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

const TEXT_VIEW_LINES = 5000;

function TextView({ text, truncated }: { text: string; truncated: boolean }) {
  const all = text.replace(/\n$/, '').split('\n');
  const lines = all.slice(0, TEXT_VIEW_LINES);
  const cut = truncated || all.length > lines.length;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
    <div className="at-text-view" tabIndex={0} data-testid="attachment-preview-text">
      <ol className="at-lines" style={{ '--at-gutter': `${String(lines.length).length + 1}ch` } as React.CSSProperties}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a static text
          <li key={i}>{line || ' '}</li>
        ))}
      </ol>
      {cut ? <div className="at-lb-cut">Preview cut short. The agent gets the file itself.</div> : null}
    </div>
  );
}
