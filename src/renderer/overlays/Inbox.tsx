/**
 * Inbox (⌘I): every open item across runs, sorted by what it unblocks, each actionable in place.
 * Keys: j/k (↑/↓) select, a / ⇧A / d answer an approval, ⏎ jumps to the item's tile.
 */
import type { InboxItem, InboxItemOf, InboxResolution } from '@shared/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { latestPlan } from '../app/data';
import { rpc, useAgentsRunning, useData, useInbox } from '../app/hooks';
import { isTextInput } from '../app/keys';
import { Icon } from '../chrome/icons';
import { Chip, Kbd } from '../chrome/ui';
import { displayEngine, formatCost, formatDuration, type Tone } from '../layout/describe';
import { type ApprovalChoice, resolveApproval, trackResolution, usePendingResolution } from '../tiles/session/actions';
import { ApprovalButtons, ApprovalSubjectView, describeApproval } from '../tiles/session/approval';
import {
  approveGatedMerge,
  canStartOver,
  resolveEscalation,
  retryChoice,
  startOver,
  useMergeGate,
} from '../tiles/session/escalation';
import {
  type InboxSelection,
  moveSelection,
  NO_SELECTION,
  type RankedItem,
  rankInbox,
  runLabel,
  selectAt,
  selectedIndex,
} from './inbox-model';
import { jumpToItem } from './nav';
import { OverlayPanel } from './Shell';

const KIND_CHIP: Record<InboxItem['kind'], { label: string; tone: Tone }> = {
  approval: { label: 'approval', tone: 'warn' },
  question: { label: 'question', tone: 'accent' },
  plan_signoff: { label: 'plan', tone: 'claude' },
  escalation: { label: 'escalation', tone: 'bad' },
  conflict: { label: 'conflict', tone: 'bad' },
  pr_ready: { label: 'PR', tone: 'ok' },
  budget: { label: 'budget', tone: 'warn' },
};

function resolve(item: InboxItem, resolution: InboxResolution, choice: ApprovalChoice = 'accept') {
  return trackResolution(item.id, choice, () => rpc('inbox.resolve', { itemId: item.id, resolution }));
}

export function InboxOverlay() {
  const items = useInbox(null);
  const state = useData((s) => s);
  const ranked = useMemo(() => rankInbox(state, items), [state, items]);
  const agents = useAgentsRunning();
  // Selected by item id: a new or resolved item re-sorting above it must not change what `a` approves.
  const [selection, setSelection] = useState<InboxSelection>(NO_SELECTION);
  const listRef = useRef<HTMLDivElement>(null);
  const index = selectedIndex(ranked, selection);
  const current = ranked[index]?.item ?? null;

  // Pin the shown row by id (first render, or after the selected item left the list).
  useEffect(() => {
    const id = current?.id ?? null;
    if (id !== selection.id || index !== selection.index) setSelection({ id, index });
  }, [current, index, selection]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [index]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextInput(event.target)) return;
    const key = event.key;
    // A held key repeats: fine for moving the selection, never for answering or jumping.
    if (event.repeat && !['j', 'k', 'ArrowDown', 'ArrowUp'].includes(key)) {
      if (['a', 'A', 'd', 'Enter'].includes(key)) event.preventDefault();
      return;
    }
    if (key === 'j' || key === 'ArrowDown') setSelection(moveSelection(ranked, selection, 1));
    else if (key === 'k' || key === 'ArrowUp') setSelection(moveSelection(ranked, selection, -1));
    else if (key === 'Enter' && current && (event.target as HTMLElement).tagName !== 'BUTTON') jumpToItem(current);
    else if (current?.kind === 'approval' && (key === 'a' || key === 'A' || key === 'd')) {
      void resolveApproval(current, key === 'd' ? 'deny' : event.shiftKey || key === 'A' ? 'acceptTask' : 'accept');
    } else return;
    event.preventDefault();
  };

  const quiet = `${agents.running} agent${agents.running === 1 ? '' : 's'} working`;
  return (
    <OverlayPanel label="Inbox" placement="right" width={460} top={52} testId="inbox" onKeyDown={onKeyDown}>
      <div className="ovl-head">
        <span className="ovl-title">Needs you</span>
        {ranked.length ? <Chip tone="warn">{ranked.length}</Chip> : null}
        <span className="ovl-head-note">sorted by what it unblocks</span>
      </div>
      {ranked.length === 0 ? (
        <div className="ib-empty" data-testid="inbox-empty">
          <span className="ib-empty-mark">
            <Icon name="check" size={18} strokeWidth={2.4} />
          </span>
          <span className="ib-empty-title">Everything is quiet</span>
          <span className="faint">{quiet}. New approvals and questions land here.</span>
        </div>
      ) : (
        <>
          <div className="ib-list" ref={listRef} role="listbox" aria-label="Inbox items" tabIndex={0} data-autofocus>
            {ranked.map((entry, i) => (
              <InboxRow
                key={entry.item.id}
                entry={entry}
                index={i}
                selected={i === index}
                onSelect={() => setSelection(selectAt(ranked, i))}
              />
            ))}
          </div>
          <div className="ovl-foot">
            <span>Everything else is quiet: {quiet}.</span>
            <span className="ovl-keys">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> select <Kbd>⏎</Kbd> jump
            </span>
          </div>
        </>
      )}
    </OverlayPanel>
  );
}

function InboxRow({
  entry,
  index,
  selected,
  onSelect,
}: {
  entry: RankedItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { item } = entry;
  const run = useData((s) => s.runs[item.runId] ?? null);
  const task = useData((s) => (item.taskId ? (s.tasks[item.taskId] ?? null) : null));
  const engine = useData((s) => {
    const attempt = item.attemptId ? s.attempts[item.attemptId] : null;
    return attempt ? displayEngine(s, attempt) : null;
  });
  const pending = usePendingResolution(item.id);
  const chip = KIND_CHIP[item.kind];
  const context = [run ? runLabel(run.title) : null, task?.nodeId ?? null, engine].filter(Boolean).join(' · ');
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the list (j/k)
    <div
      className="ib-item"
      role="option"
      aria-selected={selected}
      data-index={index}
      data-kind={item.kind}
      data-testid="inbox-item"
      tabIndex={-1}
      onClick={onSelect}
    >
      <div className="ib-meta">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="muted ib-context">{context}</span>
        <span className="faint ib-blocks">{entry.blocksLabel ?? formatDuration(Date.now() - item.createdAt)}</span>
      </div>
      <ItemBody item={item} selected={selected} taskLabel={task?.nodeId ?? null} />
      {pending?.state === 'error' ? <div className="ib-error">{pending.message}</div> : null}
    </div>
  );
}

function JumpButton({ item, label = 'Jump to tile' }: { item: InboxItem; label?: string }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm ib-jump" onClick={() => jumpToItem(item)}>
      {label}
      <Icon name="arrowRight" size={12} />
    </button>
  );
}

function ItemBody({ item, selected, taskLabel }: { item: InboxItem; selected: boolean; taskLabel: string | null }) {
  switch (item.kind) {
    case 'approval': {
      const subject = describeApproval(item.payload.tool, item.payload.input);
      return (
        <>
          <ApprovalSubjectView subject={subject} compact />
          <div className="ib-actions">
            <ApprovalButtons item={item} showKeys={selected} compact />
            <JumpButton item={item} />
          </div>
        </>
      );
    }
    case 'question':
      return <QuestionBody item={item} selected={selected} />;
    case 'plan_signoff':
      return <PlanBody item={item} selected={selected} />;
    case 'escalation':
      return <EscalationBody item={item} taskLabel={taskLabel} />;
    case 'conflict':
      return (
        <>
          <div className="ib-text">{item.payload.summary}</div>
          <div className="ib-files mono">
            {item.payload.files.slice(0, 4).map((f) => (
              <span key={f}>{f}</span>
            ))}
            {item.payload.files.length > 4 ? (
              <span className="faint">+{item.payload.files.length - 4} more</span>
            ) : null}
          </div>
          <div className="ib-actions">
            <button
              type="button"
              className="btn btn-sm btn-warn"
              onClick={() => void resolve(item, { kind: 'conflict', action: 'retry', note: null })}
            >
              Retry resolver
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void resolve(item, { kind: 'conflict', action: 'skip', note: null })}
            >
              Skip task
            </button>
            <JumpButton item={item} />
          </div>
        </>
      );
    case 'pr_ready':
      return <PrBody item={item} selected={selected} />;
    case 'budget': {
      const { spentUsd, limitUsd } = item.payload;
      const pct = Math.min(100, (spentUsd / Math.max(0.01, limitUsd)) * 100);
      const raised = Math.ceil(limitUsd * 1.5);
      return (
        <>
          <div className="ib-text">
            {formatCost(spentUsd)} of {formatCost(limitUsd)} spent
          </div>
          <span className="ib-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
          <div className="ib-actions">
            <button
              type="button"
              className={`btn btn-sm${selected ? ' btn-warn' : ''}`}
              onClick={() => void resolve(item, { kind: 'budget', action: 'raise', newLimitUsd: raised })}
            >
              Raise to {formatCost(raised)}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void resolve(item, { kind: 'budget', action: 'stop', newLimitUsd: null })}
            >
              Stop run
            </button>
          </div>
        </>
      );
    }
  }
}

function QuestionBody({ item, selected }: { item: InboxItemOf<'question'>; selected: boolean }) {
  const questions = item.payload.questions;
  const first = questions[0];
  const [answer, setAnswer] = useState('');
  if (item.payload.source === 'clarify' || questions.length !== 1 || !first)
    return (
      <>
        <div className="ib-text">{first?.question ?? 'The planner has questions.'}</div>
        {questions.length > 1 ? (
          <div className="faint ib-sub">
            +{questions.length - 1} more question{questions.length > 2 ? 's' : ''} before the plan is drafted
          </div>
        ) : null}
        <div className="ib-actions">
          <button
            type="button"
            className={`btn btn-sm${selected ? ' btn-primary' : ''}`}
            onClick={() => jumpToItem(item)}
          >
            Answer
            <Icon name="arrowRight" size={12} />
          </button>
        </div>
      </>
    );
  const send = (text: string) =>
    void resolve(item, { kind: 'question', answers: [{ questionId: first.id, answer: text }] });
  return (
    <>
      <div className="ib-text">{first.question}</div>
      {first.options.length ? (
        <div className="ib-options">
          {first.options.map((option) => (
            <button key={option} type="button" className="opt-chip" onClick={() => send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="ib-answer"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) send(answer.trim());
        }}
      >
        <input
          className="field field-sm"
          value={answer}
          placeholder="Answer…"
          onChange={(event) => setAnswer(event.target.value)}
        />
        <button type="submit" className="btn btn-sm" disabled={!answer.trim()}>
          Send
        </button>
      </form>
    </>
  );
}

function EscalationBody({ item, taskLabel }: { item: InboxItemOf<'escalation'>; taskLabel: string | null }) {
  const gate = useMergeGate(item);
  return (
    <>
      <div className="ib-text">{item.payload.summary}</div>
      <div className="ib-actions">
        {gate ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            title="It passed review: merge it into the integration branch"
            onClick={() => void approveGatedMerge(item)}
            data-testid="inbox-approve-merge"
          >
            Approve merge
          </button>
        ) : null}
        {item.payload.actions
          .filter((a) => a !== 'edit')
          .map((action) => (
            <button
              key={action}
              type="button"
              className={`btn btn-sm${action === 'retry' ? ' btn-warn' : action === 'abort' ? ' btn-ghost' : ''}`}
              title={action === 'retry' ? retryChoice(item).title : undefined}
              onClick={() => void resolveEscalation(item, action, null)}
            >
              {action === 'retry' ? retryChoice(item).label : action === 'skip' ? 'Skip task' : 'Abort run'}
            </button>
          ))}
        {canStartOver(item) ? (
          <button
            type="button"
            className="btn btn-sm"
            title="Discard the work and start the task over from scratch"
            onClick={() => void startOver(item, taskLabel ?? 'this task')}
            data-testid="inbox-restart"
          >
            Start over…
          </button>
        ) : null}
        {/* "edit" (retry with a note) and the gate's "request changes" are written in the task's tile. */}
        <JumpButton
          item={item}
          label={
            gate ? 'Request changes' : item.payload.actions.includes('edit') ? 'Retry with a note' : 'Jump to tile'
          }
        />
      </div>
    </>
  );
}

function PlanBody({ item, selected }: { item: InboxItemOf<'plan_signoff'>; selected: boolean }) {
  const plan = useData((s) => latestPlan(s, item.runId));
  const nodes = plan?.dag.nodes.length ?? 0;
  const estimate = plan?.dag.annotations.find((a) => a.kind === 'cost_estimate')?.message.replace(/^est\.\s*/, '');
  const overlaps = plan?.dag.annotations.filter((a) => a.kind === 'serializing_edge').length ?? 0;
  const facts = [
    `${nodes} task${nodes === 1 ? '' : 's'}`,
    estimate ? `est. ${estimate}` : null,
    overlaps ? `${overlaps} overlap${overlaps === 1 ? '' : 's'} auto-serialized` : null,
  ].filter(Boolean);
  return (
    <>
      {item.payload.amendment ? (
        <>
          <div className="ib-text">
            The lead wants to change the approved plan (v{item.payload.version}): {item.payload.amendment.change}
          </div>
          <div className="faint ib-sub">Needs you: {item.payload.amendment.reason}</div>
        </>
      ) : (
        <>
          <div className="ib-text">Plan v{item.payload.version} ready for sign-off</div>
          <div className="faint ib-sub">{facts.join(' · ')}</div>
        </>
      )}
      <div className="ib-actions">
        <button
          type="button"
          className={`btn btn-sm${selected ? ' btn-primary' : ''}`}
          onClick={() => jumpToItem(item)}
        >
          Review plan
          <Icon name="arrowRight" size={12} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void resolve(item, { kind: 'plan_signoff', approved: true, feedback: null })}
        >
          Approve as is
        </button>
      </div>
    </>
  );
}

function PrBody({ item, selected }: { item: InboxItemOf<'pr_ready'>; selected: boolean }) {
  const counts = useData((s) => {
    const tasks = Object.values(s.tasks).filter((t) => t.runId === item.runId);
    return `${tasks.filter((t) => t.status === 'merged').length}/${tasks.length}`;
  });
  return (
    <>
      <div className="ib-text">Draft PR ready: {item.payload.title}</div>
      <div className="faint ib-sub mono">
        {counts} tasks merged · {item.payload.integrationBranch}
      </div>
      <div className="ib-actions">
        <button
          type="button"
          className={`btn btn-sm${selected ? ' btn-primary' : ''}`}
          onClick={() => void resolve(item, { kind: 'pr_ready', approved: true, title: null, body: null })}
        >
          Open draft PR
        </button>
        <JumpButton item={item} label="Review first" />
      </div>
    </>
  );
}
