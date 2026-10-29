import type { AgentEvent, SubagentActivityEvent } from '../engine/types.ts';
import {
  type FileChangeView,
  type Item,
  type NewItem,
  type ToolCallView,
  toolLabel,
  toolLine,
  toolName,
} from './store.ts';

export const TRANSCRIPT_ITEMS = 300;

/** One agent's bounded conversation, independent of the live UI store. */
export class Transcript {
  private history: Item[] = [];
  private nextId = 1;
  private calls: (ToolCallView & { id: string })[] = [];
  private files = new Map<string, FileChangeView>();
  streaming = '';
  activity: string | null = null;

  get items(): readonly Item[] {
    return this.history;
  }

  private append(item: NewItem): void {
    this.history = [...this.history.slice(-(TRANSCRIPT_ITEMS - 1)), { ...item, id: this.nextId++ }];
  }

  private foldTools(): boolean {
    if (!this.calls.length && !this.files.size) return false;
    this.append({
      type: 'tools',
      calls: this.calls.map(({ id: _, ...call }) => call),
      files: [...this.files.values()],
    });
    this.calls = [];
    this.files.clear();
    return true;
  }

  private reply(text: string): boolean {
    const folded = this.foldTools();
    if (text) this.append({ type: 'assistant', text });
    return folded || !!text;
  }

  push(event: AgentEvent | SubagentActivityEvent): boolean {
    switch (event.type) {
      case 'text_delta': {
        const changed = !!event.text || this.activity !== null;
        this.streaming += event.text;
        this.activity = null;
        return changed;
      }
      case 'message': {
        const changed = !!this.streaming;
        this.streaming = '';
        return this.reply(event.text.trim()) || changed;
      }
      case 'reasoning':
        if (!event.text.trim()) return false;
        this.foldTools();
        this.append({ type: 'reasoning', text: event.text.trim() });
        return true;
      case 'tool_call': {
        if (this.streaming.trim()) this.reply(this.streaming.trim());
        this.streaming = '';
        const line = toolLine(event.name, event.input);
        const changed = this.activity !== line;
        this.activity = line;
        this.calls.push({ id: event.id, tool: toolLabel(event.name), line, ok: null, error: null });
        return changed;
      }
      case 'tool_result': {
        const call = this.calls.find((call) => call.id === event.id);
        if (call) {
          call.ok = event.ok;
          call.error = event.ok ? null : (event.output?.trim().split('\n')[0] ?? null);
        }
        return false;
      }
      case 'file_change': {
        const previous = this.files.get(event.path);
        this.files.set(event.path, {
          path: event.path,
          added: (previous?.added ?? 0) + event.added,
          removed: (previous?.removed ?? 0) + event.removed,
        });
        return false;
      }
      case 'activity': {
        const activity = event.activity === 'tool_input' ? `writing ${toolName(event.tool ?? 'tool')}` : event.activity;
        const changed = activity !== this.activity;
        this.activity = activity;
        return changed;
      }
      case 'error':
        if (event.retryable) return false;
        this.append({ type: 'error', text: event.message });
        return true;
      case 'turn_complete': {
        let changed = !!this.streaming || this.activity !== null;
        if (event.isError && event.reason && event.reason !== 'interrupted') {
          this.append({ type: 'error', text: `Turn failed: ${event.reason}` });
          changed = true;
        }
        changed = this.reply(this.streaming.trim()) || changed;
        this.streaming = '';
        this.activity = null;
        return changed;
      }
      default:
        return false;
    }
  }
}

/** Validate the display events before replaying untrusted or partially written journal lines. */
function displayEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  switch (e.type) {
    case 'text_delta':
    case 'message':
    case 'reasoning':
      return typeof e.text === 'string';
    case 'tool_call':
      return typeof e.id === 'string' && typeof e.name === 'string';
    case 'tool_result':
      return (
        typeof e.id === 'string' && typeof e.ok === 'boolean' && (e.output === null || typeof e.output === 'string')
      );
    case 'file_change':
      return typeof e.path === 'string' && typeof e.added === 'number' && typeof e.removed === 'number';
    case 'activity':
      return (
        ['thinking', 'output', 'tool_input'].includes(String(e.activity)) &&
        (e.tool === null || typeof e.tool === 'string')
      );
    case 'error':
      return typeof e.message === 'string' && typeof e.retryable === 'boolean';
    case 'turn_complete':
      return typeof e.isError === 'boolean' && (e.reason === null || typeof e.reason === 'string');
    default:
      return false;
  }
}

export function transcriptFromJournal(text: string, subagent?: string): Transcript {
  const transcript = new Transcript();
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record.ts !== 'number') continue;
      let event =
        subagent === undefined
          ? record.event
          : record.event?.type === 'subagent_event' && record.event.id === subagent
            ? record.event.event
            : null;
      if (
        subagent !== undefined &&
        record.event?.type === 'subagent_done' &&
        record.event.id === subagent &&
        typeof record.event.ok === 'boolean' &&
        (record.event.result === null || typeof record.event.result === 'string')
      ) {
        event = {
          type: 'turn_complete',
          isError: !record.event.ok,
          reason: record.event.ok ? null : record.event.result,
          structuredOutput: null,
        };
      }
      if (displayEvent(event)) transcript.push(event);
    } catch {
      // A torn final line or an invalid record does not prevent replaying the rest.
    }
  }
  return transcript;
}
