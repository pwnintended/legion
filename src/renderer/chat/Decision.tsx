/**
 * Decisions in the conversation: every inbox item of the run, where it happened. Open, it is a card the human
 * answers in place (the same resolutions as the agents' tiles); answered, it folds into a one-line receipt.
 */
import type { InboxItem, InboxItemOf, InboxResolution } from '@shared/domain';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../app/confirm';
import { latestPlan, tasksOfRun } from '../app/data';
import { rpc, useData } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { Icon } from '../chrome/icons';
import { Chip, Kbd } from '../chrome/ui';
import { formatClock, formatCost, type Tone } from '../layout/describe';
import { jumpToItem } from '../overlays/nav';
import ClarifyTile from '../tiles/clarify/index';
import { approvePlan, requestRevision, useSignoff } from '../tiles/plan/actions';
import { trackResolution, usePendingResolution } from '../tiles/session/actions';
import { ApprovalButtons, ApprovalSubjectView, describeApproval } from '../tiles/session/approval';
import {
  approveGatedMerge,
  canStartOver,
  type EscalationItem,
  requestGateChanges,
  resolveEscalation,
  retryChoice,
  startOver,
  useMergeGate,
} from '../tiles/session/escalation';
import { Markdown } from '../tiles/session/Markdown';
import { agentLabel, DECISION_TITLE, receiptText, receiptTone } from './labels';
import { AgentName } from './Presentation';

function resolve(item: InboxItem, resolution: InboxResolution, choice = 'accept') {
  return trackResolution(item.id, choice, () => rpc('inbox.resolve', { itemId: item.id, resolution }));
}

/** Stopping from a card ends the run for good, as the rail's Stop does: ask first. */
function confirmStop(runTitle: string | null): Promise<boolean> {
  return confirmAction({
    title: runTitle ? `Stop “${runTitle}”?` : 'Stop this run?',
    body: [
      'Every agent of this run stops now and unfinished tasks are cancelled.',
      'Merged work, worktrees and branches stay; archive the run afterwards to clean them up. A stopped run cannot be resumed.',
    ],
    confirmLabel: 'Stop run',
    tone: 'danger',
  });
}

function useRunTitle(runId: string): string | null {
  return useData((s) => s.runs[runId]?.title ?? null);
}

/** An answered card folds into its receipt (height and opacity; instant with reduced motion). */
export function Decision({ item }: { item: InboxItem }) {
  const reduced = useReducedMotionPref();
  const answered = item.resolvedAt !== null;
  const transition = { duration: reduced ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] as const };
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={answered ? 'receipt' : 'card'}
        className="ch-fold"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={transition}
      >
        {answered ? <Receipt item={item} /> : <DecisionCard item={item} />}
      </motion.div>
    </AnimatePresence>
  );
}

/** An open card waits on the human, so its kind reads peach; only a failure (escalation, conflict) reads red. */
const KIND_TONE: Record<InboxItem['kind'], Tone> = {
  approval: 'warn',
  question: 'warn',
  plan_signoff: 'warn',
  escalation: 'bad',
  conflict: 'bad',
  pr_ready: 'warn',
  budget: 'warn',
};

/** The task an item is about, as the conversation names it (`T3`). */
function useTaskLabel(item: InboxItem): string | null {
  return useData((s) => (item.taskId ? (s.tasks[item.taskId]?.nodeId ?? null) : null));
}

function Receipt({ item }: { item: InboxItem }) {
  const task = useTaskLabel(item);
  const tone = receiptTone(item);
  return (
    <div className="ch-receipt" data-tone={tone} data-kind={item.kind} data-testid="chat-receipt">
      <span className="ch-receipt-mark" aria-hidden="true">
        <Icon name={tone === 'bad' ? 'close' : tone === 'ok' ? 'check' : 'clock'} size={11} strokeWidth={2.6} />
      </span>
      <span className="ch-receipt-text">{receiptText(item, task)}</span>
      <time className="ch-time">{formatClock(item.resolvedAt ?? item.createdAt)}</time>
    </div>
  );
}

function DecisionCard({ item }: { item: InboxItem }) {
  const agent = useData(useShallow((s) => (item.attemptId ? agentLabel(s, item.attemptId) : null)));
  const pending = usePendingResolution(item.id);
  return (
    <section
      className="ch-card ch-decision"
      data-kind={item.kind}
      aria-label={`${DECISION_TITLE[item.kind]} waiting for you`}
      data-testid="chat-decision"
    >
      <header className="ch-card-head">
        <Chip tone={KIND_TONE[item.kind]}>{DECISION_TITLE[item.kind]}</Chip>
        {agent ? <AgentName agent={agent} /> : null}
        <time className="ch-time">{formatClock(item.createdAt)}</time>
        <button
          type="button"
          className="ch-icon-btn"
          title="Show it among the agents"
          aria-label="Show it among the agents"
          onClick={() => jumpToItem(item)}
        >
          <Icon name="agents" size={13} />
        </button>
      </header>
      <DecisionBody item={item} />
      {pending?.state === 'error' ? (
        <div className="ch-error" role="alert">
          {pending.message}
        </div>
      ) : null}
    </section>
  );
}

function DecisionBody({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'approval':
      return <ApprovalBody item={item} />;
    case 'question':
      return item.payload.source === 'clarify' ? (
        <div className="ch-embed">
          <ClarifyTile
            runId={item.runId}
            tileId={`chat-clarify-${item.id}`}
            kind="clarify"
            params={{ inboxItemId: item.id }}
            focused={false}
            visible
          />
        </div>
      ) : (
        <QuestionBody item={item} />
      );
    case 'plan_signoff':
      return <PlanBody item={item} />;
    case 'escalation':
    case 'conflict':
      return <EscalationBody item={item} />;
    case 'pr_ready':
      return <PrBody item={item} />;
    case 'budget':
      return <BudgetBody item={item} />;
  }
}

function ApprovalBody({ item }: { item: InboxItemOf<'approval'> }) {
  const subject = describeApproval(item.payload.tool, item.payload.input);
  return (
    <div className="ch-card-body">
      <ApprovalSubjectView subject={subject} />
      {item.payload.reason ? <p className="ch-note">{item.payload.reason}</p> : null}
      <ApprovalButtons item={item} showKeys={false} compact />
    </div>
  );
}

function QuestionBody({ item }: { item: InboxItemOf<'question'> }) {
  const question = item.payload.questions[0];
  const [answer, setAnswer] = useState('');
  const pending = usePendingResolution(item.id);
  if (!question) return null;
  const send = (text: string) =>
    void resolve(item, { kind: 'question', answers: [{ questionId: question.id, answer: text }] }, 'answer');
  return (
    <div className="ch-card-body">
      <p className="ch-question">{question.question}</p>
      {question.options.length ? (
        <div className="ch-options">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className="opt-chip"
              disabled={pending?.state === 'pending'}
              onClick={() => send(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="ch-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) send(answer.trim());
        }}
      >
        <input
          className="ch-field"
          value={answer}
          placeholder={question.options.length ? 'Or answer in your own words…' : 'Your answer…'}
          aria-label="Your answer"
          onChange={(event) => setAnswer(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={!answer.trim() || pending?.state === 'pending'}
        >
          Answer
        </button>
      </form>
    </div>
  );
}

function PlanBody({ item }: { item: InboxItemOf<'plan_signoff'> }) {
  const plan = useData((s) => latestPlan(s, item.runId));
  const signoff = useSignoff(item.runId);
  const itemPending = usePendingResolution(item.id);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const amendment = item.payload.amendment ?? null;
  const nodes = plan?.dag.nodes ?? [];
  const estimate = plan?.dag.annotations.find((a) => a.kind === 'cost_estimate')?.message.replace(/^est\.\s*/, '');
  const busy = signoff.pending !== null || itemPending?.state === 'pending';

  const approve = () =>
    amendment
      ? void resolve(item, { kind: 'plan_signoff', approved: true, feedback: null }, 'approve')
      : void approvePlan(item.runId);
  const revise = () => {
    const text = feedback.trim();
    if (!text) return;
    if (amendment) void resolve(item, { kind: 'plan_signoff', approved: false, feedback: text }, 'revise');
    else void requestRevision(item.runId, text);
  };

  return (
    <div className="ch-card-body">
      {amendment ? (
        <>
          <p className="ch-lede">The lead wants to change the approved plan: {amendment.change}</p>
          <p className="ch-note">It needs you because {amendment.reason}</p>
        </>
      ) : (
        <p className="ch-lede">
          Plan v{item.payload.version} is ready: {nodes.length} task{nodes.length === 1 ? '' : 's'}
          {estimate ? <span className="ch-dim"> · est. {estimate}</span> : null}
        </p>
      )}
      {nodes.length ? (
        <ol className="ch-plan">
          {nodes.map((node) => (
            <li key={node.id}>
              <span className="ch-plan-id mono">{node.id}</span>
              <span className="ch-plan-title">{node.title}</span>
              <span className="ch-plan-meta mono">
                {node.dependsOn.length ? `after ${node.dependsOn.join(', ')}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {revising ? (
        <form
          className="ch-revise"
          onSubmit={(event) => {
            event.preventDefault();
            revise();
          }}
        >
          <textarea
            className="ch-field ch-textarea"
            value={feedback}
            rows={3}
            placeholder="What should change? The planner revises the plan and asks you again."
            aria-label="What should change in the plan"
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                revise();
              }
            }}
            // biome-ignore lint/a11y/noAutofocus: opened by the user's click to write the feedback
            autoFocus
          />
          <div className="ch-actions">
            <button type="submit" className="btn btn-sm" disabled={!feedback.trim() || busy}>
              {signoff.pending === 'revise' ? 'Sending…' : 'Ask for changes'}
              <Kbd>⌘⏎</Kbd>
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevising(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="ch-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={approve}
            data-testid="chat-plan-approve"
          >
            {signoff.pending === 'approve' || itemPending?.state === 'pending' ? 'Approving…' : 'Approve plan'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setRevising(true)}>
            Ask for changes
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => jumpToItem(item)}>
            Read the full plan
            <Icon name="arrowRight" size={12} />
          </button>
        </div>
      )}
      {signoff.error ? <div className="ch-error">{signoff.error}</div> : null}
    </div>
  );
}

function EscalationBody({ item }: { item: EscalationItem }) {
  const task = useTaskLabel(item);
  const gate = useMergeGate(item);
  const pending = usePendingResolution(item.id);
  const [note, setNote] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const busy = pending?.state === 'pending';
  const label = task ?? 'this task';
  // The usual answers stay in view; starting over, skipping and stopping are rarer (and final), one step away.
  const canSkip = item.kind === 'conflict' || item.payload.actions.includes('skip');
  const canAbort = item.kind === 'escalation' && item.payload.actions.includes('abort');
  const hasMore = canStartOver(item) || canSkip || canAbort;
  const runTitle = useRunTitle(item.runId);
  return (
    <div className="ch-card-body">
      <p className="ch-lede">{item.payload.summary}</p>
      {item.kind === 'conflict' && item.payload.files.length ? (
        <div className="ch-files mono">
          {item.payload.files.slice(0, 5).map((f) => (
            <span key={f}>{f}</span>
          ))}
          {item.payload.files.length > 5 ? <span className="ch-dim">+{item.payload.files.length - 5} more</span> : null}
        </div>
      ) : null}
      {note !== null ? (
        <form
          className="ch-revise"
          onSubmit={(event) => {
            event.preventDefault();
            const text = note.trim();
            if (!text) return;
            if (gate) void requestGateChanges(item, text);
            else void resolveEscalation(item, 'edit', text);
          }}
        >
          <textarea
            className="ch-field ch-textarea"
            rows={3}
            value={note}
            placeholder={gate ? 'What should the coder change before it merges?' : 'A note for the next attempt…'}
            aria-label="Note"
            onChange={(event) => setNote(event.target.value)}
            // biome-ignore lint/a11y/noAutofocus: opened by the user's click to write the note
            autoFocus
          />
          <div className="ch-actions">
            <button type="submit" className="btn btn-sm btn-warn" disabled={!note.trim() || busy}>
              {gate ? 'Send back with changes' : 'Retry with this note'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNote(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="ch-actions">
          {gate ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void approveGatedMerge(item)}
              data-testid="chat-approve-merge"
            >
              Approve merge
            </button>
          ) : null}
          {item.kind === 'conflict' || item.payload.actions.includes('retry') ? (
            <button
              type="button"
              className={`btn btn-sm${gate ? '' : ' btn-warn'}`}
              disabled={busy}
              title={retryChoice(item).title}
              onClick={() => void resolveEscalation(item, 'retry', null)}
            >
              {retryChoice(item).label}
            </button>
          ) : null}
          {gate || (item.kind === 'escalation' && item.payload.actions.includes('edit')) ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setNote('')}>
              {gate ? 'Request changes' : 'Retry with a note'}
            </button>
          ) : null}
          {more && canStartOver(item) ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void startOver(item, label)}>
              Start over…
            </button>
          ) : null}
          {more && canSkip ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void resolveEscalation(item, 'skip', null)}
            >
              Skip {label}
            </button>
          ) : null}
          {more && canAbort ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost ch-end-run"
              disabled={busy}
              onClick={async () => {
                if (await confirmStop(runTitle)) void resolveEscalation(item, 'abort', null);
              }}
            >
              Stop the run
            </button>
          ) : null}
          {hasMore ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost ch-more-toggle"
              aria-expanded={more}
              onClick={() => setMore((v) => !v)}
            >
              {more ? 'Fewer' : 'More'}
              <Icon name="chevronDown" size={12} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PrBody({ item }: { item: InboxItemOf<'pr_ready'> }) {
  const pending = usePendingResolution(item.id);
  const counts = useData(
    useShallow((s) => {
      const tasks = tasksOfRun(s.tasks, item.runId);
      return { merged: tasks.filter((t) => t.status === 'merged').length, total: tasks.length };
    }),
  );
  const [open, setOpen] = useState(false);
  const body = item.payload.body.trim();
  return (
    <div className="ch-card-body">
      <p className="ch-lede">{item.payload.title}</p>
      <p className="ch-note mono">
        {counts.merged}/{counts.total} tasks merged · {item.payload.integrationBranch}
      </p>
      {body ? (
        <div className="ch-pr-body" data-open={open}>
          <Markdown text={body} streaming={false} caret={false} />
          {!open ? (
            <button type="button" className="ch-more" onClick={() => setOpen(true)}>
              Show the whole description
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="ch-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending?.state === 'pending'}
          onClick={() => void resolve(item, { kind: 'pr_ready', approved: true, title: null, body: null }, 'open')}
          data-testid="chat-create-pr"
        >
          {pending?.state === 'pending' ? 'Opening…' : 'Open draft pull request'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => jumpToItem(item)}>
          Edit title and description
          <Icon name="arrowRight" size={12} />
        </button>
      </div>
    </div>
  );
}

function BudgetBody({ item }: { item: InboxItemOf<'budget'> }) {
  const { spentUsd, limitUsd } = item.payload;
  const raised = Math.ceil(limitUsd * 1.5);
  const pending = usePendingResolution(item.id);
  const busy = pending?.state === 'pending';
  const runTitle = useRunTitle(item.runId);
  return (
    <div className="ch-card-body">
      <p className="ch-lede">
        {formatCost(spentUsd)} of {formatCost(limitUsd)} spent. Agents stay paused until you decide.
      </p>
      <div className="ch-actions">
        <button
          type="button"
          className="btn btn-sm btn-warn"
          disabled={busy}
          onClick={() => void resolve(item, { kind: 'budget', action: 'raise', newLimitUsd: raised }, 'raise')}
        >
          {pending?.state === 'pending' && pending.choice === 'raise' ? 'Raising…' : `Raise to ${formatCost(raised)}`}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost ch-end-run"
          disabled={busy}
          onClick={async () => {
            if (await confirmStop(runTitle)) {
              void resolve(item, { kind: 'budget', action: 'stop', newLimitUsd: null }, 'stop');
            }
          }}
        >
          Stop the run
        </button>
      </div>
    </div>
  );
}
