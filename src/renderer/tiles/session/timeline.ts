/**
 * Folds an attempt's normalized `AgentEvent`s into compact timeline rows (pure, unit-tested):
 * - streamed `text_delta`s accumulate into one assistant text, replaced by the final `message`;
 * - consecutive reads collapse into one "Read N files" row; tool results attach to their call;
 * - `file_change` counts attach to the edit call for the same path (or become an edit row of their own);
 * - `todo` snapshots replace the previous checklist; `usage` is summarized, not listed;
 * - `working` says what the agent is doing between rows (thinking, writing its output, waiting for the model),
 *   so a long stretch without rows reads as progress.
 * Row keys are the seq of the row's first event, so they stay stable while the transcript grows.
 *
 * Building is incremental (`TimelineBuilder` / `timelineCursor`): a live event costs O(1), not a rebuild of
 * the whole timeline.
 */
import type { TodoItem } from '@shared/events';
import type { TranscriptEntry } from '@shared/rpc';

export type RowStatus = 'running' | 'ok' | 'failed';

export type TimelineRow =
  | { kind: 'start'; key: number; model: string | null; version: string | null }
  | { kind: 'text'; key: number; text: string; streaming: boolean }
  | { kind: 'reasoning'; key: number; text: string }
  | { kind: 'reads'; key: number; paths: string[]; failed: number }
  | { kind: 'edit'; key: number; path: string; added: number | null; removed: number | null; status: RowStatus }
  | { kind: 'command'; key: number; command: string; status: RowStatus; output: string | null }
  | { kind: 'mcp'; key: number; server: string; tool: string; summary: string; status: RowStatus }
  | { kind: 'tool'; key: number; name: string; summary: string; status: RowStatus; output: string | null }
  | { kind: 'todo'; key: number; items: TodoItem[] }
  | { kind: 'approval'; key: number; requestId: string; tool: string; input: unknown; reason: string | null }
  | { kind: 'turn'; key: number; isError: boolean; reason: string | null }
  | { kind: 'error'; key: number; message: string; retryable: boolean }
  | { kind: 'exited'; key: number; code: number | null };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** What the agent is busy with while no row shows it (null: idle, or a row already shows it). */
export interface Working {
  kind: 'thinking' | 'output' | 'tool_input' | 'waiting';
  tool: string | null;
  /** Characters streamed for the current block (0 when unknown). */
  chars: number;
  /** Seq of the event that started it (its timestamp is when). */
  since: number;
}

export interface Timeline {
  /**
   * The rows (rows themselves are immutable; the array grows in place as the builder advances, so read
   * it through the latest Timeline).
   */
  rows: TimelineRow[];
  usage: Usage | null;
  model: string | null;
  /** The last row is assistant text that is still streaming. */
  streaming: boolean;
  /** Request ids of the approval rows (approvals already shown inline). */
  approvalIds: ReadonlySet<string>;
  working: Working | null;
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The path a read/edit tool call is about. */
export function toolPath(input: unknown): string | null {
  const r = record(input);
  return str(r.file_path) ?? str(r.path) ?? str(r.notebook_path) ?? str(r.pattern) ?? str(r.url) ?? null;
}

/** The shell command of a command tool call (Claude `Bash.command`, Codex `command` string or argv). */
export function commandText(input: unknown): string | null {
  const r = record(input);
  if (typeof r.command === 'string') return r.command;
  if (Array.isArray(r.command)) {
    const argv = r.command.filter((p): p is string => typeof p === 'string');
    // Codex wraps commands as ["bash", "-lc", "<script>"].
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0] ?? '') && argv[1]?.startsWith('-')) return argv[2] ?? '';
    return argv.join(' ');
  }
  return null;
}

/** One-line summary of an arbitrary tool input. */
export function inputSummary(input: unknown): string {
  const r = record(input);
  for (const key of ['summary', 'question', 'description', 'query', 'prompt', 'command', 'file_path', 'path', 'url']) {
    const value = str(r[key]);
    if (value) return value.replace(/\s+/g, ' ').trim();
  }
  if (typeof input === 'string') return input;
  const keys = Object.keys(r);
  return keys.length ? keys.slice(0, 3).join(', ') : '';
}

/** `mcp__legion__report_progress` → { server: 'legion', tool: 'report_progress' }. */
export function splitMcpName(name: string): { server: string; tool: string } {
  const parts = name.split('__');
  if (parts[0] === 'mcp' && parts.length >= 3) return { server: parts[1] ?? '', tool: parts.slice(2).join('__') };
  const dot = name.indexOf('.');
  if (dot > 0) return { server: name.slice(0, dot), tool: name.slice(dot + 1) };
  return { server: 'mcp', tool: name };
}

/** Folds entries into rows one at a time; every step is O(1) amortized (a todo snapshot moves its row). */
export class TimelineBuilder {
  readonly rows: TimelineRow[] = [];
  /** tool call id → row index, to attach results (dropped once the result arrived). */
  private readonly calls = new Map<string, number>();
  /** Indices of text rows that are still streaming, oldest first. */
  private streamingRows: number[] = [];
  private readonly approvals = new Set<string>();
  private todoIndex = -1;
  private usage: Usage | null = null;
  private model: string | null = null;
  private working: Working | null = null;

  private last(): TimelineRow | undefined {
    return this.rows.at(-1);
  }

  private set(index: number, row: TimelineRow): void {
    this.rows[index] = row;
  }

  private add(row: TimelineRow): number {
    this.rows.push(row);
    return this.rows.length - 1;
  }

  /** Remove a row in the middle (the previous todo snapshot), keeping the index maps right. */
  private removeAt(index: number): void {
    this.rows.splice(index, 1);
    for (const [id, i] of this.calls) if (i > index) this.calls.set(id, i - 1);
    this.streamingRows = this.streamingRows.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
  }

  push(entry: TranscriptEntry): void {
    this.track(entry);
    this.fold(entry);
  }

  /** Keep `working` current: rows and turn ends replace it; a finished step hands the turn back to the model. */
  private track({ seq, event }: TranscriptEntry): void {
    const waiting: Working = { kind: 'waiting', tool: null, chars: 0, since: seq };
    switch (event.type) {
      case 'activity': {
        const prev = this.working;
        const same = prev && prev.kind === event.activity && prev.tool === event.tool && event.chars > 0;
        this.working = { kind: event.activity, tool: event.tool, chars: event.chars, since: same ? prev.since : seq };
        return;
      }
      case 'session_started':
      case 'tool_result':
      case 'reasoning':
      case 'message':
        this.working = waiting;
        return;
      case 'text_delta':
      case 'tool_call':
      case 'approval_request':
      case 'turn_complete':
      case 'exited':
        this.working = null;
        return;
      default:
        return;
    }
  }

  private fold({ seq, event }: TranscriptEntry): void {
    const rows = this.rows;
    switch (event.type) {
      case 'session_started':
        this.model = event.model ?? this.model;
        this.add({ kind: 'start', key: seq, model: event.model, version: event.version });
        break;
      case 'text_delta': {
        const prev = this.last();
        if (prev?.kind === 'text' && prev.streaming)
          this.set(rows.length - 1, { ...prev, text: prev.text + event.text });
        else this.streamingRows.push(this.add({ kind: 'text', key: seq, text: event.text, streaming: true }));
        break;
      }
      case 'message': {
        // The final text replaces the deltas streamed for it (the most recent streaming row).
        const index = this.streamingRows.pop();
        const existing = index === undefined ? undefined : rows[index];
        if (index !== undefined && existing)
          this.set(index, { kind: 'text', key: existing.key, text: event.text, streaming: false });
        else this.add({ kind: 'text', key: seq, text: event.text, streaming: false });
        break;
      }
      case 'reasoning': {
        const prev = this.last();
        if (prev?.kind === 'reasoning') this.set(rows.length - 1, { ...prev, text: `${prev.text}${event.text}` });
        else this.add({ kind: 'reasoning', key: seq, text: event.text });
        break;
      }
      case 'tool_call': {
        if (event.kind === 'read') {
          const path = toolPath(event.input) ?? event.name;
          const prev = this.last();
          if (prev?.kind === 'reads') {
            this.set(rows.length - 1, {
              ...prev,
              paths: prev.paths.includes(path) ? prev.paths : [...prev.paths, path],
            });
          } else this.add({ kind: 'reads', key: seq, paths: [path], failed: 0 });
          this.calls.set(event.id, rows.length - 1);
        } else if (event.kind === 'edit') {
          const at = this.add({
            kind: 'edit',
            key: seq,
            path: toolPath(event.input) ?? event.name,
            added: null,
            removed: null,
            status: 'running',
          });
          this.calls.set(event.id, at);
        } else if (event.kind === 'command') {
          const at = this.add({
            kind: 'command',
            key: seq,
            command: commandText(event.input) ?? (inputSummary(event.input) || event.name),
            status: 'running',
            output: null,
          });
          this.calls.set(event.id, at);
        } else if (event.kind === 'mcp') {
          const { server, tool } = splitMcpName(event.name);
          const at = this.add({
            kind: 'mcp',
            key: seq,
            server,
            tool,
            summary: inputSummary(event.input),
            status: 'running',
          });
          this.calls.set(event.id, at);
        } else {
          const at = this.add({
            kind: 'tool',
            key: seq,
            name: event.name,
            summary: inputSummary(event.input),
            status: 'running',
            output: null,
          });
          this.calls.set(event.id, at);
        }
        break;
      }
      case 'tool_result': {
        const index = this.calls.get(event.id);
        const row = index === undefined ? undefined : rows[index];
        if (index === undefined || !row) break;
        this.calls.delete(event.id);
        const status: RowStatus = event.ok ? 'ok' : 'failed';
        if (row.kind === 'reads') {
          if (!event.ok) this.set(index, { ...row, failed: row.failed + 1 });
        } else if (row.kind === 'command' || row.kind === 'tool')
          this.set(index, { ...row, status, output: event.output });
        else if (row.kind === 'edit' || row.kind === 'mcp') this.set(index, { ...row, status });
        break;
      }
      case 'file_change': {
        // Attach to a recent edit call for the same path that has no counts yet.
        let attached = false;
        for (let i = rows.length - 1; i >= Math.max(0, rows.length - 12); i--) {
          const row = rows[i];
          if (row?.kind === 'edit' && row.path === event.path && row.added === null) {
            this.set(i, {
              ...row,
              added: event.added,
              removed: event.removed,
              status: row.status === 'running' ? 'ok' : row.status,
            });
            attached = true;
            break;
          }
        }
        if (!attached)
          this.add({
            kind: 'edit',
            key: seq,
            path: event.path,
            added: event.added,
            removed: event.removed,
            status: 'ok',
          });
        break;
      }
      case 'todo': {
        if (this.todoIndex >= 0) this.removeAt(this.todoIndex);
        this.todoIndex = this.add({ kind: 'todo', key: seq, items: event.items });
        break;
      }
      case 'approval_request':
        this.approvals.add(event.requestId);
        this.add({
          kind: 'approval',
          key: seq,
          requestId: event.requestId,
          tool: event.tool,
          input: event.input,
          reason: event.reason,
        });
        break;
      case 'usage':
        this.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd };
        break;
      case 'turn_complete': {
        // A turn ends any streaming text that never got its final message.
        const prev = this.last();
        if (prev?.kind === 'text' && prev.streaming) {
          this.set(rows.length - 1, { ...prev, streaming: false });
          this.streamingRows = this.streamingRows.filter((i) => i !== rows.length - 1);
        }
        this.add({ kind: 'turn', key: seq, isError: event.isError, reason: event.reason });
        break;
      }
      case 'error':
        this.add({ kind: 'error', key: seq, message: event.message, retryable: event.retryable });
        break;
      case 'exited':
        this.add({ kind: 'exited', key: seq, code: event.code });
        break;
      case 'rate_limit':
      case 'activity':
        break;
    }
  }

  /** The current state (a new object each call; `rows` is shared, see `Timeline.rows`). */
  snapshot(): Timeline {
    const tail = this.rows.at(-1);
    return {
      rows: this.rows,
      usage: this.usage,
      model: this.model,
      streaming: tail?.kind === 'text' && tail.streaming,
      approvalIds: this.approvals,
      working: this.working,
    };
  }
}

export function buildTimeline(entries: readonly TranscriptEntry[]): Timeline {
  const builder = new TimelineBuilder();
  for (const entry of entries) builder.push(entry);
  return builder.snapshot();
}

/**
 * An incremental view over a growing transcript: called with the transcript's (append-only) entries array
 * and its count, it only folds in the entries it hasn't seen. A different array (history merged in,
 * transcript trimmed) or a shorter count starts over.
 */
export function timelineCursor(): (entries: readonly TranscriptEntry[], count?: number) => Timeline {
  let source: readonly TranscriptEntry[] | null = null;
  let consumed = 0;
  let builder = new TimelineBuilder();
  let last: Timeline | null = null;
  return (entries, count = entries.length) => {
    if (entries !== source || count < consumed) {
      source = entries;
      consumed = 0;
      builder = new TimelineBuilder();
      last = null;
    }
    if (last && count === consumed) return last;
    for (let i = consumed; i < count; i++) builder.push(entries[i] as TranscriptEntry);
    consumed = count;
    last = builder.snapshot();
    return last;
  };
}

/** Timestamp of the entry with `seq` (entries are sorted by seq), or 0. O(log n). */
export function entryTs(entries: readonly TranscriptEntry[], count: number, seq: number): number {
  let lo = 0;
  let hi = Math.min(count, entries.length) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = entries[mid] as TranscriptEntry;
    if (entry.seq === seq) return entry.ts;
    if (entry.seq < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

/** Is this row noise once something follows it (successful turn ends between follow-ups)? */
export function isQuietRow(row: TimelineRow): boolean {
  return (row.kind === 'turn' && !row.isError) || row.kind === 'start';
}
