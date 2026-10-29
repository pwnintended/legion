/**
 * The UI's state, fed by the session's events and independent of React: `items` is the append-only conversation
 * (shown in the scrollable view that fills the screen above the prompt) and holds the conversation only — what the user said, the replies,
 * gates, answers, errors and the user's own runs finishing. Everything else is the live region: streaming
 * assistant text, the queue of things waiting for the user (gates, questions, tool approvals from the assistant or
 * from workflow agents), and under the prompt the active runs, the team and the activity `feed` (tool calls, lead
 * reports and messages, runs starting, workflow logs).
 */
import type { AssistantApproval, AssistantQuestion } from '../assistant/assistant.ts';
import type { AgentEvent, UserQuestion } from '../engine/types.ts';
import type { Presentation } from '../team/team.ts';
import type { RunEvent } from '../workflow/host.ts';
import type { RunRecord, StepKind } from '../workflow/journal.ts';
import type { PendingInteraction } from '../workflow/manager.ts';
import type { Attachment } from './attachments.ts';
import { glyph, type ThemeColor } from './theme.ts';

/** A styled piece of a line in a panel. Colors are theme names (see theme.ts) or Ink colors. */
export interface Seg {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}
export type Line = Seg[];

export interface Banner {
  version: string;
  cwd: string;
  branch: string | null;
  isGitRepo: boolean;
  profiles: Record<string, string>;
  assistant: string;
  workflows: number;
  createdConfig: string | null;
}

export type Item =
  | { id: number; type: 'banner'; banner: Banner }
  /** `to`: the lead the user was talking to (absent: the orchestrator). */
  | { id: number; type: 'user'; text: string; to?: string; images?: Attachment[] }
  /** `speaker`: a lead, or the orchestrator while the user talks to a lead (absent: the agent being talked to). */
  | { id: number; type: 'assistant'; text: string; speaker?: string }
  | { id: number; type: 'info'; text: string }
  | { id: number; type: 'panel'; title: string; lines: Line[] }
  | { id: number; type: 'error'; text: string }
  | {
      id: number;
      type: 'run';
      runId: string;
      workflow: string;
      status: 'done' | 'failed' | 'cancelled';
      /** done: the result; failed/cancelled: the error. */
      detail: string | null;
      durationMs: number | null;
    }
  | { id: number; type: 'gate'; runId: string; workflow: string; title: string; body: string | null }
  /** The tool calls between two replies, folded into one line (Ctrl+O shows each). */
  | { id: number; type: 'tools'; calls: ToolCallView[]; files: FileChangeView[]; speaker?: string }
  /** Something the orchestrator shows the user (`present`): a link to each item. */
  | { id: number; type: 'presentation'; presentation: Presentation };

export interface ToolCallView {
  /** `Bash`, `Run workflow`: what kind of call, to count them. */
  tool: string;
  line: string;
  /** null: still running (or its result never came). */
  ok: boolean | null;
  /** The first line of what a failed call returned. */
  error: string | null;
}

export interface FileChangeView {
  path: string;
  added: number;
  removed: number;
}

/** One line of the activity feed under the prompt; `/activity` prints the recent ones in full. */
export interface FeedEntry {
  id: number;
  at: number;
  /** Who it is about: the orchestrator, a lead, or a workflow. */
  who: string;
  kind: 'tool' | 'spawn' | 'report' | 'stop' | 'message' | 'run' | 'log' | 'error';
  /** A report's kind (done, question, …) or a run's status. */
  tag: string | null;
  text: string;
  files: string[];
}

/** How many feed entries are kept (for `/activity`). */
export const FEED_KEPT = 200;

const REPORT_TONE: Record<string, ThemeColor> = {
  done: 'ok',
  blocked: 'error',
  question: 'warn',
  review: 'warn',
  coordinate: 'info',
};

export function feedTone(e: FeedEntry): ThemeColor {
  if (e.kind === 'error' || e.tag === 'failed') return 'error';
  if (e.kind === 'report') return REPORT_TONE[e.tag ?? ''] ?? 'accent';
  if (e.tag === 'done') return 'ok';
  if (e.kind === 'log' || e.kind === 'tool') return 'muted';
  return 'accent';
}

export function feedMark(e: FeedEntry): string {
  switch (e.kind) {
    case 'spawn':
      return '◆';
    case 'stop':
      return '■';
    case 'run':
      return e.tag === 'done' ? glyph.ok : e.tag === 'failed' ? glyph.fail : glyph.brand;
    case 'error':
      return glyph.fail;
    case 'tool':
      return glyph.tool;
    case 'log':
      return '│';
    default:
      return '↑';
  }
}

/** `14:03`. */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'id'> : never) : never;

export interface StepView {
  key: string;
  label: string;
  kind: StepKind;
  status: 'started' | 'done' | 'failed' | 'cached';
  detail: string | null;
  /** What a running agent step is doing right now. */
  activity: string | null;
  engine: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RunView {
  id: string;
  workflow: string;
  /** The lead that started it (absent: the orchestrator). */
  owner?: string;
  steps: StepView[];
  startedAt: number;
}

export type UiInteraction =
  | { source: 'run'; id: string; pending: PendingInteraction }
  /** A tool approval of the assistant's own session, or of a lead's (`lead`) whose role has the human answer them. */
  | { source: 'assistant'; id: string; approval: AssistantApproval; lead?: string }
  /** Questions the assistant (or a lead, `lead`) asks the user itself. */
  | { source: 'question'; id: string; questions: UserQuestion[]; lead?: string };

/** One lead in the live team panel, in tree order. */
export interface TeamRow {
  name: string;
  role: string;
  depth: number;
  status: 'starting' | 'working' | 'idle' | 'done' | 'stopped';
  /** The plan item it is on. */
  doing: string | null;
  progress: { done: number; total: number } | null;
  runs: number;
  /** Gates and questions of its runs that wait for its answer. */
  waiting: number;
  inbox: number;
  costUsd: number;
}

export interface UiState {
  items: Item[];
  streaming: string;
  busy: boolean;
  /** When the assistant's current turn started. */
  busySince: number | null;
  activity: string | null;
  runs: RunView[];
  interactions: UiInteraction[];
  /** A menu that has the keyboard (`/config`). */
  menu: 'config' | 'workflows' | null;
  /** Text to put in the prompt (a command for the user to finish); `n` changes each time. */
  seed: { text: string; n: number } | null;
  profiles: Record<string, string>;
  costUsd: number | null;
  /** The assistant session's tokens so far, and its output tokens when the current turn started. */
  tokens: { input: number; output: number; outputAtTurnStart: number } | null;
  /** Show each tool call of the folded tool lines (Ctrl+O). */
  showTools: boolean;
  /** Who the prompt talks to: `orchestrator` or a lead's name (`/lead`). */
  target: string;
  team: TeamRow[];
  feed: FeedEntry[];
  /** Images attached to the message being written (Ctrl+V, or files pasted onto the prompt). */
  attachments: Attachment[];
}

export class UiStore {
  private state: UiState;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  /** The feed line of each tool call of the assistant or a lead still running, so a failure names what failed. */
  private readonly toolLines = new Map<string, string>();
  private scheduled: NodeJS.Timeout | null = null;
  /** The tool calls and file changes since the last reply, pushed as one `tools` item before the next. */
  private calls: (ToolCallView & { id: string })[] = [];
  private files = new Map<string, FileChangeView>();

  constructor(initial: Partial<UiState> = {}) {
    this.state = {
      items: [],
      streaming: '',
      busy: false,
      busySince: null,
      activity: null,
      runs: [],
      interactions: [],
      menu: null,
      seed: null,
      profiles: {},
      costUsd: null,
      tokens: null,
      showTools: false,
      target: 'orchestrator',
      team: [],
      feed: [],
      attachments: [],
      ...initial,
    };
  }

  get = (): UiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>), urgent = true): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    if (urgent) this.flush();
    else this.schedule();
  }

  push(item: NewItem): void {
    const withId = { ...item, id: this.nextId++ } as Item;
    this.update((s) => ({ items: [...s.items, withId] }));
  }

  /** Takes the welcome banner out, so the session has the whole window. */
  dropBanner(): void {
    if (this.state.items.some((i) => i.type === 'banner'))
      this.update((s) => ({ items: s.items.filter((i) => i.type !== 'banner') }));
  }

  info(text: string): void {
    this.push({ type: 'info', text });
  }

  error(text: string): void {
    this.push({ type: 'error', text });
  }

  panel(title: string, lines: Line[]): void {
    this.push({ type: 'panel', title, lines });
  }

  present(presentation: Presentation): void {
    this.push({ type: 'presentation', presentation });
  }

  /** A line in the activity feed (not the conversation). */
  note(entry: Omit<FeedEntry, 'id' | 'at' | 'tag' | 'files'> & { tag?: string | null; files?: string[] }): void {
    const full: FeedEntry = { tag: null, files: [], ...entry, id: this.nextId++, at: Date.now() };
    this.update((s) => ({ feed: [...s.feed.slice(-(FEED_KEPT - 1)), full] }), false);
  }

  // ---- assistant -----------------------------------------------------------------------------

  /** The tool calls since the last reply as one item, then the reply. */
  private reply(text: string, speaker?: string): void {
    this.foldTools(speaker);
    if (text) this.push({ type: 'assistant', text, ...(speaker ? { speaker } : {}) });
  }

  private foldTools(speaker?: string): void {
    if (this.calls.length === 0 && this.files.size === 0) return;
    const calls = this.calls.map(({ id: _, ...c }) => c);
    const files = [...this.files.values()];
    this.calls = [];
    this.files = new Map();
    this.push({ type: 'tools', calls, files, ...(speaker ? { speaker } : {}) });
  }

  /** Events of the agent the user is talking to (`speaker`: a lead's name, when it is one). */
  assistantEvent(event: AgentEvent, speaker?: string): void {
    const who = speaker ?? 'orchestrator';
    switch (event.type) {
      case 'text_delta':
        this.update((s) => ({ streaming: s.streaming + event.text, activity: null }), false);
        break;
      case 'message':
        this.update({ streaming: '' }, false);
        this.reply(event.text.trim(), speaker);
        break;
      case 'tool_call': {
        // Text streamed before a tool call is a reply in its own right.
        if (this.state.streaming.trim()) this.reply(this.state.streaming.trim(), speaker);
        const line = toolLine(event.name, event.input);
        this.update({ streaming: '', activity: line }, false);
        this.note({ who, kind: 'tool', text: line });
        this.toolLines.set(event.id, line);
        this.calls.push({ id: event.id, tool: toolLabel(event.name), line, ok: null, error: null });
        break;
      }
      case 'file_change': {
        const prev = this.files.get(event.path);
        this.files.set(event.path, {
          path: event.path,
          added: (prev?.added ?? 0) + event.added,
          removed: (prev?.removed ?? 0) + event.removed,
        });
        break;
      }
      case 'tool_result': {
        // A failed tool call (a command that exited non-zero, often harmless), not the agent failing: a tool line for
        // /activity, so the feed does not read as if the agent stopped while the busy line still spins.
        const line = this.toolLines.get(event.id);
        this.toolLines.delete(event.id);
        const call = this.calls.find((c) => c.id === event.id);
        if (call) {
          call.ok = event.ok;
          call.error = event.ok ? null : (event.output?.trim().split('\n')[0] ?? null);
        }
        if (!event.ok && event.output)
          this.note({
            who,
            kind: 'tool',
            tag: 'failed',
            text: line ? `${line} · ${event.output.trim()}` : event.output.trim(),
          });
        break;
      }
      case 'activity':
        this.update(
          { activity: event.activity === 'tool_input' ? `writing ${toolName(event.tool ?? 'tool')}` : event.activity },
          false,
        );
        break;
      case 'usage':
        if (speaker) break;
        this.update(
          (s) => ({
            ...(event.costUsd !== null ? { costUsd: event.costUsd } : {}),
            tokens: {
              input: event.inputTokens,
              output: event.outputTokens,
              outputAtTurnStart: s.tokens?.outputAtTurnStart ?? 0,
            },
          }),
          false,
        );
        break;
      case 'error':
        if (!event.retryable) this.error(event.message);
        break;
      case 'turn_complete':
        if (event.isError && event.reason && event.reason !== 'interrupted') this.error(`Turn failed: ${event.reason}`);
        this.reply(this.state.streaming.trim(), speaker);
        this.update({ streaming: '', activity: null });
        break;
      default:
        break;
    }
  }

  setBusy(busy: boolean): void {
    if (busy === this.state.busy) return;
    this.update((s) => ({
      busy,
      busySince: busy ? Date.now() : null,
      ...(busy ? {} : { activity: null }),
      ...(busy && s.tokens ? { tokens: { ...s.tokens, outputAtTurnStart: s.tokens.output } } : {}),
    }));
  }

  assistantApproval(approval: AssistantApproval, lead?: string): void {
    this.update((s) => ({
      interactions: [...s.interactions, { source: 'assistant', id: approval.id, approval, ...(lead ? { lead } : {}) }],
    }));
  }

  assistantQuestion(question: AssistantQuestion, lead?: string): void {
    this.update((s) => ({
      interactions: [
        ...s.interactions,
        { source: 'question', id: question.id, questions: question.questions, ...(lead ? { lead } : {}) },
      ],
    }));
  }

  resolved(id: string): void {
    this.update((s) => ({ interactions: s.interactions.filter((i) => i.id !== id) }));
  }

  // ---- runs ----------------------------------------------------------------------------------

  runEvent(event: RunEvent, lookup: (runId: string) => RunRecord | null): void {
    switch (event.type) {
      case 'run': {
        const record = lookup(event.runId);
        const workflow = record?.workflow ?? '?';
        if (event.status === 'running') {
          if (!this.state.runs.some((r) => r.id === event.runId)) {
            this.update((s) => ({
              runs: [
                ...s.runs,
                {
                  id: event.runId,
                  workflow,
                  ...(record?.owner ? { owner: record.owner } : {}),
                  steps: [],
                  startedAt: Date.now(),
                },
              ],
            }));
            this.note({
              who: workflow,
              kind: 'run',
              tag: 'started',
              text: `run ${event.runId}${record?.owner ? ` · ${record.owner}'s` : ''}`,
            });
          }
          return;
        }
        if (event.status === 'waiting' || event.status === 'interrupted') return;
        const view = this.state.runs.find((r) => r.id === event.runId);
        this.update((s) => ({ runs: s.runs.filter((r) => r.id !== event.runId) }));
        const status = event.status === 'done' ? 'done' : event.status === 'cancelled' ? 'cancelled' : 'failed';
        const detail =
          status === 'done'
            ? event.result === null || event.result === undefined
              ? null
              : clipLines(formatValue(event.result), 16)
            : (event.error ?? (status === 'failed' ? 'unknown error' : null));
        const owner = view?.owner ?? record?.owner;
        if (owner) {
          // A lead's run: the lead hears about it and reports; the user sees it in the feed.
          this.note({
            who: workflow,
            kind: 'run',
            tag: status,
            text: `${owner}'s run ${event.runId}${detail ? `: ${detail}` : ''}`,
          });
          return;
        }
        this.push({
          type: 'run',
          runId: event.runId,
          workflow,
          status,
          detail,
          durationMs: view ? Date.now() - view.startedAt : null,
        });
        return;
      }
      case 'step': {
        this.updateRun(event.runId, (run) => {
          const steps = run.steps.filter((s) => s.key !== event.key);
          const prev = run.steps.find((s) => s.key === event.key);
          steps.push({
            key: event.key,
            label: event.label,
            kind: event.kind,
            status: event.status,
            detail: event.detail ?? null,
            activity: event.status === 'started' ? (prev?.activity ?? null) : null,
            engine: event.engine ?? prev?.engine ?? null,
            startedAt: prev?.startedAt ?? Date.now(),
            endedAt: event.status === 'started' ? null : Date.now(),
          });
          return { ...run, steps };
        });
        if (event.status === 'failed' && event.detail && !/cancelled|aborted/i.test(event.detail)) {
          this.error(`${event.label}: ${clipLines(event.detail, 8)}`);
        }
        return;
      }
      case 'agent': {
        const activity = agentActivity(event.event);
        if (activity === undefined) return;
        this.updateRun(
          event.runId,
          (run) => ({ ...run, steps: run.steps.map((s) => (s.key === event.key ? { ...s, activity } : s)) }),
          false,
        );
        return;
      }
      case 'log':
        this.note({ who: this.workflowOf(event.runId, lookup), kind: 'log', text: event.message });
        return;
    }
  }

  runInteraction(pending: PendingInteraction): void {
    const i = pending.interaction;
    if (i.kind === 'gate') {
      const workflow = this.state.runs.find((r) => r.id === i.runId)?.workflow ?? '?';
      this.push({ type: 'gate', runId: i.runId, workflow, title: i.title, body: i.body });
    }
    this.update((s) => ({ interactions: [...s.interactions, { source: 'run', id: pending.id, pending }] }));
  }

  private workflowOf(runId: string, lookup: (runId: string) => RunRecord | null): string {
    return this.state.runs.find((r) => r.id === runId)?.workflow ?? lookup(runId)?.workflow ?? runId;
  }

  private updateRun(runId: string, fn: (run: RunView) => RunView, urgent = true): void {
    this.update((s) => ({ runs: s.runs.map((r) => (r.id === runId ? fn(r) : r)) }), urgent);
  }

  // ---- rendering cadence ---------------------------------------------------------------------

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.flush();
    }, 33);
  }

  private flush(): void {
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    for (const l of this.listeners) l();
  }
}

/** `mcp__legion__run_workflow` → `legion.run_workflow`. */
export function toolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return m ? `${m[1]}.${m[2]}` : name;
}

/** `Bash cd src`, `Run workflow feature`: a tool call in one line. */
export function toolLine(name: string, input: unknown): string {
  const summary = summarizeInput(name, input);
  return `${toolLabel(name)}${summary ? ` ${summary}` : ''}`;
}

/** `Bash`, `Run workflow` (Legion's own tools by what they do). */
export function toolLabel(name: string): string {
  const short = toolName(name);
  return short.startsWith('legion.') ? (LEGION_TOOLS[short.slice('legion.'.length)] ?? short) : short;
}

const LEGION_TOOLS: Record<string, string> = {
  list_workflows: 'List workflows',
  read_workflow: 'Read workflow',
  eject_workflow: 'Eject workflow',
  validate_workflow: 'Validate',
  run_workflow: 'Run workflow',
  list_runs: 'List runs',
  run_status: 'Run status',
  resume_run: 'Resume run',
  cancel_run: 'Cancel run',
};

export function summarizeInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.name ?? o.description;
  if (typeof pick === 'string') return oneLine(pick, 100);
  if (name.startsWith('mcp__')) return oneLine(JSON.stringify(input), 100);
  return '';
}

/** A line for a running agent step; undefined = this event does not change it. */
function agentActivity(event: AgentEvent): string | null | undefined {
  switch (event.type) {
    case 'tool_call': {
      const summary = summarizeInput(event.name, event.input);
      return `${toolName(event.name)}${summary ? ` ${summary}` : ''}`;
    }
    case 'activity':
      return event.activity === 'output'
        ? 'writing result'
        : event.activity === 'thinking'
          ? 'thinking'
          : `writing ${event.tool ?? ''}`;
    case 'approval_request':
      return `waiting for approval: ${event.tool}`;
    case 'text_delta':
      return 'writing';
    default:
      return undefined;
  }
}

/** A value as readable lines: `key: value`, nested objects indented, lists as `- item`. */
export function formatValue(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return `${indent}—`;
  if (typeof value !== 'object') return `${indent}${String(value)}`;
  const scalar = (v: unknown) => v === null || typeof v !== 'object';
  const show = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
  const entries: [string | null, unknown][] = Array.isArray(value)
    ? value.map((v) => [null, v])
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${indent}${Array.isArray(value) ? '(none)' : '{}'}`;
  return entries
    .map(([k, v]) => {
      const head = k === null ? `${indent}- ` : `${indent}${k}: `;
      if (scalar(v) && !String(v).includes('\n')) return `${head}${show(v)}`;
      if (scalar(v)) return `${head}\n${String(v).replace(/^/gm, `${indent}  `)}`;
      return `${head.trimEnd()}\n${formatValue(v, `${indent}  `)}`;
    })
    .join('\n');
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clipLines(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length > max ? `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more lines)` : text;
}
