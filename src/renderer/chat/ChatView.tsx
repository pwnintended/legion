/**
 * The run's conversation: the app's home for a run. One column of the human's messages, the assistant's replies
 * (with what its agents told it folded underneath), the decisions waiting on the human as cards, what agents
 * presented, and the run's milestones; the progress strip above and the reply box below. The agents themselves
 * stay in the Agents view (⌘E).
 */
import type { Attempt, Run } from '@shared/domain';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  attemptsOfRun,
  latestPlan,
  mergesOfRun,
  messagesOfRun,
  presentationsOfRun,
  tasksOfRun,
  transcriptEntries,
} from '../app/data';
import { useData, useRun, useTranscript, useUi } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { actions, jumpToNextDecision } from '../app/store';
import { ChipList, chipOfRef } from '../attachments/Attachments';
import { Icon } from '../chrome/icons';
import { formatClock } from '../layout/describe';
import { useSentMessages } from '../tiles/session/actions';
import { Markdown } from '../tiles/session/Markdown';
import '../tiles/session/session.css';
import { ChatComposer } from './Composer';
import { Decision } from './Decision';
import { agentLabel, DECISION_TITLE } from './labels';
import { AgentName, Presentation } from './Presentation';
import { Progress } from './Progress';
import {
  assistantAttempts,
  assistantBusy,
  buildThread,
  liveAssistant,
  openDecisionItems,
  type PendingMessage,
  type ThreadItem,
} from './thread';
import './chat.css';

const EMPTY: never[] = [];

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
    return { thread, busy, live, assistants, loading };
  }, [run, attempts, assistants, transcripts, messages, inbox, presentations, tasks, nodes, merges, live, sent]);
}

/** Why the human cannot reply right now (null = they can). */
function closedReason(run: Run, live: Attempt | null, hadAssistant: boolean): string | null {
  if (run.status === 'done') return 'This run is finished. Start a new one with ⌘N.';
  if (run.status === 'cancelled') return 'This run was stopped.';
  if (run.status === 'failed') return 'This run failed. Its agents are still in the Agents view (⌘E).';
  if (!hadAssistant) return 'This run has no assistant. Steer its agents from the Agents view (⌘E).';
  if (live?.status !== 'running') return 'The assistant is not running. Legion reopens it when there is news.';
  return null;
}

export function ChatView({ runId }: { runId: string }) {
  const run = useRun(runId);
  if (!run) return null;
  return <Conversation run={run} />;
}

function Conversation({ run }: { run: Run }) {
  const { thread, busy, live, assistants, loading } = useThreadOf(run);
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
  const closed = closedReason(run, live, assistants.length > 0);

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
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-thread-key="${CSS.escape(chatFocus.itemId)}"]`);
    if (!target) return;
    pinnedRef.current = false;
    setPinned(false);
    focusing.current = { key: chatFocus.itemId, until: Date.now() + 2500 };
    target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    setHighlight(chatFocus.itemId);
    const timer = setTimeout(() => setHighlight(null), 1800);
    return () => clearTimeout(timer);
  }, [chatFocus, thread.length]);

  return (
    <div className="ch" data-testid="chat" data-run={run.id}>
      {assistants.map((a) => (
        <KeepTranscript key={a.id} attemptId={a.id} />
      ))}
      <Progress run={run} />
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
          <header className="ch-head">
            <h1 className="ch-title">{run.title}</h1>
            <p className="ch-sub mono">
              {run.repoPath.split('/').filter(Boolean).at(-1)} · {run.baseRef} · started {formatClock(run.createdAt)}
            </p>
          </header>
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
                <Row item={item} />
              </li>
            ))}
          </ol>
          {busy ? <Typing /> : null}
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
          <ChatComposer runId={run.id} assistant={live} busy={busy} closed={closed} onSent={() => toBottom(true)} />
        </div>
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="ch-typing" role="status" aria-label="The assistant is writing" data-testid="chat-typing">
      <span />
      <span />
      <span />
    </div>
  );
}

function Row({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case 'human':
      return <Human item={item} />;
    case 'assistant':
      return <Assistant item={item} />;
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
          <time className="ch-time">{formatClock(item.ts)}</time>
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

function Assistant({ item }: { item: Extract<ThreadItem, { kind: 'assistant' }> }) {
  const [open, setOpen] = useState(false);
  const fromLead = useData((s) => item.sources.every((m) => s.attempts[m.fromAttemptId]?.role === 'lead'));
  const engine = useData((s) => s.attempts[item.key.split(':')[1] ?? '']?.engine ?? 'claude');
  if (!item.text.trim() && !item.streaming) return null;
  return (
    <div className="ch-as">
      {item.continued ? null : (
        <div className="ch-as-head">
          <span className="ch-as-mark" data-engine={engine} aria-hidden="true">
            <Icon name="spark" size={12} strokeWidth={2} />
          </span>
          <span className="ch-as-name">Assistant</span>
          <time className="ch-time">{formatClock(item.ts)}</time>
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
        <time className="ch-time">{formatClock(ts)}</time>
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
  return (
    <div className="ch-update">
      <button type="button" className="ch-update-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <AgentName agent={agent} />
        <span className="ch-update-text">{headline}</span>
        <time className="ch-time">{formatClock(item.ts)}</time>
      </button>
      {open && rest.join('\n').trim() ? (
        <div className="ch-update-body">
          <Markdown text={rest.join('\n').trim()} streaming={false} caret={false} />
        </div>
      ) : null}
    </div>
  );
}

function NeedsYou({ runId, open }: { runId: string; open: ReturnType<typeof openDecisionItems> }) {
  const elsewhere = useData(
    (s) => Object.values(s.inbox).filter((i) => i.resolvedAt === null && i.runId !== runId).length,
  );
  const tasks = useData((s) => s.tasks);
  if (open.length === 0 && elsewhere === 0) return null;
  return (
    <div className="ch-needs-bar" data-testid="chat-needs-you">
      {open.length ? (
        <>
          <span className="ch-needs-count">
            <span className="ch-needs-dot" aria-hidden="true" />
            {open.length} waiting for you
          </span>
          <span className="ch-needs-items">
            {open.slice(0, 4).map(({ item, key }) => (
              <button
                key={key}
                type="button"
                className="ch-needs-chip"
                onClick={() => actions.focusChatItem(runId, key)}
              >
                {DECISION_TITLE[item.kind]}
                {item.taskId && tasks[item.taskId] ? <span className="mono"> {tasks[item.taskId]?.nodeId}</span> : null}
              </button>
            ))}
          </span>
        </>
      ) : null}
      {elsewhere ? (
        <button type="button" className="ch-needs-other" onClick={() => jumpToNextDecision()}>
          {elsewhere} in other runs
          <Icon name="arrowRight" size={11} />
        </button>
      ) : null}
    </div>
  );
}
