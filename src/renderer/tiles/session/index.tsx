/**
 * Session tile: the live agent timeline of one attempt (coder, resolver, reviewer or planner).
 * Normalized agent events are folded into compact rows (timeline.ts); approvals render inline as peach cards
 * answered with the buttons or `a` / `A` / `d` while the tile has layout focus. The footer steers the session
 * (⏎ queue, ⌘⏎ now) and the header offers interrupt and take over.
 */
import type { Attempt, InboxItem, TaskNode } from '@shared/domain';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type CommandContext, registerCommands } from '../../app/commands';
import { openInbox } from '../../app/data';
import { useActivity, useData, useTask, useTaskNode, useTranscript } from '../../app/hooks';
import { prefersReducedMotion } from '../../app/prefs';
import { dataStore } from '../../app/store';
import { getSync } from '../../app/sync';
import { Icon } from '../../chrome/icons';
import { Chip } from '../../chrome/ui';
import { displayEngine, formatCost, formatTokens } from '../../layout/describe';
import { TileActions } from '../../layout/TileFrame';
import { focusedTile } from '../../layout/tree';
import type { TileCardProps, TileProps } from '../../layout/types';
import {
  clearNotice,
  interrupt,
  openApprovals,
  openTaskDiff,
  resolveApproval,
  resolveSessionAttempt,
  steer,
  takeOver,
  taskAttempts,
  useNotice,
  useSentMessages,
} from './actions';
import { ApprovalCard } from './approval';
import { Glyph } from './glyphs';
import { Row, type RowContext, SentRow } from './Rows';
import './session.css';
import { buildTimeline, type TimelineRow } from './timeline';

// ---------------------------------------------------------------------------------------------
// Keyboard: a / A / d answer the focused session's pending approval
// ---------------------------------------------------------------------------------------------

function focusedApproval(ctx: CommandContext) {
  if (ctx.ui.overlay || ctx.ui.keyMode !== 'normal' || !ctx.layout || !ctx.activeRunId) return null;
  if (ctx.ui.layoutMode !== 'strip' && ctx.ui.layoutMode !== 'focus') return null;
  const tile = focusedTile(ctx.layout);
  if (tile?.kind !== 'session') return null;
  const params = tile.params as { attemptId: string | null; taskId: string | null };
  return (
    openInbox(ctx.data.inbox, ctx.activeRunId).find(
      (i): i is Extract<InboxItem, { kind: 'approval' }> =>
        i.kind === 'approval' &&
        ((params.attemptId !== null && i.attemptId === params.attemptId) ||
          (params.taskId !== null && i.taskId === params.taskId)),
    ) ?? null
  );
}

registerCommands([
  {
    id: 'approval.accept',
    title: 'Accept the focused approval',
    category: 'Tile',
    keybinding: 'A',
    hidden: true,
    when: (ctx) => focusedApproval(ctx) !== null,
    run: (ctx) => {
      const item = focusedApproval(ctx);
      if (item) return resolveApproval(item, 'accept');
    },
  },
  {
    id: 'approval.acceptTask',
    title: 'Accept the focused approval for the whole task',
    category: 'Tile',
    keybinding: 'Shift+A',
    hidden: true,
    when: (ctx) => focusedApproval(ctx) !== null,
    run: (ctx) => {
      const item = focusedApproval(ctx);
      if (item) return resolveApproval(item, 'acceptTask');
    },
  },
  {
    id: 'approval.deny',
    title: 'Deny the focused approval',
    category: 'Tile',
    keybinding: 'D',
    hidden: true,
    when: (ctx) => focusedApproval(ctx) !== null,
    run: (ctx) => {
      const item = focusedApproval(ctx);
      if (item) return resolveApproval(item, 'deny');
    },
  },
]);

// ---------------------------------------------------------------------------------------------
// Scroll: pinned to the bottom unless the user scrolled up
// ---------------------------------------------------------------------------------------------

const PIN_SLACK = 36;

function useStickyScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    const reduced = prefersReducedMotion();
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const feed = feedRef.current;
    if (!el || !feed) return;
    el.scrollTop = el.scrollHeight;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
      if (atBottom !== pinnedRef.current) {
        pinnedRef.current = atBottom;
        setPinned(atBottom);
      }
    };
    // Content grows (streaming text, new rows, expanding output): stay at the bottom while pinned.
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(feed);
    observer.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  return { scrollRef, feedRef, pinned, toBottom };
}

// ---------------------------------------------------------------------------------------------
// The tile
// ---------------------------------------------------------------------------------------------

/** Rows rendered at once; older rows load in pages (each row also uses `content-visibility: auto`). */
const WINDOW = 160;

const ROLE_LABEL: Record<Attempt['role'], string> = {
  planner: 'planner · read-only',
  reviewer: 'reviewer · read-only',
  finalizer: 'final review · read-only',
  coder: 'coder',
  resolver: 'conflict resolver',
};

function attemptLabel(attempt: Attempt, attempts: readonly Attempt[]): string {
  const sameRole = attempts.filter((a) => a.role === attempt.role);
  const n = sameRole.indexOf(attempt) + 1;
  const base = attempt.role === 'coder' ? (n === 1 ? 'coder' : `fix ${n - 1}`) : attempt.role;
  return attempt.role !== 'coder' && sameRole.length > 1 ? `${base} ${n}` : base;
}

const EMPTY_APPROVALS: InboxItem[] = [];

export default function SessionTile({ tileId, runId, params, focused }: TileProps<'session'>) {
  const task = useTask(params.taskId);
  const attempts = useData(useShallow((s) => taskAttempts(s, task)));
  const [chosen, setChosen] = useState<string | null>(null);
  const fallback = useData((s) => resolveSessionAttempt(s, params));
  const attempt = (chosen ? attempts.find((a) => a.id === chosen) : null) ?? fallback;
  const node = useTaskNode(runId, task?.nodeId);

  const transcript = useTranscript(attempt?.id);
  const timeline = useMemo(() => buildTimeline(transcript.entries), [transcript.entries]);
  const approvalItems = useData(
    useShallow((s) =>
      attempt
        ? Object.values(s.inbox).filter(
            (i) =>
              i.kind === 'approval' &&
              i.runId === runId &&
              (i.attemptId === attempt.id || (i.attemptId === null && i.taskId === attempt.taskId)),
          )
        : EMPTY_APPROVALS,
    ),
  );
  const approvals = useMemo(() => {
    const map = new Map<string, InboxItem>();
    for (const item of approvalItems) if (item.kind === 'approval') map.set(item.payload.requestId, item);
    return map;
  }, [approvalItems]);
  const pendingExtra = useData(
    useShallow((s) =>
      openApprovals(s, runId, attempt).filter(
        (i) => !timeline.rows.some((r) => r.kind === 'approval' && r.requestId === i.payload.requestId),
      ),
    ),
  );

  const sent = useSentMessages(attempt?.id);
  const notice = useNotice(attempt?.id);
  const running = attempt?.status === 'running';
  const { scrollRef, feedRef, pinned, toBottom } = useStickyScroll();

  const [extra, setExtra] = useState(0);
  const start = Math.max(0, timeline.rows.length - WINDOW - extra);
  const rows = timeline.rows.slice(start);
  // Your steer messages sit between the rows that happened before and after them.
  const feed = useMemo(() => {
    const tsOf = new Map(transcript.entries.map((e) => [e.seq, e.ts]));
    const items: ({ kind: 'row'; row: TimelineRow } | { kind: 'sent'; message: (typeof sent)[number] })[] = [];
    let next = 0;
    for (const row of rows) {
      const ts = tsOf.get(row.key) ?? 0;
      while (next < sent.length && (sent[next] as (typeof sent)[number]).ts < ts)
        items.push({ kind: 'sent', message: sent[next++] as (typeof sent)[number] });
      items.push({ kind: 'row', row });
    }
    while (next < sent.length) items.push({ kind: 'sent', message: sent[next++] as (typeof sent)[number] });
    return items;
  }, [rows, sent, transcript.entries]);
  const growBy = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after older rows were prepended (`extra`).
  useLayoutEffect(() => {
    // Keep the viewport steady when older rows are prepended.
    const el = scrollRef.current;
    if (el && growBy.current !== null) {
      el.scrollTop += el.scrollHeight - growBy.current;
      growBy.current = null;
    }
  }, [extra, scrollRef]);

  const onOpenDiff = useCallback(
    () => (task ? openTaskDiff(runId, task.id, tileId) : undefined),
    [runId, task, tileId],
  );
  const ctx: RowContext = useMemo(
    () => ({
      engine: displayEngine(dataStore.getState(), attempt),
      running,
      focused,
      approvals,
      onOpenDiff: task ? onOpenDiff : null,
    }),
    [attempt, running, focused, approvals, task, onOpenDiff],
  );

  const cost = attempt?.costUsd ?? timeline.usage?.costUsd ?? null;
  const tokens =
    attempt?.inputTokens != null
      ? attempt.inputTokens + (attempt.outputTokens ?? 0)
      : timeline.usage
        ? timeline.usage.inputTokens + timeline.usage.outputTokens
        : null;
  const label = task?.nodeId ?? (attempt ? attempt.role : 'session');

  const doTakeOver = () => {
    if (!attempt) return;
    const el = scrollRef.current;
    const size = el
      ? {
          cols: Math.min(400, Math.max(80, Math.floor(el.clientWidth / 7.6))),
          rows: Math.min(200, Math.max(24, Math.floor(el.clientHeight / 15))),
        }
      : undefined;
    void takeOver(attempt, tileId, size);
  };

  return (
    <div className="ss" data-session-tile={tileId}>
      {attempt ? (
        <TileActions>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Take over in terminal"
            title="Take over in terminal"
            disabled={!attempt.sessionId}
            onClick={doTakeOver}
          >
            <Icon name="terminal" size={14} />
          </button>
        </TileActions>
      ) : null}

      {attempt ? (
        <div className="ss-sub mono">
          {attempt.role !== 'coder' ? (
            <Chip tone={attempt.role === 'reviewer' || attempt.role === 'finalizer' ? 'accent' : 'idle'}>
              {ROLE_LABEL[attempt.role]}
            </Chip>
          ) : null}
          {task?.branch ? (
            <span className="ss-sub-item ss-sub-branch" title={task.branch}>
              <Glyph name="branch" size={12} />
              <span className="ss-ellipsis">{task.branch}</span>
            </span>
          ) : null}
          {task?.startSha ? <span className="ss-sub-item ss-sub-sha">from {task.startSha.slice(0, 7)}</span> : null}
          {attempt.model || timeline.model ? (
            <span className="ss-sub-item ss-sub-model">{attempt.model ?? timeline.model}</span>
          ) : null}
          {cost !== null ? (
            <span className="ss-sub-item">{formatCost(cost)}</span>
          ) : tokens !== null ? (
            <span className="ss-sub-item">{formatTokens(tokens)}</span>
          ) : null}
          {attempts.length > 1 ? (
            <span className="ss-attempts" role="tablist" aria-label="Attempts">
              {attempts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={a.id === attempt.id}
                  className="ss-attempt"
                  onClick={() => setChosen(a.id)}
                  title={`${displayEngine(dataStore.getState(), a)} · ${a.status}`}
                >
                  <span
                    className={`dot${a.status === 'running' ? ' live' : ''}`}
                    style={{
                      color: displayEngine(dataStore.getState(), a) === 'codex' ? 'var(--teal)' : 'var(--mauve)',
                    }}
                  />
                  {attemptLabel(a, attempts)}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="ss-scroll" ref={scrollRef} data-testid="session-scroll">
        <div className="ss-feed" ref={feedRef}>
          {!attempt ? (
            <NotStarted node={node} status={task?.status ?? null} />
          ) : transcript.status === 'error' && transcript.entries.length === 0 ? (
            <div className="ss-empty">
              <span className="tl-bad">Couldn't load the transcript.</span>
              <span className="faint mono">{transcript.error}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void getSync()?.requestTranscript(attempt.id)}
              >
                Retry
              </button>
            </div>
          ) : transcript.status === 'loading' && transcript.entries.length === 0 ? (
            <div className="ss-skeleton" aria-hidden="true">
              {[72, 88, 54, 80].map((w) => (
                <div key={w} style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <>
              {start > 0 ? (
                <button
                  type="button"
                  className="ss-earlier"
                  onClick={() => {
                    growBy.current = scrollRef.current?.scrollHeight ?? null;
                    setExtra((n) => n + WINDOW);
                  }}
                >
                  Show {Math.min(start, WINDOW)} earlier events
                </button>
              ) : null}
              {rows.length === 0 && sent.length === 0 ? (
                <div className="ss-empty faint">
                  {running ? 'Waiting for the first event…' : 'No events recorded for this attempt.'}
                </div>
              ) : null}
              {feed.map((item, i) =>
                item.kind === 'row' ? (
                  <div className="ss-row" key={item.row.key}>
                    <Row row={item.row} ctx={ctx} last={i === feed.length - 1} />
                  </div>
                ) : (
                  <div className="ss-row" key={`you-${item.message.id}`}>
                    <SentRow message={item.message} attemptId={attempt.id} />
                  </div>
                ),
              )}
              {pendingExtra.map((item) => (
                <div className="ss-row" key={item.id}>
                  <ApprovalCard item={item} focused={focused} />
                </div>
              ))}
            </>
          )}
          {notice && attempt ? (
            <div className={`ss-notice ss-notice-${notice.tone}`} role="status">
              <span>{notice.text}</span>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Dismiss"
                onClick={() => clearNotice(attempt.id)}
              >
                <Glyph name="x" size={11} />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {!pinned ? (
        <button type="button" className="ss-jump" onClick={() => toBottom(true)} data-testid="jump-latest">
          <Glyph name="arrowDown" size={12} />
          Jump to latest
        </button>
      ) : null}

      {attempt ? <SteerBar attempt={attempt} label={label} running={running} onSent={() => toBottom(true)} /> : null}
    </div>
  );
}

function NotStarted({ node, status }: { node: TaskNode | null; status: string | null }) {
  if (!node) return <div className="ss-empty faint">No session yet.</div>;
  return (
    <div className="ss-plan">
      <div className="ss-plan-status faint">
        {status === 'blocked'
          ? 'Waiting for its dependencies'
          : status === 'queued'
            ? 'Queued for a slot'
            : 'Not started'}
        {node.dependsOn.length ? ` · after ${node.dependsOn.join(', ')}` : ''}
      </div>
      <p className="ss-plan-goal">{node.goal}</p>
      {node.acceptanceCriteria.length ? (
        <>
          <div className="sec">Acceptance</div>
          <ul className="ss-plan-list">
            {node.acceptanceCriteria.map((c) => (
              <li key={c.id}>
                <span className="mono faint">{c.id}</span> {c.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {node.touches.length ? (
        <>
          <div className="sec">Touches</div>
          <div className="ss-plan-touch mono">
            {node.touches.map((t) => (
              <span key={t.glob}>
                {t.glob} <span className="faint">{t.mode}</span>
              </span>
            ))}
          </div>
        </>
      ) : null}
      <div className="sec">Verify</div>
      <div className="ss-plan-touch mono">
        {node.verify.commands.map((c) => (
          <span key={c}>$ {c}</span>
        ))}
      </div>
    </div>
  );
}

function SteerBar({
  attempt,
  label,
  running,
  onSent,
}: {
  attempt: Attempt;
  label: string;
  running: boolean;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const inputId = `steer-${attempt.id}`;
  const send = (priority: 'now' | 'next') => {
    const value = text.trim();
    if (!value || !running) return;
    setText('');
    void steer(attempt.id, value, priority);
    onSent();
  };
  return (
    <form
      className="ss-steer"
      onSubmit={(event) => {
        event.preventDefault();
        send('next');
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Message {label}
      </label>
      <input
        id={inputId}
        className="ss-input"
        value={text}
        disabled={!running}
        placeholder={running ? `Steer ${label}…` : `${label} is not running`}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send('now');
          }
        }}
      />
      {running ? (
        <>
          <span className="ss-keys" aria-hidden="true">
            <span className="kbd">⏎ queue</span>
            <span className="kbd">⌘⏎ now</span>
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Interrupt"
            title="Interrupt the current turn"
            onClick={() => void interrupt(attempt.id)}
          >
            <Glyph name="stop" size={11} fill="currentColor" strokeWidth={1.5} />
          </button>
        </>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview card: last three activity lines, live
// ---------------------------------------------------------------------------------------------

/** `mcp__legion__report_progress …` → `legion · report progress …` */
function prettyLine(line: string): string {
  return line.replace(
    /mcp__([\w-]+?)__(\w+)/,
    (_m, server: string, tool: string) => `${server} · ${tool.replace(/_/g, ' ')}`,
  );
}

export function Card({ runId, params }: TileCardProps<'session'>) {
  const attempt = useData((s) => resolveSessionAttempt(s, params));
  const task = useTask(params.taskId);
  const node = useTaskNode(runId, task?.nodeId);
  const activity = useActivity(attempt?.id);
  const pending = useData((s) => openApprovals(s, runId, attempt).length);
  const lines = activity.slice(-3).map(prettyLine);
  if (lines.length === 0) {
    const facts = attempt
      ? ['waiting for the first event…']
      : node
        ? [
            node.dependsOn.length ? `after ${node.dependsOn.join(', ')}` : 'no dependencies',
            node.touches.length ? `touches ${node.touches.map((t) => t.glob).join(', ')}` : node.goal,
            node.verify.commands.length ? `verify: ${node.verify.commands.join(' && ')}` : '',
          ]
        : ['not started yet'];
    return (
      <>
        {facts.filter(Boolean).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </>
    );
  }
  return (
    <>
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional lines
          key={i}
          style={
            pending && i === lines.length - 1 && line.startsWith('approval') ? { color: 'var(--peach)' } : undefined
          }
        >
          {line}
        </div>
      ))}
    </>
  );
}
