/**
 * The terminal UI fills the window (the alternate screen): the conversation and the streaming reply scroll in the
 * view at the top (PgUp/PgDn or the mouse wheel; it follows new output unless scrolled back); below it the
 * assistant's progress, the interaction waiting for the user, the prompt and a status bar; under those the active
 * runs, the team and the activity feed.
 */
import { homedir } from 'node:os';
import { Box, type DOMElement, Text, useApp, useBoxMetrics, useInput, useWindowSize } from 'ink';
import { memo, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { QuestionAnswers, UserQuestion } from '../engine/types.ts';
import type { Presentation } from '../team/team.ts';
import { ConfigMenu } from './config-menu.tsx';
import { COMMANDS, type Controller } from './controller.ts';
import { hyperlink, linkTarget } from './images.ts';
import { PromptInput } from './input.tsx';
import { Markdown } from './markdown.tsx';
import { splash, splashSize } from './splash.ts';
import {
  type Banner,
  clipLines,
  clock,
  type FeedEntry,
  feedMark,
  feedTone,
  type Item,
  type Line,
  oneLine,
  type RunView,
  type StepView,
  type TeamRow,
  type UiInteraction,
} from './store.ts';
import type { TerminalModes } from './terminal.ts';
import { BUSY_FRAMES, color, engineColor, formatDuration, glyph, SPINNER, theme, tildify } from './theme.ts';
import { WorkflowsMenu } from './workflows-menu.tsx';

type Mode = 'hotkeys' | 'note' | 'chat';

/** Conversation items kept in the view; older ones scroll out of reach (`/activity` and the journal keep the rest). */
const ITEMS_SHOWN = 500;

export function App({ controller, terminal }: { controller: Controller; terminal?: TerminalModes }) {
  const { store } = controller;
  const state = useSyncExternalStore(store.subscribe, store.get);
  const app = useApp();
  const { columns, rows } = useWindowSize();
  const [frame, setFrame] = useState(0);
  const [mode, setMode] = useState<Mode>('hotkeys');
  const [option, setOption] = useState(0);
  // Questions an agent asks: which one is shown, the answers so far, the options toggled on (multi-select).
  const [qIndex, setQIndex] = useState(0);
  const [collected, setCollected] = useState<QuestionAnswers>({});
  const [picked, setPicked] = useState<number[]>([]);
  const [armedExit, setArmedExit] = useState(false);
  // Which of the welcome card's starters Tab fills in next.
  const starter = useRef(0);
  // The keyboard shortcuts, over the prompt (`?` on an empty prompt).
  const [shortcuts, setShortcuts] = useState(false);
  const head = state.interactions[0] ?? null;
  const animating = state.busy || state.runs.length > 0;
  const width = Math.max(40, columns || 80);
  const welcome = state.items.some((i) => i.type === 'banner');

  useEffect(() => {
    controller.attach({
      exit: () => app.exit(),
      suspend: (run) =>
        app.suspendTerminal(() => {
          terminal?.leave();
          try {
            run();
          } finally {
            terminal?.enter();
          }
        }),
    });
  }, [controller, app, terminal]);

  // How far the conversation is scrolled back from its end, in rows (0: it follows new output). While scrolled
  // back, rows added at the end push it further back, so what is on screen stays put.
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const view = useBoxMetrics(viewport);
  const body = useBoxMetrics(content);
  const [back, setBack] = useState(0);
  const bodyHeight = useRef(0);
  useEffect(() => {
    const grew = body.height - bodyHeight.current;
    bodyHeight.current = body.height;
    if (grew > 0) setBack((b) => (b > 0 ? b + grew : 0));
  }, [body.height]);
  const maxBack = Math.max(0, body.height - view.height);
  const shownBack = Math.min(back, maxBack);
  const scroll = (rowsBy: number) => setBack((b) => Math.max(0, Math.min(Math.min(b, maxBack) + rowsBy, maxBack)));
  const page = Math.max(1, view.height - 2);
  useInput((input, key) => {
    if (key.pageUp) scroll(page);
    else if (key.pageDown) scroll(-page);
    else if (key.ctrl && input === 'o') store.update((s) => ({ showTools: !s.showTools }));
  });
  const wheel = useRef(scroll);
  wheel.current = scroll;
  useEffect(() => terminal?.onWheel((direction) => wheel.current(direction * -3)), [terminal]);

  useEffect(() => {
    if (!animating) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, [animating]);

  useEffect(() => {
    if (!armedExit) return;
    const timer = setTimeout(() => setArmedExit(false), 2000);
    return () => clearTimeout(timer);
  }, [armedExit]);

  // A new head interaction starts in hotkey mode, on its first option.
  const headId = head?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect is about the head changing, not reading it.
  useEffect(() => {
    setMode('hotkeys');
    setOption(0);
    setQIndex(0);
    setCollected({});
    setPicked([]);
  }, [headId]);

  const answering = head !== null && mode !== 'chat';
  const ask = head?.source === 'run' && head.pending.interaction.kind === 'ask' ? head.pending.interaction : null;
  const questions = head ? questionsOf(head) : null;
  const question = questions?.[qIndex] ?? null;
  const typing = answering && (ask !== null || question !== null || mode === 'note');
  const choices = question ? question.options.map((o) => o.label) : (ask?.options ?? []);

  /** One question answered (typed text, option numbers, or the highlighted/toggled options); the last sends all. */
  const answerQuestion = (value: string) => {
    if (!head || !questions || !question) return;
    const v = value.trim();
    let answer: string[];
    if (!v) {
      if (choices.length === 0) return;
      answer =
        question.multiSelect && picked.length > 0 ? picked.map((n) => choices[n] ?? '') : [choices[option] ?? ''];
    } else if (choices.length > 0 && /^\d+(\s*,\s*\d+)*$/.test(v)) {
      const labels = v.split(',').map((n) => choices[Number(n.trim()) - 1]);
      if (labels.some((l) => l === undefined)) return;
      answer = question.multiSelect ? (labels as string[]) : [labels[0] as string];
    } else answer = [v];
    const next = { ...collected, [question.id]: answer };
    if (qIndex + 1 < questions.length) {
      setCollected(next);
      setQIndex(qIndex + 1);
      setOption(0);
      setPicked([]);
    } else controller.answerQuestions(head, next);
  };

  const submit = (value: string) => {
    setArmedExit(false);
    setShortcuts(false);
    setBack(0);
    if (head && typing && question) {
      answerQuestion(value);
      return;
    }
    if (head && typing) {
      if (ask && !value.trim() && ask.options.length > 0) controller.answerAsk(head.id, ask.options[option] ?? '');
      else if (value.trim() || mode === 'note') answerText(controller, head, value, mode);
      return;
    }
    void controller.submit(value);
    if (mode === 'chat') setMode('hotkeys');
  };

  const hotkey = (key: string): boolean => {
    if (!head && key === '?') {
      setShortcuts((on) => !on);
      return true;
    }
    if (!head || !answering) return false;
    if (question) {
      // Space toggles the highlighted option of a multi-select question.
      if (!question.multiSelect || key !== ' ') return false;
      setPicked((p) => (p.includes(option) ? p.filter((n) => n !== option) : [...p, option]));
      return true;
    }
    if (ask || mode === 'note') return false;
    return answerKey(controller, head, key.toLowerCase(), () => setMode('note'));
  };

  const tone = !head || mode === 'chat' ? undefined : ask && mode !== 'note' ? theme.info : theme.warn;

  return (
    <Box flexDirection="column" width={width} height={Math.max(10, rows || 24)}>
      <Box
        ref={viewport}
        flexDirection="column"
        flexGrow={1}
        flexBasis={0}
        overflow="hidden"
        contentOffsetY={maxBack - shownBack}
      >
        <Box ref={content} flexDirection="column" flexShrink={0}>
          {state.items.slice(-ITEMS_SHOWN).map((item) => (
            <ItemView key={item.id} item={item} width={width} showTools={state.showTools} />
          ))}
          {state.streaming ? (
            <Bullet mark={glyph.assistant} markColor="white" marginTop={1}>
              <Markdown text={state.streaming} width={width - 2} />
            </Bullet>
          ) : null}
        </Box>
      </Box>
      {/* A menu takes the room it needs (the conversation keeps the rest), clipped when the window is too short. */}
      {state.menu ? (
        <Box flexDirection="column" flexShrink={1} overflow="hidden">
          {state.menu === 'config' ? <ConfigMenu controller={controller} width={width} /> : null}
          {state.menu === 'workflows' ? <WorkflowsMenu controller={controller} width={width} /> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" flexShrink={0}>
        {state.busy ? (
          <Busy
            frame={frame}
            since={state.busySince}
            activity={state.activity}
            tokens={state.tokens ? state.tokens.output - state.tokens.outputAtTurnStart : 0}
          />
        ) : null}
        {head && !state.menu ? (
          <InteractionView
            item={head}
            mode={mode}
            option={option}
            queued={state.interactions.length - 1}
            question={questions && question ? { list: questions, index: qIndex, picked } : null}
          />
        ) : null}
        {shortcuts && !head && !state.menu ? <Shortcuts width={width} /> : null}
        <Box
          display={state.menu ? 'none' : 'flex'}
          flexDirection="column"
          marginTop={head || state.busy || shortcuts ? 0 : 1}
        >
          <PromptInput
            prompt={typing ? glyph.ask : state.target === 'orchestrator' ? glyph.user : `${state.target} ${glyph.user}`}
            mask={typing && question?.secret === true}
            tone={tone}
            placeholder={
              typing && question
                ? question.multiSelect
                  ? 'Space toggles, Enter confirms · or type numbers or your own answer'
                  : choices.length > 0
                    ? 'Pick with ↑↓ and Enter · or type a number or your own answer'
                    : 'Type your answer'
                : placeholder(head, mode, ask !== null, state.target)
            }
            commands={typing ? [] : COMMANDS}
            isActive={!state.menu}
            seed={state.seed}
            onSubmit={submit}
            onEmptyKey={hotkey}
            onNavigate={(dir) => {
              if ((!ask && !question) || !answering || choices.length === 0) return false;
              setOption((n) => (n + dir + choices.length) % choices.length);
              return true;
            }}
            onChange={() => setShortcuts(false)}
            onEscape={() => {
              if (shortcuts) return setShortcuts(false);
              // Esc declines an agent's questions (it is told the user would not answer).
              if (head && question && mode !== 'chat') controller.answerQuestions(head, null);
              else if (mode !== 'hotkeys') setMode('hotkeys');
              else void controller.interrupt();
            }}
            onTab={(empty) => {
              if (head) setMode((m) => (m === 'chat' ? 'hotkeys' : 'chat'));
              else if (empty && welcome) controller.seed(TRY[starter.current++ % TRY.length] ?? '');
            }}
            onCtrlC={() => {
              if (state.busy) {
                void controller.interrupt();
                return;
              }
              if (armedExit) app.exit();
              else setArmedExit(true);
            }}
          />
        </Box>
        <StatusBar
          width={width}
          hint={
            state.menu
              ? state.menu === 'config'
                ? 'settings'
                : 'workflows'
              : armedExit
                ? 'Press Ctrl+C again to exit'
                : shownBack > 0
                  ? `↓ ${shownBack} more line${shownBack === 1 ? '' : 's'} below · PgDn, or send to jump back`
                  : state.busy
                    ? 'esc to interrupt'
                    : head && mode === 'chat'
                      ? 'tab: back to the question'
                      : welcome
                        ? 'tab fills in an idea · / for commands · ? for shortcuts'
                        : '/ for commands · ? for shortcuts'
          }
          urgent={armedExit || shownBack > 0}
          accounts={state.accounts}
          costUsd={state.costUsd}
          runs={state.runs.length}
          waiting={state.interactions.length}
        />
      </Box>
      {/* Under the prompt: what changes now and then (runs, the team, activity), so the chat stays a conversation.
          It gives way first when the window is short, and never takes more than half of it. */}
      {state.menu ? null : (
        <Box flexDirection="column" flexShrink={1} overflow="hidden" maxHeight={Math.max(6, Math.floor(rows / 2))}>
          {state.runs.map((run) => (
            <RunPanel
              key={run.id}
              run={run}
              frame={frame}
              waiting={state.interactions.some((i) => i.source === 'run' && i.pending.interaction.runId === run.id)}
              // Leads' runs are one line each, except those of the lead the user is talking to.
              compact={run.owner !== undefined && run.owner !== state.target}
            />
          ))}
          {state.team.length > 0 ? <TeamPanel rows={state.team} target={state.target} frame={frame} /> : null}
          <Feed entries={state.feed} />
        </Box>
      )}
    </Box>
  );
}

// ---- live region ---------------------------------------------------------------------------------

function Busy(props: { frame: number; since: number | null; activity: string | null; tokens: number }) {
  const { frame, since, activity } = props;
  const mark = BUSY_FRAMES[frame % BUSY_FRAMES.length] ?? '░';
  const elapsed = since ? formatDuration(Date.now() - since) : '';
  const text = `${activity ? oneLine(capitalize(activity), 90) : 'Working'}…`;
  // A highlight sweeps across the text, then rests a moment before the next pass.
  const at = (frame % (text.length + SHIMMER * 3)) - SHIMMER;
  const from = Math.max(0, at);
  const to = Math.max(0, at + SHIMMER);
  return (
    <Box marginTop={1}>
      <Text color={theme.accent}>{mark} </Text>
      <Text color={theme.accent}>
        {text.slice(0, from)}
        <Text color="white" bold>
          {text.slice(from, to)}
        </Text>
        {text.slice(to)}
      </Text>
      <Text dimColor>
        {' '}
        ({elapsed ? `${elapsed} · ` : ''}
        {props.tokens > 0 ? `↓ ${formatCount(props.tokens)} tokens · ` : ''}esc to interrupt)
      </Text>
    </Box>
  );
}

/** `840`, `12.3k`, `1.2M`. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** How many characters the busy line's highlight spans. */
const SHIMMER = 5;

function StatusBar(props: {
  width: number;
  hint: string;
  urgent: boolean;
  accounts: Record<string, string>;
  costUsd: number | null;
  runs: number;
  waiting: number;
}) {
  const parts: { text: string; color?: string }[] = Object.entries(props.accounts).map(([k, v]) => ({
    text: k === v ? k : `${k} ${v}`,
    color: engineColor(k),
  }));
  if (props.runs > 0) parts.push({ text: `${props.runs} run${props.runs > 1 ? 's' : ''}`, color: theme.info });
  if (props.waiting > 0) parts.push({ text: `${props.waiting} waiting`, color: theme.warn });
  if (props.costUsd !== null) parts.push({ text: `$${props.costUsd.toFixed(2)}` });
  return (
    <Box width={props.width} justifyContent="space-between" paddingX={2}>
      <Text color={props.urgent ? theme.warn : undefined} dimColor={!props.urgent}>
        {props.hint}
      </Text>
      <Text>
        {parts.map((p, i) => (
          <Text key={p.text}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color={p.color} dimColor={!p.color}>
              {p.text}
            </Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function placeholder(head: UiInteraction | null, mode: Mode, isAsk: boolean, target: string): string {
  const lead = target === 'orchestrator' ? null : target;
  if (!head)
    return lead ? `Message ${lead} directly (/lead goes back)` : 'Ask anything, or describe a workflow to write or run';
  if (mode === 'chat') return `Message ${lead ?? 'the assistant'} (Tab: back to the question)`;
  if (mode === 'note') return 'What should change? Enter sends, Esc goes back';
  if (isAsk) return 'Type an answer, or pick with ↑↓ and Enter';
  return `Press a key above, or Tab to message ${lead ?? 'the assistant'}`;
}

/** The questions an agent asks in this interaction (its own `AskUserQuestion` / `request_user_input`), if any. */
function questionsOf(item: UiInteraction): UserQuestion[] | null {
  if (item.source === 'question') return item.questions;
  if (item.source === 'run' && item.pending.interaction.kind === 'questions') return item.pending.interaction.questions;
  return null;
}

function answerKey(controller: Controller, head: UiInteraction, key: string, toNote: () => void): boolean {
  if (head.source === 'question') return false;
  if (head.source === 'assistant' || head.pending.interaction.kind === 'approval') {
    if (key === 'y') controller.answerApproval(head, { behavior: 'allow', scope: 'once', updatedInput: null });
    else if (key === 's') controller.answerApproval(head, { behavior: 'allow', scope: 'session', updatedInput: null });
    else if (key === 'n')
      controller.answerApproval(head, { behavior: 'deny', message: 'The user denied this.', interrupt: false });
    else return false;
    return true;
  }
  if (head.pending.interaction.kind === 'gate') {
    if (key === 'y' || key === 'a') controller.answerGate(head.id, 'approve');
    else if (key === 'c' || key === 'n') toNote();
    else if (key === 'x') controller.answerGate(head.id, 'abort');
    else return false;
    return true;
  }
  return false;
}

function answerText(controller: Controller, head: UiInteraction, value: string, mode: Mode): void {
  if (head.source !== 'run') return;
  const i = head.pending.interaction;
  if (i.kind === 'gate' && mode === 'note') {
    controller.answerGate(head.id, 'changes', value.trim() || null);
    return;
  }
  if (i.kind === 'ask') {
    const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
    const option = n !== null ? i.options[n - 1] : undefined;
    controller.answerAsk(head.id, option ?? value.trim());
  }
}

/** Every key at a glance, in the order they come up. */
function Shortcuts({ width }: { width: number }) {
  // Four columns, the border and padding taking two on each side.
  const column = Math.max(20, Math.floor((width - 4) / 4));
  const rows: [string, string][][] = [
    [
      ['enter', 'send'],
      ['shift+enter', 'new line'],
      ['↑↓', 'history'],
      ['tab', 'complete a command'],
    ],
    [
      ['esc', 'interrupt'],
      ['ctrl+c', 'clear, ×2 quits'],
      ['ctrl+o', 'show tool calls'],
      ['pgup/pgdn', 'scroll'],
    ],
    [
      ['ctrl+a/e', 'start/end of line'],
      ['ctrl+w', 'delete a word'],
      ['ctrl+u/k', 'delete to start/end'],
    ],
    [
      ['/', 'commands'],
      ['/help', 'all of them'],
      ['?', 'close this'],
    ],
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1} marginTop={1}>
      <Text bold>Shortcuts</Text>
      {rows.map((keys) => (
        <Box key={keys[0]?.[0]}>
          {keys.map(([k, label]) => (
            <Box key={k} width={column} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text color={theme.accent} bold>
                  {k}
                </Text>
                <Text dimColor> {label}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Keys({ keys }: { keys: [string, string][] }) {
  return (
    <Text>
      {keys.map(([k, label], i) => (
        <Text key={k}>
          {i > 0 ? '   ' : ''}
          <Text color={theme.accent} bold>
            {k}
          </Text>
          <Text dimColor> {label}</Text>
        </Text>
      ))}
    </Text>
  );
}

function Card(props: { tone: string; icon: string; title: string; source: string; children?: ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.tone} paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Box flexShrink={1}>
          <Text color={props.tone} bold>
            {props.icon} {props.title}
          </Text>
        </Box>
        <Text dimColor>{`  ${props.source}`}</Text>
      </Box>
      {props.children}
    </Box>
  );
}

function InteractionView(props: {
  item: UiInteraction;
  mode: Mode;
  option: number;
  queued: number;
  question: { list: UserQuestion[]; index: number; picked: number[] } | null;
}) {
  const { item, mode, option, queued } = props;
  const more = queued > 0 ? <Text dimColor>+{queued} more waiting after this</Text> : null;
  if (props.question) {
    const { list, index, picked } = props.question;
    const q = list[index] as UserQuestion;
    const from =
      item.source === 'question'
        ? (item.lead ?? 'assistant')
        : item.source === 'run'
          ? `${item.pending.interaction.runId} · ${item.pending.interaction.key}`
          : '';
    return (
      <Card
        tone={theme.info}
        icon={glyph.ask}
        title={q.question}
        source={`${from}${list.length > 1 ? ` · ${index + 1}/${list.length}` : ''}`}
      >
        {q.header ? <Text color={theme.info}>{`[${q.header}]`}</Text> : null}
        {q.options.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {q.options.map((o, n) => {
              const on = n === option;
              const mark = q.multiSelect ? (picked.includes(n) ? '◉ ' : '○ ') : '';
              return (
                <Box key={o.label} flexDirection="column">
                  <Text color={on ? theme.info : undefined} bold={on}>
                    {on ? '❯ ' : '  '}
                    {mark}
                    <Text dimColor={!on}>{n + 1}.</Text> {o.label}
                  </Text>
                  {o.description ? <Text dimColor>{`      ${o.description}`}</Text> : null}
                </Box>
              );
            })}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Keys
            keys={[
              ...(q.options.length > 0 ? ([['↑↓', 'move']] as [string, string][]) : []),
              ...(q.multiSelect ? ([['space', 'toggle']] as [string, string][]) : []),
              ['enter', q.multiSelect ? 'confirm' : q.options.length > 0 ? 'choose' : 'send'],
              ...(q.allowOther && q.options.length > 0 ? ([['type', 'your own answer']] as [string, string][]) : []),
              ['esc', 'decline'],
            ]}
          />
        </Box>
        {more}
      </Card>
    );
  }
  if (item.source === 'question') return null;
  if (item.source === 'assistant' || item.pending.interaction.kind === 'approval') {
    const tool = item.source === 'assistant' ? item.approval.tool : (item.pending.interaction as { tool: string }).tool;
    const input =
      item.source === 'assistant' ? item.approval.input : (item.pending.interaction as { input: unknown }).input;
    const source =
      item.source === 'assistant'
        ? (item.lead ?? 'assistant')
        : `${item.pending.interaction.runId} · ${item.pending.interaction.key}`;
    return (
      <Card tone={theme.warn} icon="⚠" title={`Allow ${tool}?`} source={source}>
        <Box marginY={1} paddingLeft={1}>
          <ToolInput input={input} />
        </Box>
        <Keys
          keys={[
            ['y', 'allow once'],
            ['s', 'allow for this session'],
            ['n', 'deny'],
            ['tab', 'message the assistant'],
          ]}
        />
        {more}
      </Card>
    );
  }
  const i = item.pending.interaction;
  if (i.kind === 'gate') {
    return (
      <Card tone={theme.warn} icon={glyph.gate} title={i.title} source={`${i.runId} · details above`}>
        <Box marginTop={1}>
          {mode === 'note' ? (
            <Text>
              <Text color={theme.warn}>Describe the changes</Text>
              <Text dimColor> below and press Enter · Esc to go back</Text>
            </Text>
          ) : (
            <Keys
              keys={[
                ['y', 'approve'],
                ['c', 'request changes'],
                ['x', 'abort the run'],
                ['tab', 'message the assistant'],
              ]}
            />
          )}
        </Box>
        {more}
      </Card>
    );
  }
  if (i.kind === 'ask') {
    return (
      <Card tone={theme.info} icon={glyph.ask} title={i.question} source={i.runId}>
        {i.options.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {i.options.map((o, n) => (
              <Text key={o} color={n === option ? theme.info : undefined} bold={n === option}>
                {n === option ? '❯ ' : '  '}
                <Text dimColor={n !== option}>{n + 1}.</Text> {o}
              </Text>
            ))}
          </Box>
        ) : null}
        {more}
      </Card>
    );
  }
  return null;
}

function ToolInput({ input }: { input: unknown }) {
  if (typeof input === 'object' && input !== null) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string')
      return (
        <Text>
          <Text color={theme.accent}>$ </Text>
          {clipLines(o.command, 12)}
        </Text>
      );
    if (typeof o.file_path === 'string') {
      const body = typeof o.content === 'string' ? o.content : typeof o.new_string === 'string' ? o.new_string : null;
      return (
        <Box flexDirection="column">
          <Text bold>{o.file_path}</Text>
          {body ? <Text dimColor>{clipLines(body, 8)}</Text> : null}
        </Box>
      );
    }
  }
  return <Text dimColor>{clipLines(JSON.stringify(input, null, 2) ?? '', 12)}</Text>;
}

const SHOW_FINISHED = 4;

function RunPanel(props: { run: RunView; frame: number; waiting: boolean; compact: boolean }) {
  const { run, frame, waiting } = props;
  const steps = run.steps.filter((s) => s.kind !== 'loop');
  const active = steps.filter((s) => s.status === 'started');
  const finished = steps.filter((s) => s.status !== 'started');
  const shown = finished.slice(-SHOW_FINISHED);
  const hidden = finished.length - shown.length;
  const failed = finished.filter((s) => s.status === 'failed').length;
  if (props.compact) {
    const now = active.at(-1);
    return (
      <Box paddingLeft={2}>
        <Text wrap="truncate-end">
          <Text color={theme.accent}>{active.length ? (SPINNER[frame % SPINNER.length] ?? '·') : glyph.brand} </Text>
          <Text bold>{run.workflow}</Text>
          <Text dimColor>
            {' '}
            {run.owner} · {finished.length} done
          </Text>
          {failed ? <Text color={theme.error}> · {failed} failed</Text> : null}
          {now ? <Text dimColor> · {now.label}</Text> : null}
        </Text>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={waiting ? theme.warn : theme.muted}
      paddingX={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.accent} bold>
            {glyph.brand} {run.workflow}
          </Text>
          <Text dimColor> {run.id}</Text>
          {run.owner ? <Text dimColor> · {run.owner}'s</Text> : null}
          {waiting ? <Text color={theme.warn}> · waiting for you</Text> : null}
        </Text>
        <Text dimColor>
          {finished.length} done{failed ? <Text color={theme.error}> · {failed} failed</Text> : null}
          {active.length ? ` · ${active.length} running` : ''} · {formatDuration(Date.now() - run.startedAt)}
        </Text>
      </Box>
      {hidden > 0 ? <Text dimColor>{`  … ${hidden} earlier step${hidden > 1 ? 's' : ''}`}</Text> : null}
      {shown.map((s) => (
        <StepLine key={s.key} step={s} frame={frame} />
      ))}
      {active.map((s) => (
        <StepLine key={s.key} step={s} frame={frame} />
      ))}
      {steps.length === 0 ? <Text dimColor>starting…</Text> : null}
    </Box>
  );
}

function StepLine({ step, frame }: { step: StepView; frame: number }) {
  const running = step.status === 'started';
  const icon = running
    ? (SPINNER[frame % SPINNER.length] ?? '·')
    : step.status === 'failed'
      ? glyph.fail
      : step.status === 'cached'
        ? glyph.cached
        : glyph.ok;
  const tone =
    step.status === 'failed' ? theme.error : running ? theme.warn : step.status === 'cached' ? theme.muted : theme.ok;
  const time = running
    ? formatDuration(Date.now() - step.startedAt)
    : step.endedAt && step.status !== 'cached'
      ? formatDuration(step.endedAt - step.startedAt)
      : '';
  // Labels default to the step key; show its scope (`T1/review/2/`) quieter than its name.
  const cut = step.label === step.key ? step.label.lastIndexOf('/') + 1 : 0;
  return (
    <Box justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={tone}>{icon}</Text> <Text dimColor>{step.label.slice(0, cut)}</Text>
          <Text dimColor={!running && step.status !== 'failed'} bold={running}>
            {step.label.slice(cut)}
          </Text>
          {step.engine ? <Text color={engineColor(step.engine)}> {step.engine}</Text> : null}
          {running && step.activity ? <Text dimColor> · {oneLine(step.activity, 70)}</Text> : null}
        </Text>
      </Box>
      <Text dimColor> {time}</Text>
    </Box>
  );
}

// ---- conversation -------------------------------------------------------------------------------

function Bullet(props: { mark: string; markColor?: string; marginTop?: number; children: ReactNode }) {
  return (
    <Box marginTop={props.marginTop ?? 0}>
      <Box width={2} flexShrink={0}>
        <Text color={props.markColor}>{props.mark}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        {props.children}
      </Box>
    </Box>
  );
}

const FEED_SHOWN = 5;

/**
 * The latest lead reports and messages, runs starting and finishing, workflow logs: one line each. Tool calls are
 * kept for `/activity` but not shown here (the busy line shows the current one).
 */
function Feed({ entries }: { entries: FeedEntry[] }) {
  const shown = entries.filter((e) => e.kind !== 'tool').slice(-FEED_SHOWN);
  if (shown.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text dimColor>
        <Text color={theme.accent} bold>
          activity
        </Text>{' '}
        /activity for more
      </Text>
      {shown.map((e) => {
        const tone = theme[feedTone(e)];
        return (
          <Text key={e.id} wrap="truncate-end">
            <Text dimColor>{`  ${clock(e.at)} `}</Text>
            <Text color={tone}>{feedMark(e)} </Text>
            <Text bold>{e.who}</Text>
            {e.tag ? <Text color={tone}> {e.tag}</Text> : null}
            <Text dimColor> {oneLine(e.text, 400)}</Text>
            {e.files.length ? <Text color={tone}> {e.files.join(', ')}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

const TEAM_ROWS = 10;

/** The leads that are not stopped, as a tree: what each is on, its runs and what waits for it. */
function TeamPanel({ rows, target, frame }: { rows: TeamRow[]; target: string; frame: number }) {
  const shown = rows.slice(0, TEAM_ROWS);
  const working = rows.filter((r) => r.status === 'working').length;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text dimColor>
        <Text color={theme.accent} bold>
          team
        </Text>{' '}
        {rows.length} lead{rows.length > 1 ? 's' : ''}
        {working ? ` · ${working} working` : ''} · /lead to talk to one
      </Text>
      {shown.map((r) => {
        const mark =
          r.status === 'working' || r.status === 'starting'
            ? (SPINNER[frame % SPINNER.length] ?? '·')
            : r.status === 'done'
              ? glyph.ok
              : '○';
        const tone = r.status === 'done' ? theme.ok : r.status === 'idle' ? theme.muted : theme.accent;
        return (
          <Text key={r.name} wrap="truncate-end">
            {'  '.repeat(r.depth)}
            <Text color={tone}>{mark} </Text>
            <Text bold color={r.name === target ? theme.accent : undefined}>
              {r.name}
            </Text>
            <Text dimColor> {r.role}</Text>
            {r.progress ? <Text dimColor> {`${r.progress.done}/${r.progress.total}`}</Text> : null}
            {r.doing ? <Text> · {r.doing}</Text> : null}
            {r.runs ? (
              <Text dimColor>
                {' '}
                · {r.runs} run{r.runs > 1 ? 's' : ''}
              </Text>
            ) : null}
            {r.waiting ? <Text color={theme.warn}> · {r.waiting} waiting</Text> : null}
            {r.inbox ? <Text dimColor> · {r.inbox} unread</Text> : null}
          </Text>
        );
      })}
      {rows.length > shown.length ? <Text dimColor>{`  … ${rows.length - shown.length} more (/team)`}</Text> : null}
    </Box>
  );
}

// Items never change once pushed: only new ones (or a new width) render.
const ItemView = memo(function ItemView({ item, width, showTools }: { item: Item; width: number; showTools: boolean }) {
  switch (item.type) {
    case 'tools':
      return <ToolsView item={item} open={showTools} />;
    case 'banner':
      return <BannerView banner={item.banner} width={width} />;
    case 'user':
      // A rule down the left of everything the user said, so their turns stand out in a long conversation.
      return (
        <Box
          marginTop={1}
          borderStyle="bold"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.user}
          paddingLeft={1}
        >
          <Text>
            {item.to ? <Text dimColor>to {item.to} </Text> : null}
            <Text color={theme.user} bold>
              {glyph.user}{' '}
            </Text>
            {item.text}
          </Text>
        </Box>
      );
    case 'assistant':
      return (
        <Bullet mark={glyph.assistant} markColor={item.speaker ? theme.accent : 'white'} marginTop={1}>
          {item.speaker ? (
            <Text color={theme.accent} bold>
              {item.speaker}
            </Text>
          ) : null}
          <Markdown text={item.text} width={width - 2} />
        </Bullet>
      );
    case 'info':
      return (
        <Box marginTop={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case 'panel':
      return <PanelView title={item.title} lines={item.lines} />;
    case 'error':
      return (
        <Bullet mark={glyph.fail} markColor={theme.error}>
          <Text color={theme.error}>{item.text}</Text>
        </Bullet>
      );
    case 'run':
      return <RunItem item={item} />;
    case 'gate': {
      const box = Math.min(width, 100);
      return (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1} width={box}>
          <Box justifyContent="space-between">
            <Box flexShrink={1}>
              <Text color={theme.warn} bold>
                {glyph.gate} {item.title}
              </Text>
            </Box>
            <Text dimColor>{`  ${item.workflow} · ${item.runId}`}</Text>
          </Box>
          {item.body ? (
            <Box marginTop={1}>
              {/* Border and padding take two columns on each side. */}
              <Markdown text={clipLines(item.body, 200)} width={box - 4} />
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'presentation':
      return <PresentationView presentation={item.presentation} />;
  }
});

/** The tool calls between two replies: one quiet line, or (Ctrl+O) one line each. */
function ToolsView({ item, open }: { item: Extract<Item, { type: 'tools' }>; open: boolean }) {
  const failed = item.calls.filter((c) => c.ok === false).length;
  const added = item.files.reduce((n, f) => n + f.added, 0);
  const removed = item.files.reduce((n, f) => n + f.removed, 0);
  const counts = new Map<string, number>();
  for (const c of item.calls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
  const rail = (
    <Box width={4} flexShrink={0} paddingLeft={2}>
      <Text dimColor>{glyph.result}</Text>
    </Box>
  );
  if (!open) {
    return (
      <Box>
        {rail}
        <Text wrap="truncate-end" dimColor>
          {[...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(' · ')}
          {item.files.length ? (
            <Text>
              {' · '}
              {item.files.length} file{item.files.length > 1 ? 's' : ''} <Text color={theme.ok}>+{added}</Text>{' '}
              <Text color={theme.error}>−{removed}</Text>
            </Text>
          ) : null}
          {failed ? <Text color={theme.error}> · {failed} failed</Text> : null}
          {'  ctrl+o'}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      {rail}
      <Box flexDirection="column" flexShrink={1}>
        {item.calls.map((c, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: calls are positional.
          <Text key={n} wrap="truncate-end">
            <Text color={c.ok === false ? theme.error : c.ok ? theme.ok : theme.muted}>
              {c.ok === false ? glyph.fail : c.ok ? glyph.ok : glyph.pending}{' '}
            </Text>
            <Text dimColor={c.ok !== false}>{c.line}</Text>
            {c.error ? <Text color={theme.error}> · {oneLine(c.error, 120)}</Text> : null}
          </Text>
        ))}
        {item.files.map((f) => (
          <Text key={f.path} wrap="truncate-end">
            <Text color={theme.info}>± </Text>
            {f.path} <Text color={theme.ok}>+{f.added}</Text> <Text color={theme.error}>−{f.removed}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function PresentationView({ presentation }: { presentation: Presentation }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent}>{glyph.brand} </Text>
        <Text bold>{presentation.title}</Text>
      </Text>
      {presentation.items.map((item) => (
        <Box key={item.target} flexDirection="column" paddingLeft={2}>
          {item.caption ? <Text>{item.caption}</Text> : null}
          <Text>
            <Text dimColor>{glyph.result} </Text>
            <Text color={theme.info} underline>
              {hyperlink(linkTarget(item), item.kind === 'url' ? item.target : tildify(item.target, homedir()))}
            </Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function RunItem({ item }: { item: Extract<Item, { type: 'run' }> }) {
  const took = item.durationMs !== null ? ` in ${formatDuration(item.durationMs)}` : '';
  const [icon, tone, verb, hint] =
    item.status === 'done'
      ? [glyph.ok, theme.ok, 'finished', null]
      : item.status === 'cancelled'
        ? ['■', theme.muted, 'cancelled', `/resume ${item.runId} picks it up again`]
        : [glyph.fail, theme.error, 'failed', `/resume ${item.runId} retries from the failed step`];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={tone}>{icon} </Text>
        <Text bold>{item.workflow}</Text>
        <Text color={tone}> {verb}</Text>
        <Text dimColor>
          {took} · run {item.runId}
        </Text>
      </Text>
      {item.detail ? (
        <Box paddingLeft={2}>
          <Box width={2} flexShrink={0}>
            <Text dimColor>{glyph.result}</Text>
          </Box>
          <Text color={item.status === 'failed' ? theme.error : undefined}>{item.detail}</Text>
        </Box>
      ) : null}
      {hint ? <Text dimColor>{`  ${hint}`}</Text> : null}
    </Box>
  );
}

function PanelView({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent}>{glyph.brand} </Text>
        <Text bold>{title}</Text>
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: panel lines are positional.
          <Text key={n}>
            {line.length === 0
              ? ' '
              : line.map((s, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
                  <Text key={k} color={color(s.color)} dimColor={s.dim} bold={s.bold}>
                    {s.text}
                  </Text>
                ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** How long the art takes to dissolve in. */
const REVEAL_MS = 900;

/** The splash art dissolving in, then the session at a glance and a few things to try. */
function BannerView({ banner, width }: { banner: Banner; width: number }) {
  const { rows } = useWindowSize();
  const size = splashSize(width - 2, rows || 24);
  const [reveal, setReveal] = useState(size === 'none' ? 1 : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the art dissolves in once, when it first shows.
  useEffect(() => {
    if (reveal >= 1) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / REVEAL_MS);
      setReveal(t);
      if (t >= 1) clearInterval(timer);
    }, 33);
    return () => clearInterval(timer);
  }, []);
  // Ease out: quick at first, settling at the end.
  const art = splash(width - 2, size, 1 - (1 - reveal) ** 3);
  const accounts = Object.entries(banner.accounts);
  const card = Math.min(width, 76);
  return (
    <Box flexDirection="column" alignItems="center" width={width} marginTop={1}>
      {art.length > 0 ? (
        <Box flexDirection="column" flexShrink={0}>
          {art.map((line, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: art rows are positional.
            <Text key={n}>{line || ' '}</Text>
          ))}
        </Box>
      ) : (
        <Text bold>{`${glyph.brand} L E G I O N`}</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          multi-agent workflows on <Text color={theme.claude}>claude</Text> and <Text color={theme.codex}>codex</Text>
          {banner.version ? ` · v${banner.version}` : ''}
        </Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={2} marginTop={1} width={card}>
        <Text wrap="truncate-middle">
          <Text dimColor>{'dir        '}</Text>
          <Text bold>{banner.cwd}</Text>
          {banner.branch ? <Text color={theme.ok}> ⎇ {banner.branch}</Text> : null}
          {banner.isGitRepo ? null : <Text color={theme.warn}> · not a git repository</Text>}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>{'accounts   '}</Text>
          {accounts.map(([kind, name], i) => (
            <Text key={kind}>
              {i > 0 ? <Text dimColor> · </Text> : null}
              <Text color={engineColor(kind)}>{kind}</Text>
              {name !== kind ? <Text> {name}</Text> : null}
            </Text>
          ))}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>{'assistant  '}</Text>
          {banner.assistant}
          <Text dimColor>
            {' · '}
            {banner.workflows} workflow{banner.workflows === 1 ? '' : 's'} ready
          </Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            Try · <Text color={theme.accent}>tab</Text> fills one in
          </Text>
          {TRY.map((t) => (
            <Text key={t} wrap="truncate-end">
              <Text color={theme.accent}>{`  ${glyph.user} `}</Text>
              {t}
            </Text>
          ))}
        </Box>
      </Box>
      {banner.createdConfig ? (
        <Box width={card} paddingX={1}>
          <Text wrap="truncate-end">
            <Text color={theme.ok}>{`${glyph.ok} `}</Text>
            <Text dimColor>Created </Text>
            {banner.createdConfig}
            <Text dimColor> with the settings in effect · /config to see or edit them</Text>
          </Text>
        </Box>
      ) : null}
      <Box width={card} paddingX={1}>
        <Keys
          keys={[
            ['/', 'commands'],
            ['/help', 'keys'],
            ['esc', 'interrupt'],
            ['ctrl+c ×2', 'quit'],
          ]}
        />
      </Box>
    </Box>
  );
}

/** Starters on the welcome card: one of each thing the assistant does. */
const TRY = [
  'review my branch with both engines and fix what they agree on',
  'write a workflow: plan, build in parallel worktrees, open a PR',
  'what workflows do I have, and what does each one do?',
];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
