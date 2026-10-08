/**
 * The reply box under the conversation: text (⏎ sends, ⇧⏎ a new line, ⌘⏎ interrupts the assistant's turn
 * and sends now), files (paste, drop, Attach ⌘⇧A), and Stop while the assistant is writing. When the run has
 * no assistant to talk to, it says why instead.
 */
import type { Attempt } from '@shared/domain';
import { useLayoutEffect, useRef, useState } from 'react';
import { formatChord } from '../app/keys';
import {
  AttachButton,
  AttachmentTray,
  attachShortcut,
  chipOfDraft,
  createDraft,
  pasteInto,
  splitDrop,
  useDraft,
  useFileDrop,
} from '../attachments/Attachments';
import type { AttachmentDraft } from '../attachments/model';
import { Icon } from '../chrome/icons';
import { interrupt, steer } from '../tiles/session/actions';

/** Reply drafts per run: what was typed and attached survives switching runs or views. */
const drafts = new Map<string, { draft: AttachmentDraft; text: string }>();
function replyDraft(runId: string) {
  let entry = drafts.get(runId);
  if (!entry) {
    entry = { draft: createDraft(), text: '' };
    drafts.set(runId, entry);
  }
  return entry;
}

/** Sent with attachments but no words. */
const FILES_ONLY = 'See the attached files.';
const MAX_HEIGHT = 240;

export function ChatComposer({
  runId,
  assistant,
  busy,
  closed,
  onSent,
}: {
  runId: string;
  assistant: Attempt | null;
  busy: boolean;
  /** Why there is nobody to talk to (null = the assistant is live). */
  closed: string | null;
  onSent: () => void;
}) {
  const entry = replyDraft(runId);
  const [text, setText] = useState(entry.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { items } = useDraft(entry.draft);
  const uploading = items.some((i) => i.status === 'uploading');
  const live = closed === null && assistant !== null;
  const drop = useFileDrop((data) => {
    const { folders, files } = splitDrop(data);
    if (folders.length) entry.draft.report("Folders can't be attached. Drop files instead.");
    if (files.length) void entry.draft.addFiles(files);
  }, live);

  // biome-ignore lint/correctness/useExhaustiveDependencies: grow with the text
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    entry.text = value;
  };
  const canSend = live && !uploading && (text.trim().length > 0 || items.length > 0);
  const send = (priority: 'now' | 'next') => {
    if (!canSend || !assistant) return;
    const value = text.trim();
    const sent = entry.draft.take().map(chipOfDraft);
    update('');
    void steer(assistant.id, value || FILES_ONLY, priority, sent);
    onSent();
  };

  if (!live) {
    return (
      <div className="ch-composer ch-composer-closed" data-testid="chat-closed">
        <Icon name="session" size={14} />
        <span>{closed ?? 'The assistant is not running.'}</span>
      </div>
    );
  }

  return (
    <form
      className="ch-composer"
      data-busy={busy || undefined}
      {...drop.handlers}
      onSubmit={(event) => {
        event.preventDefault();
        send('next');
      }}
    >
      <AttachmentTray draft={entry.draft} size="sm" returnFocus={() => ref.current?.focus()} />
      <textarea
        ref={ref}
        className="ch-input"
        rows={1}
        value={text}
        placeholder={busy ? 'Reply… the assistant reads it when it finishes' : 'Reply to the assistant…'}
        aria-label="Reply to the assistant"
        spellCheck
        data-testid="chat-input"
        onChange={(event) => update(event.target.value)}
        onPaste={(event) => void pasteInto(entry.draft, event)}
        onKeyDown={(event) => {
          if (attachShortcut(entry.draft, event)) return;
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!event.repeat) send(event.metaKey || event.ctrlKey ? 'now' : 'next');
        }}
      />
      <div className="ch-composer-row">
        <AttachButton draft={entry.draft} testId="chat-attach" />
        <span className="ch-composer-hint" aria-hidden="true">
          {busy ? `${formatChord('Mod+Enter')} interrupt and send` : '⇧⏎ new line'}
        </span>
        {busy ? (
          <button
            type="button"
            className="ch-round ch-stop"
            aria-label="Stop the assistant"
            title="Stop the assistant's turn"
            onClick={() => assistant && void interrupt(assistant.id)}
            data-testid="chat-stop"
          >
            <Icon name="stop" size={11} fill="currentColor" strokeWidth={1.5} />
          </button>
        ) : null}
        <button
          type="submit"
          className="ch-round ch-send"
          disabled={!canSend}
          aria-label="Send"
          title="Send (⏎)"
          data-testid="chat-send"
        >
          <Icon name="arrowUp" size={15} strokeWidth={2.4} />
        </button>
      </div>
      {drop.dragging ? (
        <div className="at-drop">
          <Icon name="paperclip" size={16} />
          Drop to send with your reply
        </div>
      ) : null}
    </form>
  );
}
