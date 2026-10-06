/**
 * A task that ran out of road (attempts or fix rounds exhausted, verify failing, a conflict the resolver could
 * not settle) escalates to the inbox. Its session tile shows the decision inline: retry, retry with a note for
 * the next attempt, skip the task, or abort the run. Same resolution as the inbox (`inbox.resolve`).
 */
import type { InboxItemOf } from '@shared/domain';
import { useState } from 'react';
import { rpc } from '../../app/hooks';
import { Kbd } from '../../chrome/ui';
import { errorMessage } from './actions';
import { Glyph } from './glyphs';

export type EscalationItem = InboxItemOf<'escalation'> | InboxItemOf<'conflict'>;

const REASON: Record<InboxItemOf<'escalation'>['payload']['reason'], string> = {
  attempts_exhausted: 'Out of attempts',
  fix_rounds_exhausted: 'Out of fix rounds',
  verify_failed: 'Verification keeps failing',
  review_rejected: 'The reviewer rejected it',
  final_review: 'Final review found blockers',
  other: 'Needs your decision',
};

type Action = 'retry' | 'skip' | 'edit' | 'abort';

export function resolveEscalation(item: EscalationItem, action: Action, note: string | null) {
  if (item.kind === 'conflict')
    return rpc('inbox.resolve', {
      itemId: item.id,
      resolution: { kind: 'conflict', action: action === 'edit' ? 'retry' : action, note },
    });
  return rpc('inbox.resolve', { itemId: item.id, resolution: { kind: 'escalation', action, note } });
}

export function EscalationCard({ item, focused, label }: { item: EscalationItem; focused: boolean; label: string }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions: readonly Action[] =
    item.kind === 'escalation' ? item.payload.actions : (['retry', 'skip', 'abort'] as const);

  const act = async (action: Action, withNote: string | null = null) => {
    setPending(action);
    setError(null);
    try {
      await resolveEscalation(item, action, withNote);
    } catch (e) {
      setError(errorMessage(e));
      setPending(null);
    }
  };

  const title = item.kind === 'escalation' ? REASON[item.payload.reason] : 'Merge conflict';
  return (
    <section className="ap-card esc-card" data-testid="escalation-card" aria-label={`${label}: ${title}`}>
      <div className="ap-title esc-title">
        <Glyph name="warn" size={14} />
        {title}
        <span className="ap-tool mono">{item.kind}</span>
      </div>
      <div className="ap-reason esc-summary">{item.payload.summary}</div>
      {item.kind === 'conflict' && item.payload.files.length ? (
        <div className="mono esc-files">
          {item.payload.files.slice(0, 6).map((f) => (
            <div key={f} className="truncate">
              {f}
            </div>
          ))}
        </div>
      ) : null}
      {editing ? (
        <form
          className="esc-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) void act('edit', note.trim());
          }}
        >
          <textarea
            className="field field-sm esc-note"
            rows={3}
            // biome-ignore lint/a11y/noAutofocus: opened on purpose by "Retry with a note"
            autoFocus
            placeholder={`What should ${label}'s next attempt do differently?`}
            aria-label="Note for the next attempt"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (note.trim()) void act('edit', note.trim());
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <div className="ap-actions">
            <button type="submit" className="btn btn-warn btn-sm" disabled={!note.trim() || pending !== null}>
              {pending === 'edit' ? 'Retrying…' : 'Retry with note'}
              <Kbd>⌘⏎</Kbd>
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="ap-actions">
          {actions.includes('retry') ? (
            <button
              type="button"
              className="btn btn-warn btn-sm"
              disabled={pending !== null}
              onClick={() => void act('retry')}
              title="Start a fresh attempt"
              data-testid="escalation-retry"
            >
              {pending === 'retry' ? 'Retrying…' : 'Retry'}
              {focused ? <Kbd>R</Kbd> : null}
            </button>
          ) : null}
          {actions.includes('edit') ? (
            <button type="button" className="btn btn-sm" disabled={pending !== null} onClick={() => setEditing(true)}>
              Retry with a note…
            </button>
          ) : null}
          {actions.includes('skip') ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending !== null}
              onClick={() => void act('skip')}
              title="Mark the task skipped; tasks that depend on it can start"
            >
              {pending === 'skip' ? 'Skipping…' : 'Skip task'}
            </button>
          ) : null}
          {actions.includes('abort') ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm esc-abort"
              disabled={pending !== null}
              onClick={() => void act('abort')}
              title="Cancel the whole run (worktrees are kept)"
            >
              {pending === 'abort' ? 'Aborting…' : 'Abort run'}
            </button>
          ) : null}
        </div>
      )}
      {error ? (
        <div className="esc-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
