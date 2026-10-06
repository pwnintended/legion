/**
 * Folds an attempt's normalized `AgentEvent`s into compact timeline rows (pure, unit-tested):
 * - streamed `text_delta`s accumulate into one assistant text, replaced by the final `message`;
 * - consecutive reads collapse into one "Read N files" row; tool results attach to their call;
 * - `file_change` counts attach to the edit call for the same path (or become an edit row of their own);
 * - `todo` snapshots replace the previous checklist; `usage` is summarized, not listed.
 * Row keys are the seq of the row's first event, so they stay stable while the transcript grows.
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

export interface Timeline {
  rows: TimelineRow[];
  usage: Usage | null;
  model: string | null;
  /** The last row is assistant text that is still streaming. */
  streaming: boolean;
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

export function buildTimeline(entries: readonly TranscriptEntry[]): Timeline {
  const rows: TimelineRow[] = [];
  /** tool call id → row index, to attach results. */
  const calls = new Map<string, number>();
  let usage: Usage | null = null;
  let model: string | null = null;

  const last = () => rows.at(-1);
  const set = (index: number, row: TimelineRow) => {
    rows[index] = row;
  };

  for (const { seq, event } of entries) {
    switch (event.type) {
      case 'session_started':
        model = event.model ?? model;
        rows.push({ kind: 'start', key: seq, model: event.model, version: event.version });
        break;
      case 'text_delta': {
        const prev = last();
        if (prev?.kind === 'text' && prev.streaming) set(rows.length - 1, { ...prev, text: prev.text + event.text });
        else rows.push({ kind: 'text', key: seq, text: event.text, streaming: true });
        break;
      }
      case 'message': {
        // The final text replaces the deltas streamed for it (the most recent streaming row).
        let index = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i];
          if (row?.kind === 'text' && row.streaming) {
            index = i;
            break;
          }
        }
        const existing = index >= 0 ? rows[index] : undefined;
        if (existing) set(index, { kind: 'text', key: existing.key, text: event.text, streaming: false });
        else rows.push({ kind: 'text', key: seq, text: event.text, streaming: false });
        break;
      }
      case 'reasoning': {
        const prev = last();
        if (prev?.kind === 'reasoning') set(rows.length - 1, { ...prev, text: `${prev.text}${event.text}` });
        else rows.push({ kind: 'reasoning', key: seq, text: event.text });
        break;
      }
      case 'tool_call': {
        if (event.kind === 'read') {
          const path = toolPath(event.input) ?? event.name;
          const prev = last();
          if (prev?.kind === 'reads') {
            set(rows.length - 1, { ...prev, paths: prev.paths.includes(path) ? prev.paths : [...prev.paths, path] });
          } else rows.push({ kind: 'reads', key: seq, paths: [path], failed: 0 });
          calls.set(event.id, rows.length - 1);
        } else if (event.kind === 'edit') {
          rows.push({
            kind: 'edit',
            key: seq,
            path: toolPath(event.input) ?? event.name,
            added: null,
            removed: null,
            status: 'running',
          });
          calls.set(event.id, rows.length - 1);
        } else if (event.kind === 'command') {
          rows.push({
            kind: 'command',
            key: seq,
            command: commandText(event.input) ?? (inputSummary(event.input) || event.name),
            status: 'running',
            output: null,
          });
          calls.set(event.id, rows.length - 1);
        } else if (event.kind === 'mcp') {
          const { server, tool } = splitMcpName(event.name);
          rows.push({ kind: 'mcp', key: seq, server, tool, summary: inputSummary(event.input), status: 'running' });
          calls.set(event.id, rows.length - 1);
        } else {
          rows.push({
            kind: 'tool',
            key: seq,
            name: event.name,
            summary: inputSummary(event.input),
            status: 'running',
            output: null,
          });
          calls.set(event.id, rows.length - 1);
        }
        break;
      }
      case 'tool_result': {
        const index = calls.get(event.id);
        const row = index === undefined ? undefined : rows[index];
        if (index === undefined || !row) break;
        const status: RowStatus = event.ok ? 'ok' : 'failed';
        if (row.kind === 'reads') {
          if (!event.ok) set(index, { ...row, failed: row.failed + 1 });
        } else if (row.kind === 'command' || row.kind === 'tool') set(index, { ...row, status, output: event.output });
        else if (row.kind === 'edit' || row.kind === 'mcp') set(index, { ...row, status });
        break;
      }
      case 'file_change': {
        // Attach to a recent edit call for the same path that has no counts yet.
        let attached = false;
        for (let i = rows.length - 1; i >= Math.max(0, rows.length - 12); i--) {
          const row = rows[i];
          if (row?.kind === 'edit' && row.path === event.path && row.added === null) {
            set(i, {
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
          rows.push({
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
        const previous = rows.findIndex((r) => r.kind === 'todo');
        if (previous >= 0) rows.splice(previous, 1);
        rows.push({ kind: 'todo', key: seq, items: event.items });
        break;
      }
      case 'approval_request':
        rows.push({
          kind: 'approval',
          key: seq,
          requestId: event.requestId,
          tool: event.tool,
          input: event.input,
          reason: event.reason,
        });
        break;
      case 'usage':
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd };
        break;
      case 'turn_complete': {
        // A turn ends any streaming text that never got its final message.
        const prev = last();
        if (prev?.kind === 'text' && prev.streaming) set(rows.length - 1, { ...prev, streaming: false });
        rows.push({ kind: 'turn', key: seq, isError: event.isError, reason: event.reason });
        break;
      }
      case 'error':
        rows.push({ kind: 'error', key: seq, message: event.message, retryable: event.retryable });
        break;
      case 'exited':
        rows.push({ kind: 'exited', key: seq, code: event.code });
        break;
      case 'rate_limit':
        break;
    }
  }
  const tail = rows.at(-1);
  return { rows, usage, model, streaming: tail?.kind === 'text' && tail.streaming };
}

/** Is this row noise once something follows it (successful turn ends between follow-ups)? */
export function isQuietRow(row: TimelineRow): boolean {
  return (row.kind === 'turn' && !row.isError) || row.kind === 'start';
}
