/**
 * The UI's state, fed by the session's events and independent of React: `items` is the append-only scrollback
 * (printed once, then owned by the terminal), everything else is the live region under it — streaming assistant
 * text, active runs with their steps, and the queue of things waiting for the user (gates, questions, tool
 * approvals from the assistant or from workflow agents).
 */
import type { AssistantApproval } from '../assistant/assistant.ts';
import type { AgentEvent } from '../engine/types.ts';
import type { RunEvent } from '../workflow/host.ts';
import type { RunRecord, StepKind } from '../workflow/journal.ts';
import type { PendingInteraction } from '../workflow/manager.ts';

export type Item =
  | { id: number; type: 'user'; text: string }
  | { id: number; type: 'assistant'; text: string }
  | { id: number; type: 'tool'; name: string; summary: string }
  | { id: number; type: 'info'; text: string }
  | { id: number; type: 'error'; text: string }
  | {
      id: number;
      type: 'run';
      runId: string;
      workflow: string;
      text: string;
      status: 'started' | 'done' | 'failed' | 'cancelled';
    }
  | { id: number; type: 'gate'; runId: string; title: string; body: string | null };

export type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'id'> : never) : never;

export interface StepView {
  key: string;
  label: string;
  kind: StepKind;
  status: 'started' | 'done' | 'failed' | 'cached';
  detail: string | null;
  /** What a running agent step is doing right now. */
  activity: string | null;
  startedAt: number;
}

export interface RunView {
  id: string;
  workflow: string;
  steps: StepView[];
}

export type UiInteraction =
  | { source: 'run'; id: string; pending: PendingInteraction }
  | { source: 'assistant'; id: string; approval: AssistantApproval };

export interface UiState {
  items: Item[];
  streaming: string;
  busy: boolean;
  activity: string | null;
  runs: RunView[];
  interactions: UiInteraction[];
  profiles: Record<string, string>;
  costUsd: number | null;
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
      activity: null,
      runs: [],
      interactions: [],
      profiles: {},
      costUsd: null,
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

  // ---- assistant -----------------------------------------------------------------------------

  assistantEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.update((s) => ({ streaming: s.streaming + event.text, activity: null }), false);
        break;
      case 'message':
        this.update({ streaming: '' }, false);
        if (event.text.trim()) this.push({ type: 'assistant', text: event.text.trim() });
        break;
      case 'tool_call':
        this.update({ streaming: '' }, false);
        this.push({ type: 'tool', name: toolName(event.name), summary: summarizeInput(event.name, event.input) });
        break;
      case 'tool_result':
        if (!event.ok && event.output) this.push({ type: 'error', text: clipLines(event.output, 6) });
        break;
      case 'activity':
        this.update(
          { activity: event.activity === 'tool_input' ? `writing ${toolName(event.tool ?? 'tool')}` : event.activity },
          false,
        );
        break;
      case 'usage':
        if (event.costUsd !== null) this.update({ costUsd: event.costUsd }, false);
        break;
      case 'error':
        if (!event.retryable) this.error(event.message);
        break;
      case 'turn_complete':
        if (event.isError && event.reason && event.reason !== 'interrupted') this.error(`Turn failed: ${event.reason}`);
        if (this.state.streaming.trim()) this.push({ type: 'assistant', text: this.state.streaming.trim() });
        this.update({ streaming: '', activity: null });
        break;
      default:
        break;
    }
  }

  setBusy(busy: boolean): void {
    this.update({ busy, ...(busy ? {} : { activity: null }) });
  }

  assistantApproval(approval: AssistantApproval): void {
    this.update((s) => ({ interactions: [...s.interactions, { source: 'assistant', id: approval.id, approval }] }));
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
            this.update((s) => ({ runs: [...s.runs, { id: event.runId, workflow, steps: [] }] }));
            this.push({
              type: 'run',
              runId: event.runId,
              workflow,
              status: 'started',
              text: `${workflow} started (run ${event.runId})`,
            });
          }
          return;
        }
        if (event.status === 'waiting' || event.status === 'interrupted') return;
        this.update((s) => ({ runs: s.runs.filter((r) => r.id !== event.runId) }));
        const text =
          event.status === 'done'
            ? `${workflow} finished${event.result ? `: ${clipLines(formatResult(event.result), 12)}` : ''}`
            : event.status === 'cancelled'
              ? `${workflow} cancelled${event.error ? `: ${event.error}` : ''} — /resume ${event.runId} picks it up again`
              : `${workflow} failed: ${event.error ?? 'unknown error'} — /resume ${event.runId} retries from the failed step`;
        this.push({
          type: 'run',
          runId: event.runId,
          workflow,
          status: event.status === 'done' ? 'done' : event.status === 'cancelled' ? 'cancelled' : 'failed',
          text,
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
            startedAt: prev?.startedAt ?? Date.now(),
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
        this.info(`[${event.runId}] ${event.message}`);
        return;
    }
  }

  runInteraction(pending: PendingInteraction): void {
    const i = pending.interaction;
    if (i.kind === 'gate') this.push({ type: 'gate', runId: i.runId, title: i.title, body: i.body });
    this.update((s) => ({ interactions: [...s.interactions, { source: 'run', id: pending.id, pending }] }));
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

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clipLines(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length > max ? `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more lines)` : text;
}
