/**
 * A task that ran out of road (attempts or fix rounds exhausted, verify failing, a conflict the resolver could
 * not settle) escalates to the inbox. Its session tile shows the decision inline: retry (resumes the failed
 * step, keeping the work), start over (from scratch, after a confirm), retry with a note for the next
 * attempt, skip the task, or abort the run. Same resolution as the inbox (`inbox.resolve`).
 */
import type { InboxItemOf, ResumeStep } from '@shared/domain';
import { useState } from 'react';
import { confirmAction } from '../../app/confirm';
import { rpc } from '../../app/hooks';
import { Kbd } from '../../chrome/ui';
import { trackResolution, usePendingResolution } from './actions';
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

/** `restart` = start over from scratch; offered (by us) wherever `retry` is. */
export type EscalationAction = 'retry' | 'restart' | 'skip' | 'edit' | 'abort';
type Action = EscalationAction;

const RESUME_LABEL: Record<ResumeStep, { label: string; title: string }> = {
  code: { label: 'Resume coding', title: 'Continue in the existing worktree with a fresh coder turn' },
  fix: { label: 'Retry fix round', title: 'Keep the work and run another fix round with a fresh budget' },
  review: { label: 'Retry review', title: 'Keep the work and have it reviewed again' },
  merge: { label: 'Retry merge', title: 'Keep the work and put it back in the merge queue' },
};

/**
 * The Retry button: what it resumes (`payload.resume`), or a plain retry when the engine doesn't say. Retry
 * keeps the task's work; "Start over" (restart) is the from-scratch alternative.
 */
export function retryChoice(item: EscalationItem): { label: string; title: string } {
  const resume = item.kind === 'escalation' ? item.payload.resume : null;
  if (resume) return RESUME_LABEL[resume];
  return item.kind === 'conflict'
    ? { label: 'Retry resolver', title: 'Run the conflict resolver again' }
    : { label: 'Retry', title: 'Try the failed step again' };
}

/** "Start over" is offered next to every task escalation's Retry (the engine accepts `restart` there). */
export function canStartOver(item: EscalationItem): boolean {
  return item.kind === 'escalation' && item.taskId !== null && item.payload.actions.includes('retry');
}

/**
 * Resolve an escalation / conflict. Tracked per item (see `trackResolution`): the card's buttons, the `R` key
 * and the inbox share one in-flight state, so a repeated key or a second click can't resolve it twice.
 */
export function resolveEscalation(item: EscalationItem, action: Action, note: string | null): Promise<void> {
  return trackResolution(item.id, action, () =>
    item.kind === 'conflict'
      ? rpc('inbox.resolve', {
          itemId: item.id,
          resolution: {
            kind: 'conflict',
            action: action === 'edit' || action === 'restart' ? 'retry' : action,
            note,
          },
        })
      : rpc('inbox.resolve', { itemId: item.id, resolution: { kind: 'escalation', action, note } }),
  );
}

/** Start the escalated task over from scratch, after an explicit confirm (its current work is discarded). */
export async function startOver(item: EscalationItem, label: string): Promise<boolean> {
  const ok = await confirmAction({
    title: `Start ${label} over from scratch?`,
    body: [
      `${label} gets a fresh worktree from the integration branch and a fresh attempt budget. The work in its current worktree is discarded; the last error goes to the new coder as context.`,
      'Retry keeps that work and picks up the failed step instead.',
    ],
    confirmLabel: 'Start over',
    tone: 'danger',
  });
  if (!ok) return false;
  await resolveEscalation(item, 'restart', null);
  return true;
}

export function EscalationCard({ item, focused, label }: { item: EscalationItem; focused: boolean; label: string }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const tracked = usePendingResolution(item.id);
  const pending = tracked?.state === 'pending' ? (tracked.choice as Action) : null;
  const error = tracked?.state === 'error' ? tracked.message : null;
  const actions: readonly Action[] =
    item.kind === 'escalation' ? item.payload.actions : (['retry', 'skip', 'abort'] as const);

  const act = (action: Action, withNote: string | null = null) => resolveEscalation(item, action, withNote);
  const retry = retryChoice(item);

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
              title={retry.title}
              data-testid="escalation-retry"
            >
              {pending === 'retry' ? 'Retrying…' : retry.label}
              {focused ? <Kbd>R</Kbd> : null}
            </button>
          ) : null}
          {canStartOver(item) ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending !== null}
              onClick={() => void startOver(item, label)}
              title="Discard the work and start the task over from scratch"
              data-testid="escalation-restart"
            >
              {pending === 'restart' ? 'Starting over…' : 'Start over…'}
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
