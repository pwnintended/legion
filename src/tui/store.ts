/**
 * The UI's state, fed by the session's events and independent of React: `items` is the append-only scrollback
 * (printed once, then owned by the terminal) and holds the conversation only — what the user said, the replies,
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
  | { id: number; type: 'user'; text: string; to?: string }
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
  | { id: number; type: 'gate'; runId: string; workflow: string; title: string; body: string | null };

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
  /** Who the prompt talks to: `orchestrator` or a lead's name (`/lead`). */
  target: string;
  team: TeamRow[];
  feed: FeedEntry[];
  /** Things to show the user (`present`), waiting to be written into the scrollback (images need raw output). */
  presentations: { id: number; presentation: Presentation }[];
}

export class UiStore {
  private state: UiState;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private scheduled: NodeJS.Timeout | null = null;

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
      target: 'orchestrator',
      team: [],
      feed: [],
      presentations: [],
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
    const id = this.nextId++;
    this.update((s) => ({ presentations: [...s.presentations, { id, presentation }] }));
  }

  presented(id: number): void {
    this.update((s) => ({ presentations: s.presentations.filter((p) => p.id !== id) }), false);
  }

  /** A line in the activity feed (not the scrollback). */
  note(entry: Omit<FeedEntry, 'id' | 'at' | 'tag' | 'files'> & { tag?: string | null; files?: string[] }): void {
    const full: FeedEntry = { tag: null, files: [], ...entry, id: this.nextId++, at: Date.now() };
    this.update((s) => ({ feed: [...s.feed.slice(-(FEED_KEPT - 1)), full] }), false);
  }

  // ---- assistant -----------------------------------------------------------------------------

  /** Events of the agent the user is talking to (`speaker`: a lead's name, when it is one). */
  assistantEvent(event: AgentEvent, speaker?: string): void {
    const said = speaker ? { speaker } : {};
    const who = speaker ?? 'orchestrator';
    switch (event.type) {
      case 'text_delta':
        this.update((s) => ({ streaming: s.streaming + event.text, activity: null }), false);
        break;
      case 'message':
        this.update({ streaming: '' }, false);
        if (event.text.trim()) this.push({ type: 'assistant', text: event.text.trim(), ...said });
        break;
      case 'tool_call': {
        // Text streamed before a tool call is a reply in its own right.
        if (this.state.streaming.trim()) this.push({ type: 'assistant', text: this.state.streaming.trim(), ...said });
        const line = toolLine(event.name, event.input);
        this.update({ streaming: '', activity: line }, false);
        this.note({ who, kind: 'tool', text: line });
        break;
      }
      case 'tool_result':
        if (!event.ok && event.output) this.note({ who, kind: 'error', text: event.output.trim() });
        break;
      case 'activity':
        this.update(
          { activity: event.activity === 'tool_input' ? `writing ${toolName(event.tool ?? 'tool')}` : event.activity },
          false,
        );
        break;
      case 'usage':
        if (event.costUsd !== null && !speaker) this.update({ costUsd: event.costUsd }, false);
        break;
      case 'error':
        if (!event.retryable) this.error(event.message);
        break;
      case 'turn_complete':
        if (event.isError && event.reason && event.reason !== 'interrupted') this.error(`Turn failed: ${event.reason}`);
        if (this.state.streaming.trim()) this.push({ type: 'assistant', text: this.state.streaming.trim(), ...said });
        this.update({ streaming: '', activity: null });
        break;
      default:
        break;
    }
  }

  setBusy(busy: boolean): void {
    if (busy === this.state.busy) return;
    this.update({ busy, busySince: busy ? Date.now() : null, ...(busy ? {} : { activity: null }) });
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
  const short = toolName(name);
  const label = short.startsWith('legion.') ? (LEGION_TOOLS[short.slice('legion.'.length)] ?? short) : short;
  return `${label}${summary ? ` ${summary}` : ''}`;
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
