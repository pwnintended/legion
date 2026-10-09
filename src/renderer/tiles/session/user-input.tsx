/**
 * Questions an agent asks through its engine's own tool: Claude's `AskUserQuestion` and Codex's
 * `request_user_input`. Both arrive as approval requests, but accepting one without answers tells the agent the
 * human did not answer; so the card asks the questions and sends the answers back as the tool's `updatedInput`
 * (Claude: `{questions, answers: {[question text]: label}}`; Codex: `{answers: {[id]: {answers: [...]}}}`).
 */
import type { InboxItemOf } from '@shared/domain';
import { useId, useState } from 'react';
import { rpc } from '../../app/hooks';
import { codeSpans } from '../../chrome/options';
import { trackResolution, usePendingResolution } from './actions';

export interface AskedQuestion {
  /** What the answers are keyed by: the question text (Claude) or its id (Codex). */
  key: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multi: boolean;
  /** A free-text answer is allowed. */
  free: boolean;
  secret: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function options(value: unknown): AskedQuestion['options'] {
  return asArray(value)
    .map((o) => ({ label: str(asRecord(o).label), description: str(asRecord(o).description) }))
    .filter((o) => o.label);
}

/** The questions of a question tool's approval request, or null for any other tool. */
export function askedQuestions(tool: string, input: unknown): AskedQuestion[] | null {
  const questions = asArray(asRecord(input).questions).map(asRecord);
  if (tool === 'AskUserQuestion')
    return questions
      .filter((q) => str(q.question))
      .map((q) => ({
        key: str(q.question),
        header: str(q.header),
        question: str(q.question),
        options: options(q.options),
        multi: q.multiSelect === true,
        // Claude Code always offers "Other".
        free: true,
        secret: false,
      }));
  if (tool === 'request_user_input')
    return questions
      .filter((q) => str(q.id))
      .map((q) => {
        const opts = options(q.options);
        return {
          key: str(q.id),
          header: str(q.header),
          question: str(q.question),
          options: opts,
          multi: false,
          free: q.isOther === true || opts.length === 0,
          secret: q.isSecret === true,
        };
      });
  return null;
}

/** The tool input that carries the answers (keyed by {@link AskedQuestion.key}). */
export function answeredInput(tool: string, input: unknown, answers: Record<string, string[]>): unknown {
  if (tool === 'request_user_input')
    return { answers: Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, { answers: list }])) };
  // Claude takes one string per question; a multi-select answer is its labels joined, as Claude Code's own UI does.
  return {
    ...asRecord(input),
    answers: Object.fromEntries(Object.entries(answers).map(([question, list]) => [question, list.join(', ')])),
  };
}

/** The answers in a resolved question tool's `updatedInput`, in order (for receipts). */
export function sentAnswers(tool: string, updatedInput: unknown): string[] {
  const answers = asRecord(asRecord(updatedInput).answers);
  if (tool === 'request_user_input')
    return Object.values(answers).flatMap((a) => asArray(asRecord(a).answers).map(String));
  return Object.values(answers).map(String);
}

/** One line naming what was asked: the first question's header or text. */
export function questionsLabel(questions: AskedQuestion[]): string {
  const first = questions[0];
  const name = first ? first.header || first.question : 'Question';
  return questions.length > 1 ? `${name} (+${questions.length - 1} more)` : name;
}

const SKIPPED = 'The user did not answer. Decide yourself and say what you assumed.';

interface Draft {
  picked: string[];
  other: string;
}

function answerOf(q: AskedQuestion, draft: Draft | undefined): string[] {
  const other = draft?.other.trim() ?? '';
  const picked = draft?.picked ?? [];
  if (q.multi) return other ? [...picked, other] : picked;
  return other ? [other] : picked.slice(0, 1);
}

/** A question's options: checkboxes for a multi-select question, else a radio group. */
function OptionRows({
  question,
  picked,
  labelledBy,
  onToggle,
}: {
  question: AskedQuestion;
  picked: string[];
  labelledBy: string;
  onToggle: (label: string) => void;
}) {
  const rows = question.options.map((o) => {
    const body = (
      <>
        <span className="opt-mark" aria-hidden="true" />
        <span className="opt-text">
          {codeSpans(o.label)}
          {o.description ? <span className="uq-desc">{codeSpans(o.description)}</span> : null}
        </span>
      </>
    );
    const checked = picked.includes(o.label);
    return question.multi ? (
      // biome-ignore lint/a11y/useSemanticElements: styled option rows, not native checkboxes
      <button
        key={o.label}
        type="button"
        role="checkbox"
        aria-checked={checked}
        className="opt"
        data-multi
        onClick={() => onToggle(o.label)}
      >
        {body}
      </button>
    ) : (
      // biome-ignore lint/a11y/useSemanticElements: styled option rows, not native radios
      <button
        key={o.label}
        type="button"
        role="radio"
        aria-checked={checked}
        className="opt"
        onClick={() => onToggle(o.label)}
      >
        {body}
      </button>
    );
  });
  // Checkboxes need no group role: the question's fieldset groups them.
  return question.multi ? (
    <div className="opt-list">{rows}</div>
  ) : (
    <div className="opt-list" role="radiogroup" aria-labelledby={labelledBy}>
      {rows}
    </div>
  );
}

/** The questions with their options and an answer box, sent as one answer (or skipped). */
export function QuestionForm({
  item,
  questions,
  compact = false,
}: {
  item: InboxItemOf<'approval'>;
  questions: AskedQuestion[];
  compact?: boolean;
}) {
  const ids = useId();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const pending = usePendingResolution(item.id);
  const busy = pending?.state === 'pending';
  const size = compact ? ' btn-sm' : '';
  const complete = questions.every((q) => answerOf(q, drafts[q.key]).length > 0);

  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((all) => ({ ...all, [key]: { picked: [], other: '', ...all[key], ...patch } }));
  const toggle = (q: AskedQuestion, label: string) => {
    const picked = drafts[q.key]?.picked ?? [];
    if (q.multi)
      update(q.key, { picked: picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label] });
    // A single pick replaces a typed answer, and clicking the picked option clears it.
    else update(q.key, { picked: picked.includes(label) ? [] : [label], other: '' });
  };

  const decide = (choice: 'answer' | 'skip') =>
    trackResolution(item.id, choice, () =>
      rpc('inbox.resolve', {
        itemId: item.id,
        resolution: {
          kind: 'approval',
          decision:
            choice === 'answer'
              ? {
                  behavior: 'allow',
                  scope: 'once',
                  updatedInput: answeredInput(
                    item.payload.tool,
                    item.payload.input,
                    Object.fromEntries(questions.map((q) => [q.key, answerOf(q, drafts[q.key])])),
                  ),
                }
              : { behavior: 'deny', message: SKIPPED, interrupt: false },
        },
      }),
    );

  return (
    <form
      className="uq"
      data-testid="question-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) void decide('answer');
      }}
    >
      {questions.map((q) => {
        const draft = drafts[q.key];
        const labelId = `${ids}-${q.key}`;
        return (
          <fieldset key={q.key} className="uq-q" disabled={busy} aria-labelledby={labelId}>
            <div className="uq-head" id={labelId}>
              {q.header ? <span className="uq-header">{q.header}</span> : null}
              <span className="uq-question">{codeSpans(q.question)}</span>
            </div>
            {q.options.length ? (
              <OptionRows
                question={q}
                picked={draft?.picked ?? []}
                labelledBy={labelId}
                onToggle={(label) => toggle(q, label)}
              />
            ) : null}
            {q.free ? (
              <input
                className="ch-field uq-other"
                type={q.secret ? 'password' : 'text'}
                value={draft?.other ?? ''}
                placeholder={q.options.length ? 'Or answer in your own words…' : 'Your answer…'}
                aria-label={`Answer to: ${q.question}`}
                onChange={(event) =>
                  update(q.key, q.multi ? { other: event.target.value } : { other: event.target.value, picked: [] })
                }
              />
            ) : null}
          </fieldset>
        );
      })}
      <div className="ap-actions">
        <button
          type="submit"
          className={`btn btn-warn${size}`}
          disabled={busy || !complete}
          data-testid="question-answer"
        >
          {busy && pending.choice === 'answer' ? 'Sending…' : questions.length > 1 ? 'Send answers' : 'Answer'}
        </button>
        <button type="button" className={`btn btn-ghost${size}`} disabled={busy} onClick={() => void decide('skip')}>
          {busy && pending.choice === 'skip' ? 'Skipping…' : 'Skip'}
        </button>
        {pending?.state === 'error' ? (
          <span className="ap-status ap-status-error" role="status">
            {pending.message}
          </span>
        ) : !complete && !busy ? (
          <span className="ap-status">
            {questions.length > 1 ? 'Answer every question to send' : 'Pick an answer or write one'}
          </span>
        ) : null}
      </div>
    </form>
  );
}
