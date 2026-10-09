/**
 * A run's conversation, the body of its tile on the project board: one column of the human's messages, the
 * assistant's replies (with what its agents told it folded underneath), the decisions waiting on the human as
 * cards, what agents presented, and the run's milestones; the progress strip above and the reply box below.
 * A direct session reads the same, its agent in the assistant's place with its tool calls between its words,
 * and no progress strip (there is no plan).
 * The tile's head carries the run's title. The agents themselves stay in the Agents view (⌘E).
 */
import type { Attempt, Run } from '@shared/domain';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { runPr } from '../app/compat';
import {
  attemptsOfRun,
  latestPlan,
  mergesOfRun,
  messagesOfRun,
  presentationsOfRun,
  runCost,
  tasksOfRun,
  transcriptEntries,
} from '../app/data';
import { useData, useTranscript, useUi } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { actions } from '../app/store';
import { ChipList, chipOfRef } from '../attachments/Attachments';
import { Icon } from '../chrome/icons';
import { Chip } from '../chrome/ui';
import { displayEngine, formatCost, formatDuration, formatStamp } from '../layout/describe';
import { useSentMessages } from '../tiles/session/actions';
import { Markdown } from '../tiles/session/Markdown';
import { type RowContext, Row as TimelineRowView } from '../tiles/session/Rows';
import { buildTimeline, type TimelineRow } from '../tiles/session/timeline';
import '../tiles/session/session.css';
import { ChatComposer } from './Composer';
import { Decision } from './Decision';
import { agentLabel, decisionTitle } from './labels';
import { AgentName, Presentation } from './Presentation';
import { Progress } from './Progress';
import {
  assistantAttempts,
  assistantBusy,
  buildThread,
  isSessionRun,
  liveAssistant,
  openDecisionItems,
  type PendingMessage,
  type ThreadItem,
} from './thread';
import './chat.css';
import { formatChord } from '../app/keys';

const EMPTY: never[] = [];

/** The last `chatFocus` request brought into view; kept across remounts so a returning view does not replay it. */
let consumedFocus = 0;

/** Keeps an assistant attempt's transcript loaded while the conversation is on screen. */
function KeepTranscript({ attemptId }: { attemptId: string }) {
  useTranscript(attemptId);
  return null;
}

function useInboxOfRun(runId: string) {
  return useData(
    useShallow((s) =>
      Object.values(s.inbox)
        .filter((i) => i.runId === runId)
        .sort((a, b) => a.createdAt - b.createdAt),
    ),
  );
}

function useThreadOf(run: Run) {
  const attempts = useData((s) => attemptsOfRun(s.attempts, run.id));
  const assistants = useMemo(() => assistantAttempts(attempts), [attempts]);
  const transcripts = useData(useShallow((s) => assistants.map((a) => s.transcripts[a.id])));
  const messages = useData((s) => messagesOfRun(s.messages, run.id));
  const presentations = useData((s) => presentationsOfRun(s.presentations, run.id));
  const tasks = useData((s) => tasksOfRun(s.tasks, run.id));
  const nodes = useData((s) => latestPlan(s, run.id)?.dag.nodes ?? EMPTY);
  const merges = useData((s) => mergesOfRun(s.merges, run.id));
  const inbox = useInboxOfRun(run.id);
  const live = liveAssistant(attempts);
  const sent = useSentMessages(live?.id);
  return useMemo(() => {
    const byId: Record<string, ReturnType<typeof transcriptEntries>> = {};
    assistants.forEach((a, i) => {
      const t = transcripts[i];
      if (t) byId[a.id] = transcriptEntries(t);
    });
    const pending: PendingMessage[] = sent.map((m) => ({
      id: m.id,
      text: m.text,
      attachments: m.attachments.flatMap((c) => (c.ref ? [c.ref] : [])),
      status: m.status,
      error: m.error,
      ts: m.ts,
    }));
    const thread = buildThread({
      run,
      attempts,
      transcripts: byId,
      messages,
      inbox,
      presentations,
      tasks,
      nodes,
      merges,
      pending,
    });
    const busy = assistantBusy(live ? byId[live.id] : undefined, live);
    const loading = assistants.some((_, i) => !transcripts[i] || transcripts[i]?.status === 'loading');
    return { thread, busy, live, assistants, loading, session: isSessionRun(run, attempts) };
  }, [run, attempts, assistants, transcripts, messages, inbox, presentations, tasks, nodes, merges, live, sent]);
}

/** Why the human cannot reply right now (null = they can). */
function closedReason(run: Run, live: Attempt | null, hadAssistant: boolean, session: boolean): string | null {
  if (session) {
    if (run.status === 'done' || run.archived)
      return `This session ended. Start a new one with ${formatChord('Mod+Shift+N')}.`;
    if (run.status === 'cancelled') return 'This session was stopped.';
    if (run.status === 'failed') return `This session failed. Start a new one with ${formatChord('Mod+Shift+N')}.`;
    // Its agent stops between turns; a message reopens it.
    if (!live) return 'The session is starting.';
    return null;
  }
  if (run.archived)
    return `This run is archived: its worktrees and branches are cleaned up. Start a new one with ${formatChord('Mod+N')}.`;
  if (run.status === 'done') return `This run is finished. Start a new one with ${formatChord('Mod+N')}.`;
  if (run.status === 'cancelled') return 'This run was stopped.';
  if (run.status === 'failed') return `This run failed. ${formatChord('Mod+E')} still shows its agents.`;
  if (!hadAssistant)
    return `This run has no assistant. ${formatChord('Mod+E')} opens its agents, where you can steer them.`;
  if (live?.status !== 'running') return 'The assistant is not running. Legion reopens it when there is news.';
  return null;
}

/** `focused`: the board's focused tile (the active run); its conversation is the one tests and ⌘U address. */
export function Conversation({ run, focused }: { run: Run; focused: boolean }) {
  const { thread, busy, live, assistants, loading, session } = useThreadOf(run);
  const partner = usePartnerName(live, session);
  const scrollRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  /** When the reader last scrolled on purpose. */
  const intent = useRef(0);
  /** A thread item being brought into view, kept there while content above it is still loading. */
  const focusing = useRef<{ key: string; until: number } | null>(null);
  const reduced = useReducedMotionPref();
  const chatFocus = useUi((s) => s.chatFocus);
  const [highlight, setHighlight] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null && !loading) seen.current = new Set(thread.map((i) => i.key));
  const open = openDecisionItems(thread);
  const closed = closedReason(run, live, assistants.length > 0, session);

  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
    pinnedRef.current = true;
    setPinned(true);
  };

  // Stay at the bottom while pinned, as the feed grows (streaming text, new items, images loading).
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const observer = new ResizeObserver(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      if (pinnedRef.current) {
        scroller.scrollTo({ top: scroller.scrollHeight });
        return;
      }
      const focus = focusing.current;
      if (!focus || Date.now() > focus.until || Date.now() - intent.current < 400) return;
      scroller.querySelector<HTMLElement>(`[data-thread-key="${CSS.escape(focus.key)}"]`)?.scrollIntoView({
        block: 'center',
      });
    });
    observer.observe(feed);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  // A decision or presentation to show (⌘U, the needs-you bar): scroll to it and mark it for a moment. The
  // thread may still be loading around it, so it is kept in view while the feed settles (see the observer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the thread renders the target
  useEffect(() => {
    if (!chatFocus) return;
    // Another item is being shown now (maybe in another tile): only one card on the board is marked at a time.
    setHighlight((current) => (current && current !== chatFocus.itemId ? null : current));
    if (chatFocus.nonce === consumedFocus) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-thread-key="${CSS.escape(chatFocus.itemId)}"]`);
    if (!target) return;
    consumedFocus = chatFocus.nonce;
    pinnedRef.current = false;
    setPinned(false);
    focusing.current = { key: chatFocus.itemId, until: Date.now() + 2500 };
    target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    setHighlight(chatFocus.itemId);
  }, [chatFocus, thread.length]);

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 1800);
    return () => clearTimeout(timer);
  }, [highlight]);

  return (
    <div className="ch" data-testid={focused ? 'chat' : 'chat-tile'} data-run={run.id}>
      {assistants.map((a) => (
        <KeepTranscript key={a.id} attemptId={a.id} />
      ))}
      {session ? null : <Progress run={run} />}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the handlers only note that the reader scrolled on purpose */}
      <div
        className="ch-scroll"
        ref={scrollRef}
        // Only the reader unpins the view (wheel, keys, the scrollbar): growing content, images loading and
        // layout shifts never do; reaching the bottom pins it again.
        onWheel={(event) => {
          if (event.deltaY < 0) intent.current = Date.now();
        }}
        onPointerDown={() => {
          intent.current = Date.now();
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) intent.current = Date.now();
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          // A jump to a decision scrolls on its own; until it settles (or the reader takes over), passing near
          // the bottom must not pin the view and drag it back down.
          const focus = focusing.current;
          if (focus && Date.now() < focus.until && Date.now() - intent.current >= 400) return;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
          if (atBottom && !pinnedRef.current) {
            pinnedRef.current = true;
            setPinned(true);
          } else if (!atBottom && pinnedRef.current && Date.now() - intent.current < 400) {
            pinnedRef.current = false;
            setPinned(false);
          } else if (!atBottom && pinnedRef.current) el.scrollTo({ top: el.scrollHeight });
        }}
      >
        <div className="ch-feed" ref={feedRef}>
          {loading && thread.length === 0 ? (
            <div className="ch-skeleton" aria-hidden="true">
              <div style={{ width: '46%' }} />
              <div style={{ width: '72%' }} />
              <div style={{ width: '58%' }} />
            </div>
          ) : null}
          <ol className="ch-thread" aria-label="Conversation">
            {thread.map((item) => (
              <li
                key={item.key}
                className="ch-item"
                data-kind={item.kind}
                data-thread-key={item.key}
                data-continued={(item.kind === 'assistant' && item.continued) || undefined}
                data-enter={seen.current !== null && !seen.current.has(item.key) ? true : undefined}
                data-highlight={highlight === item.key || undefined}
              >
                <Row item={item} running={live?.status === 'running'} focused={focused} />
              </li>
            ))}
          </ol>
          {!loading ? <Outcome run={run} /> : null}
          {busy ? <Typing name={partner} /> : null}
        </div>
      </div>
      <div className="ch-dock">
        <div className="ch-dock-inner">
          <AnimatePresence>
            {!pinned ? (
              <motion.button
                key="jump"
                type="button"
                className="ch-jump"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: reduced ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => toBottom(true)}
                data-testid="chat-jump"
              >
                <Icon name="arrowDown" size={12} strokeWidth={2.4} />
                Latest
              </motion.button>
            ) : null}
          </AnimatePresence>
          <NeedsYou runId={run.id} open={open} />
          <ChatComposer
            runId={run.id}
            assistant={live}
            name={partner}
            busy={busy}
            closed={closed}
            onSent={() => toBottom(true)}
          />
        </div>
      </div>
    </div>
  );
}

/** What the conversation calls whoever answers: the assistant, or a session's engine. */
function usePartnerName(live: Attempt | null, session: boolean): string {
  const engine = useData((s) => (live ? displayEngine(s, live) : null));
  if (!session) return 'the assistant';
  return engine === 'codex' ? 'Codex' : 'Claude';
}

function Typing({ name }: { name: string }) {
  return (
    <div className="ch-typing" role="status" aria-label={`${capitalize(name)} is working`} data-testid="chat-typing">
      <span />
      <span />
      <span />
    </div>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function Row({ item, running, focused }: { item: ThreadItem; running: boolean; focused: boolean }) {
  switch (item.kind) {
    case 'human':
      return <Human item={item} />;
    case 'assistant':
      return <Assistant item={item} />;
    case 'work':
      return <Work item={item} running={running} focused={focused} />;
    case 'update':
      return <Update item={item} />;
    case 'decision':
      return <Decision item={item.item} />;
    case 'presentation':
      return <Presentation presentation={item.presentation} />;
    case 'event':
      return (
        <div className="ch-event" data-tone={item.tone}>
          <span className="ch-event-rule" aria-hidden="true" />
          {item.href ? (
            <a
              href={item.href}
              onClick={(event) => {
                event.preventDefault();
                openExternal(item.href as string);
              }}
            >
              {item.text}
              <Icon name="external" size={11} />
            </a>
          ) : (
            <span>{item.text}</span>
          )}
          <time className="ch-time">{formatStamp(item.ts)}</time>
          <span className="ch-event-rule" aria-hidden="true" />
        </div>
      );
    case 'error':
      return (
        <div className="ch-event" data-tone="bad">
          <span className="ch-event-rule" aria-hidden="true" />
          <span>{item.text}</span>
          <span className="ch-event-rule" aria-hidden="true" />
        </div>
      );
  }
}

const OUTCOME_TITLE: Partial<Record<Run['status'], string>> = {
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Stopped',
};

/** The end of a finished run, in one place: where the change went, how much of the plan landed, what it cost. */
function Outcome({ run }: { run: Run }) {
  const counts = useData(
    useShallow((s) => {
      const tasks = tasksOfRun(s.tasks, run.id);
      return {
        merged: tasks.filter((t) => t.status === 'merged').length,
        total: tasks.length,
        cost: runCost(s, run.id),
      };
    }),
  );
  const title = OUTCOME_TITLE[run.status];
  if (!title) return null;
  const pr = runPr(run);
  const prWord = pr
    ? pr.state === 'merged'
      ? 'merged'
      : pr.state === 'closed'
        ? 'closed'
        : pr.isDraft
          ? 'draft'
          : 'open'
    : null;
  return (
    <section className="ch-outcome" data-status={run.status} aria-label={`Run ${title.toLowerCase()}`}>
      <h2 className="ch-outcome-title">
        <span
          className="ch-receipt-mark"
          data-tone={run.status === 'done' ? 'ok' : run.status === 'failed' ? 'bad' : 'muted'}
          aria-hidden="true"
        >
          <Icon
            name={run.status === 'done' ? 'check' : run.status === 'failed' ? 'close' : 'stop'}
            size={11}
            strokeWidth={2.6}
          />
        </span>
        {title}
        {run.archived ? <Chip tone="idle">archived</Chip> : null}
      </h2>
      <dl className="ch-outcome-facts">
        {pr ? (
          <div>
            <dt>Pull request</dt>
            <dd>
              <a
                href={pr.url}
                onClick={(event) => {
                  event.preventDefault();
                  openExternal(pr.url);
                }}
              >
                <span className="mono">#{pr.number ?? '?'}</span> {prWord}
                <Icon name="external" size={11} />
              </a>
            </dd>
          </div>
        ) : null}
        {counts.total ? (
          <div>
            <dt>Tasks merged</dt>
            <dd className="mono">
              {counts.merged}/{counts.total}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Spent</dt>
          <dd className="mono">{formatCost(counts.cost)}</dd>
        </div>
        <div>
          <dt>Took</dt>
          <dd className="mono">{formatDuration(run.updatedAt - run.createdAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

function openExternal(href: string): void {
  const bridge = (window as Window & { legion?: { openExternal?: (url: string) => Promise<void> } }).legion;
  if (bridge?.openExternal) void bridge.openExternal(href);
  else window.open(href, '_blank', 'noopener');
}

function Human({ item }: { item: Extract<ThreadItem, { kind: 'human' }> }) {
  return (
    <div className="ch-you" data-pending={item.pending?.status === 'sending' || undefined}>
      <div className="ch-you-bubble">
        {item.attachments.length ? <YouFiles item={item} /> : null}
        {item.text ? <div className="ch-you-text">{item.text}</div> : null}
      </div>
      {item.pending?.status === 'error' ? (
        <div className="ch-you-error" role="alert">
          Not sent: {item.pending.error}
        </div>
      ) : null}
    </div>
  );
}

function YouFiles({ item }: { item: Extract<ThreadItem, { kind: 'human' }> }) {
  const chips = useMemo(() => item.attachments.map((r) => chipOfRef(r)), [item.attachments]);
  return (
    <div className="ch-you-files">
      <ChipList chips={chips} size="sm" label="Attached" />
    </div>
  );
}

/** Rows a session's work shows (its words are the conversation's; approvals are decision cards). */
const WORK_ROWS = new Set<TimelineRow['kind']>(['reads', 'edit', 'command', 'mcp', 'tool', 'todo']);
const NO_APPROVALS = new Map();

/** A direct session's tool calls between two of its texts, as the session tile's timeline rows. */
function Work({
  item,
  running,
  focused,
}: {
  item: Extract<ThreadItem, { kind: 'work' }>;
  running: boolean;
  focused: boolean;
}) {
  const engine = useData((s) => displayEngine(s, s.attempts[item.key.split(':')[1] ?? '']));
  const rows = useMemo(() => buildTimeline(item.entries).rows.filter((r) => WORK_ROWS.has(r.kind)), [item.entries]);
  const ctx: RowContext = useMemo(
    () => ({ engine, running, focused, approvals: NO_APPROVALS, onOpenDiff: null }),
    [engine, running, focused],
  );
  if (rows.length === 0) return null;
  return (
    <div className="ch-work">
      {rows.map((row, i) => (
        <div className="ss-row" key={row.key}>
          <TimelineRowView row={row} ctx={ctx} last={i === rows.length - 1} />
        </div>
      ))}
    </div>
  );
}

function Assistant({ item }: { item: Extract<ThreadItem, { kind: 'assistant' }> }) {
  const [open, setOpen] = useState(false);
  const fromLead = useData((s) => item.sources.every((m) => s.attempts[m.fromAttemptId]?.role === 'lead'));
  const attempt = useData((s) => s.attempts[item.key.split(':')[1] ?? '']);
  const engine = useData((s) => displayEngine(s, attempt));
  const name = attempt?.role === 'session' ? (engine === 'codex' ? 'Codex' : 'Claude') : 'Assistant';
  if (!item.text.trim() && !item.streaming) return null;
  return (
    <div className="ch-as">
      {item.continued ? null : (
        <div className="ch-as-head">
          <span className="ch-as-mark" data-engine={engine} aria-hidden="true">
            <Icon name="spark" size={12} strokeWidth={2} />
          </span>
          <span className="ch-as-name">{name}</span>
          <time className="ch-time">{formatStamp(item.ts)}</time>
        </div>
      )}
      <div className="ch-as-body">
        <Markdown text={item.text} streaming={item.streaming} caret={item.streaming} />
      </div>
      {item.sources.length ? (
        <div className="ch-sources" data-open={open}>
          <button
            type="button"
            className="ch-sources-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            data-testid="chat-sources"
          >
            <Icon name="chevronRight" size={11} strokeWidth={2.4} />
            {sourceSummary(item.sources, fromLead)}
          </button>
          {open ? (
            <ul className="ch-sources-list">
              {item.sources.map((m) => (
                <li key={m.id}>
                  <SourceMessage attemptId={m.fromAttemptId} body={m.body} ts={m.createdAt} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function sourceSummary(sources: readonly { fromAttemptId: string }[], lead: boolean): string {
  const n = sources.length;
  if (lead) return n === 1 ? "Based on the lead's update" : `Based on ${n} updates from the lead`;
  return n === 1 ? "Based on an agent's update" : `Based on ${n} updates from its agents`;
}

function SourceMessage({ attemptId, body, ts }: { attemptId: string; body: string; ts: number }) {
  const agent = useData(useShallow((s) => agentLabel(s, attemptId)));
  return (
    <div className="ch-source">
      <div className="ch-source-head">
        <AgentName agent={agent} />
        <time className="ch-time">{formatStamp(ts)}</time>
      </div>
      <div className="ch-source-body">
        <Markdown text={body} streaming={false} caret={false} />
      </div>
    </div>
  );
}

function Update({ item }: { item: Extract<ThreadItem, { kind: 'update' }> }) {
  const agent = useData(useShallow((s) => agentLabel(s, item.message.fromAttemptId)));
  const [open, setOpen] = useState(false);
  const [headline, ...rest] = item.message.body.trim().split('\n');
  const more = rest.join('\n').trim();
  return (
    <div className="ch-update">
      <button
        type="button"
        className="ch-update-line"
        aria-expanded={more ? open : undefined}
        disabled={!more}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentName agent={agent} />
        <span className="ch-update-text">{headline}</span>
        <time className="ch-time">{formatStamp(item.ts)}</time>
      </button>
      {open && more ? (
        <div className="ch-update-body">
          <Markdown text={more} streaming={false} caret={false} />
        </div>
      ) : null}
    </div>
  );
}

/** What waits on the human in this conversation; the title bar counts the rest. */
function NeedsYou({ runId, open }: { runId: string; open: ReturnType<typeof openDecisionItems> }) {
  const tasks = useData((s) => s.tasks);
  if (open.length === 0) return null;
  return (
    <div className="ch-needs-bar" data-testid="chat-needs-you">
      <span className="ch-needs-count">
        <span className="ch-needs-dot" aria-hidden="true" />
        {open.length} waiting for you
      </span>
      <span className="ch-needs-items">
        {open.slice(0, 4).map(({ item, key }) => (
          <button key={key} type="button" className="ch-needs-chip" onClick={() => actions.focusChatItem(runId, key)}>
            {decisionTitle(item)}
            {item.taskId && tasks[item.taskId] ? <span className="mono"> {tasks[item.taskId]?.nodeId}</span> : null}
          </button>
        ))}
        {open.length > 4 ? <span className="ch-needs-more">+{open.length - 4} more</span> : null}
      </span>
    </div>
  );
}
