/**
 * The terminal UI: finished conversation items go to `<Static>` (printed once, scrollable in the terminal); the
 * live region below shows the streaming reply, active runs, the interaction waiting for the user, the prompt and
 * a status line.
 */
import { Box, Static, Text, useApp } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Controller } from './controller.ts';
import { PromptInput } from './input.tsx';
import { clipLines, type Item, oneLine, type RunView, type StepView, type UiInteraction } from './store.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function App({ controller }: { controller: Controller }) {
  const { store } = controller;
  const state = useSyncExternalStore(store.subscribe, store.get);
  const app = useApp();
  const [frame, setFrame] = useState(0);
  const [mode, setMode] = useState<'hotkeys' | 'note' | 'chat'>('hotkeys');
  const [armedExit, setArmedExit] = useState(false);
  const head = state.interactions[0] ?? null;
  const animating = state.busy || state.runs.length > 0;

  useEffect(() => {
    controller.attach({
      exit: () => app.exit(),
      suspend: (run) => app.suspendTerminal(run),
    });
  }, [controller, app]);

  useEffect(() => {
    if (!animating) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, [animating]);

  // A new head interaction starts in hotkey mode (questions take text right away).
  const headId = head?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect is about the head changing, not reading it.
  useEffect(() => {
    setMode('hotkeys');
  }, [headId]);

  const spinner = SPINNER[frame % SPINNER.length] ?? '·';
  const answering = head !== null && mode !== 'chat';
  const isAsk = head?.source === 'run' && head.pending.interaction.kind === 'ask';

  const submit = (value: string) => {
    setArmedExit(false);
    if (head && answering && (isAsk || mode === 'note')) {
      answerText(controller, head, value, mode);
      return;
    }
    void controller.submit(value);
    if (mode === 'chat') setMode('hotkeys');
  };

  const hotkey = (key: string): boolean => {
    if (!head || !answering || isAsk || mode === 'note') return false;
    return answerKey(controller, head, key.toLowerCase(), () => setMode('note'));
  };

  return (
    <>
      <Static items={state.items}>{(item) => <ItemView key={item.id} item={item} />}</Static>
      <Box flexDirection="column">
        {state.streaming ? <Text>{tail(state.streaming, 30)}</Text> : null}
        {state.busy ? (
          <Text color="magenta">
            {spinner} {state.activity ?? 'working'}… <Text dimColor>(Esc to interrupt)</Text>
          </Text>
        ) : null}
        {state.runs.map((run) => (
          <RunPanel key={run.id} run={run} spinner={spinner} />
        ))}
        {head ? <InteractionView item={head} mode={mode} queued={state.interactions.length - 1} /> : null}
        <Box marginTop={head || state.runs.length ? 0 : 1}>
          <PromptInput
            prompt={answering && (isAsk || mode === 'note') ? '?' : '›'}
            placeholder={placeholder(head, mode, isAsk)}
            isActive
            onSubmit={submit}
            onEmptyKey={hotkey}
            onEscape={() => {
              if (mode !== 'hotkeys') setMode('hotkeys');
              else void controller.interrupt();
            }}
            onTab={() => head && setMode((m) => (m === 'chat' ? 'hotkeys' : 'chat'))}
            onCtrlC={() => {
              if (state.busy) {
                void controller.interrupt();
                return;
              }
              if (armedExit) app.exit();
              else {
                setArmedExit(true);
                store.info('Press Ctrl+C again to exit.');
              }
            }}
          />
        </Box>
        <Text dimColor>
          {Object.entries(state.profiles)
            .map(([k, v]) => (k === v ? k : `${k}: ${v}`))
            .join(' · ')}
          {state.costUsd !== null ? ` · assistant $${state.costUsd.toFixed(2)}` : ''} · /help
        </Text>
      </Box>
    </>
  );
}

function placeholder(head: UiInteraction | null, mode: string, isAsk: boolean): string {
  if (!head || mode === 'chat')
    return head
      ? 'message the assistant (Tab: back to the prompt above)'
      : 'ask, or describe a workflow to write or run';
  if (mode === 'note') return 'what should change? (Esc: back)';
  if (isAsk) return 'type an answer or an option number';
  return '';
}

function answerKey(controller: Controller, head: UiInteraction, key: string, toNote: () => void): boolean {
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

function answerText(controller: Controller, head: UiInteraction, value: string, mode: string): void {
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

function InteractionView({ item, mode, queued }: { item: UiInteraction; mode: string; queued: number }) {
  const more = queued > 0 ? <Text dimColor> (+{queued} more waiting)</Text> : null;
  if (item.source === 'assistant' || item.pending.interaction.kind === 'approval') {
    const tool = item.source === 'assistant' ? item.approval.tool : (item.pending.interaction as { tool: string }).tool;
    const input =
      item.source === 'assistant' ? item.approval.input : (item.pending.interaction as { input: unknown }).input;
    const who =
      item.source === 'assistant'
        ? 'assistant'
        : `run ${item.pending.interaction.runId} · ${item.pending.interaction.key}`;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text>
          <Text color="yellow" bold>
            Allow {tool}?
          </Text>{' '}
          <Text dimColor>({who})</Text>
          {more}
        </Text>
        <Text>{clipLines(describeInput(input), 12)}</Text>
        <Text dimColor>[y] allow once · [s] allow for this session · [n] deny · Tab: message the assistant</Text>
      </Box>
    );
  }
  const i = item.pending.interaction;
  if (i.kind === 'gate') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text>
          <Text color="yellow" bold>
            ⏸ {i.title}
          </Text>{' '}
          <Text dimColor>(run {i.runId}; details above)</Text>
          {more}
        </Text>
        <Text dimColor>
          {mode === 'note'
            ? 'Describe the changes and press Enter.'
            : '[y] approve · [c] request changes · [x] abort the run · Tab: message the assistant'}
        </Text>
      </Box>
    );
  }
  if (i.kind === 'ask') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text>
          <Text color="cyan" bold>
            ? {i.question}
          </Text>{' '}
          <Text dimColor>(run {i.runId})</Text>
          {more}
        </Text>
        {i.options.map((o, n) => (
          <Text key={o}>
            {'  '}
            {n + 1}. {o}
          </Text>
        ))}
      </Box>
    );
  }
  return null;
}

function describeInput(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') return `$ ${o.command}`;
    if (typeof o.file_path === 'string') return String(o.file_path);
  }
  return JSON.stringify(input, null, 2) ?? '';
}

function RunPanel({ run, spinner }: { run: RunView; spinner: string }) {
  const active = run.steps.filter((s) => s.status === 'started' && s.kind !== 'loop');
  const finished = run.steps.filter((s) => s.status !== 'started' && s.kind !== 'loop').slice(-3);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="blue" bold>
          ◆ {run.workflow}
        </Text>{' '}
        <Text dimColor>{run.id}</Text>
      </Text>
      {finished.map((s) => (
        <StepLine key={s.key} step={s} spinner={spinner} />
      ))}
      {active.map((s) => (
        <StepLine key={s.key} step={s} spinner={spinner} />
      ))}
    </Box>
  );
}

function StepLine({ step, spinner }: { step: StepView; spinner: string }) {
  const icon =
    step.status === 'started' ? spinner : step.status === 'failed' ? '✗' : step.status === 'cached' ? '↺' : '✓';
  const color = step.status === 'failed' ? 'red' : step.status === 'started' ? 'yellow' : 'green';
  const elapsed = step.status === 'started' ? ` ${formatDuration(Date.now() - step.startedAt)}` : '';
  return (
    <Text>
      {'  '}
      <Text color={color}>{icon}</Text> {oneLine(step.label, 70)}
      {step.activity ? <Text dimColor> · {oneLine(step.activity, 60)}</Text> : null}
      <Text dimColor>{elapsed}</Text>
    </Text>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            › {item.text}
          </Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Markdown text={item.text} />
        </Box>
      );
    case 'tool':
      return (
        <Text dimColor>
          {'  '}⏺ {item.name}
          {item.summary ? ` ${item.summary}` : ''}
        </Text>
      );
    case 'info':
      return <Text dimColor>{item.text}</Text>;
    case 'error':
      return <Text color="red">{item.text}</Text>;
    case 'run':
      return (
        <Box marginTop={1}>
          <Text color={item.status === 'failed' ? 'red' : item.status === 'done' ? 'green' : 'blue'}>
            ◆ {item.text}
          </Text>
        </Box>
      );
    case 'gate':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>
            ⏸ {item.title}
          </Text>
          {item.body ? <Markdown text={clipLines(item.body, 200)} /> : null}
        </Box>
      );
  }
}

/** Just enough markdown for a terminal: headings bold, fenced code dim, bullets as-is. */
function Markdown({ text }: { text: string }) {
  let fenced = false;
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, i) => {
        const key = `${i}`;
        if (line.startsWith('```')) {
          fenced = !fenced;
          return null;
        }
        if (fenced) return <Text key={key} dimColor>{`  ${line}`}</Text>;
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading)
          return (
            <Text key={key} bold>
              {heading[2]}
            </Text>
          );
        return <Text key={key}>{line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')}</Text>;
      })}
    </Box>
  );
}

function tail(text: string, lines: number): string {
  const all = text.split('\n');
  return all.length > lines ? all.slice(-lines).join('\n') : text;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
