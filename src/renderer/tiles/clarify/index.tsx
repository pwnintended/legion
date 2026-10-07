/**
 * Clarify tile: the planner's questions before it drafts the plan. Each question offers option chips and a free
 * text note; answers go to `runs.answerClarify`. "Skip" tells the planner to make (and note) its own assumptions.
 * Screenshots or files (paste, drop, Attach ⌘⇧A) travel with the answers to the planner.
 */
import type { AttachmentRef } from '@shared/attachments';
import type { InboxItemOf, QuestionAnswer } from '@shared/domain';
import { useId, useRef, useState } from 'react';
import { rpc, useInboxItem, useRun } from '../../app/hooks';
import { itemResolved, singleFlight, whenData } from '../../app/pending';
import {
  AttachButton,
  AttachmentTray,
  attachShortcut,
  ChipList,
  chipOfRef,
  createDraft,
  pasteInto,
  splitDrop,
  useDraft,
  useFileDrop,
} from '../../attachments/Attachments';
import type { AttachmentDraft } from '../../attachments/model';
import { Icon } from '../../chrome/icons';
import { Chip, Kbd } from '../../chrome/ui';
import type { TileCardProps, TileProps } from '../../layout/types';
import { errorMessage } from '../session/actions';
import './clarify.css';

export const ASSUME = 'No preference: make a reasonable assumption and note it in the plan.';

/** Attachments for the answers, per question item (kept while the tile is closed). */
const drafts = new Map<string, AttachmentDraft>();
function answerDraft(itemId: string): AttachmentDraft {
  let draft = drafts.get(itemId);
  if (!draft) {
    draft = createDraft();
    drafts.set(itemId, draft);
  }
  return draft;
}

interface Answer {
  option: string | null;
  note: string;
}

/** Combine a chosen option and a free-text note into the answer sent to the planner. */
export function composeAnswer(answer: Answer | undefined): string {
  const option = answer?.option ?? '';
  const note = answer?.note.trim() ?? '';
  if (option && note) return `${option}. ${note}`;
  return option || note;
}

export default function ClarifyTile({ runId, params }: TileProps<'clarify'>) {
  const item = useInboxItem(params.inboxItemId);
  const run = useRun(runId);
  if (item?.kind !== 'question')
    return <div className="cl-empty faint">No open questions. The planner is drafting the plan.</div>;
  if (item.resolvedAt !== null) return <Answered item={item} />;
  return <Questions item={item} runId={runId} planner={run?.plannerEngine ?? 'claude'} />;
}

function Questions({ item, runId, planner }: { item: InboxItemOf<'question'>; runId: string; planner: string }) {
  const ids = useId();
  const questions = item.payload.questions;
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [state, setState] = useState<{ status: 'idle' | 'sending' } | { status: 'error'; message: string }>({
    status: 'idle',
  });
  const answered = questions.filter((q) => composeAnswer(answers[q.id])).length;
  const draft = answerDraft(item.id);
  const { items } = useDraft(draft);
  const uploading = items.some((i) => i.status === 'uploading');
  const formRef = useRef<HTMLFormElement>(null);
  const drop = useFileDrop((data) => {
    const { folders, files } = splitDrop(data);
    if (folders.length) draft.report("Folders can't be attached. Drop files instead.");
    if (files.length) void draft.addFiles(files);
  });
  const set = (id: string, patch: Partial<Answer>) =>
    setAnswers((all) => ({ ...all, [id]: { option: null, note: '', ...all[id], ...patch } }));

  // One answer at a time: ⌘⏎ (also held) while sending, or before the planner picked the answers up, is
  // ignored instead of sending the answers twice.
  const [once] = useState(singleFlight);
  const send = (list: QuestionAnswer[]) =>
    once(async () => {
      setState({ status: 'sending' });
      try {
        const attachmentIds = draft.ids;
        await rpc('runs.answerClarify', {
          runId,
          answers: list,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        draft.clear();
        // Stays "sending" until the question is resolved in the store (the tile then shows the answers).
        if (!(await whenData(itemResolved(item.id)))) setState({ status: 'idle' });
      } catch (error) {
        setState({ status: 'error', message: errorMessage(error) });
      }
    });
  const submit = () =>
    send(questions.map((q) => ({ questionId: q.id, answer: composeAnswer(answers[q.id]) || ASSUME })));
  const skip = () => send(questions.map((q) => ({ questionId: q.id, answer: ASSUME })));
  const busy = state.status === 'sending' || uploading;

  return (
    <form
      ref={formRef}
      className="cl"
      data-testid="clarify"
      {...drop.handlers}
      onPaste={(event) => void pasteInto(draft, event)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (attachShortcut(draft, event)) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!event.repeat) void submit();
        }
      }}
    >
      <div className="cl-scroll">
        <div className="cl-intro">
          <Chip tone={planner === 'codex' ? 'codex' : 'claude'}>{planner} planner</Chip>
          <span className="muted">
            <span className="cl-intro-subject">It </span>read the repo and has {questions.length} question
            {questions.length === 1 ? '' : 's'} before drafting the plan.
          </span>
          <button type="button" className="cl-skip" disabled={busy} onClick={() => void skip()}>
            Skip, let the planner assume
          </button>
        </div>
        <ol className="cl-list">
          {questions.map((q, n) => {
            const a = answers[q.id];
            return (
              <li key={q.id} className="cl-q" data-answered={!!composeAnswer(a)}>
                <div className="cl-q-head">
                  <span className="cl-num mono">{n + 1}</span>
                  <span className="cl-question" id={`${ids}-${q.id}`}>
                    {q.question}
                  </span>
                </div>
                {q.options.length ? (
                  <div className="cl-options" role="radiogroup" aria-labelledby={`${ids}-${q.id}`}>
                    {q.options.map((option) => (
                      // biome-ignore lint/a11y/useSemanticElements: option chips, not native radios
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={a?.option === option}
                        className="opt-chip"
                        onClick={() => set(q.id, { option: a?.option === option ? null : option })}
                      >
                        {a?.option === option ? <Icon name="check" size={12} strokeWidth={2.6} /> : null}
                        {option}
                      </button>
                    ))}
                  </div>
                ) : null}
                <input
                  className="cl-note"
                  value={a?.note ?? ''}
                  aria-label={`Answer to question ${n + 1}`}
                  placeholder={q.options.length ? 'Add a note (optional)…' : 'Your answer…'}
                  onChange={(event) => set(q.id, { note: event.target.value })}
                />
              </li>
            );
          })}
        </ol>
      </div>
      <div className="cl-attachments">
        <AttachmentTray
          draft={draft}
          size="sm"
          returnFocus={() => formRef.current?.querySelector<HTMLElement>('.cl-note')?.focus()}
        />
      </div>
      <div className="cl-foot">
        <AttachButton draft={draft} label="Attach" testId="clarify-attach" />
        <span className="faint cl-progress">
          {answered}/{questions.length} answered
          {answered < questions.length ? (
            <span className="cl-progress-more"> · the planner assumes the rest</span>
          ) : null}
        </span>
        {state.status === 'error' ? <span className="cl-error">{state.message}</span> : null}
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="clarify-submit">
          {state.status === 'sending' ? 'Sending…' : uploading ? 'Uploading…' : 'Send answers'}
          <Kbd>⌘⏎</Kbd>
        </button>
      </div>
      {drop.dragging ? (
        <div className="at-drop">
          <Icon name="paperclip" size={16} />
          Drop to attach to your answers
        </div>
      ) : null}
    </form>
  );
}

function Answered({ item }: { item: InboxItemOf<'question'> }) {
  const resolution = item.resolution as { answers?: QuestionAnswer[]; attachments?: AttachmentRef[] | null } | null;
  const answers = resolution?.answers ?? [];
  const attachments = resolution?.attachments ?? [];
  return (
    <div className="cl-scroll cl-done">
      <div className="cl-intro">
        <Chip tone="ok">answered</Chip>
        <span className="muted">The planner is drafting the plan with your answers.</span>
      </div>
      <ol className="cl-list">
        {item.payload.questions.map((q, n) => {
          const answer = answers.find((a) => a.questionId === q.id)?.answer ?? '';
          return (
            <li key={q.id} className="cl-q">
              <div className="cl-q-head">
                <span className="cl-num mono">{n + 1}</span>
                <span className="cl-question">{q.question}</span>
              </div>
              <div className={answer === ASSUME ? 'cl-answer faint' : 'cl-answer'}>
                {answer === ASSUME ? 'Planner assumes' : answer}
              </div>
            </li>
          );
        })}
      </ol>
      {attachments.length ? (
        <div className="cl-sent-attachments">
          <span className="faint">Attached</span>
          <ChipList chips={attachments.map((a) => chipOfRef(a))} size="sm" label="Attached to the answers" />
        </div>
      ) : null}
    </div>
  );
}

export function Card({ params }: TileCardProps<'clarify'>) {
  const item = useInboxItem(params.inboxItemId);
  if (item?.kind !== 'question') return <div>no open questions</div>;
  return (
    <>
      {item.payload.questions.slice(0, 3).map((q, n) => (
        <div key={q.id}>
          {n + 1}. {q.question}
        </div>
      ))}
    </>
  );
}
