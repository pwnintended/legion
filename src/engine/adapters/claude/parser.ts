/**
 * Pure stream-json → `AgentEvent` normalizer for the `claude` CLI (architecture §6).
 *
 * One parser per session. It is stateful only in what the protocol requires: tool_use ids → names (to
 * pair results, derive file changes and hide the internal `StructuredOutput` tool), the Task* todo list,
 * and whether an interrupt was requested. Control-protocol frames are returned as `ParserOutput`s for the
 * session to act on; everything else becomes `AgentEvent`s.
 */
import { isAbsolute, relative } from 'node:path';
import type { AgentEvent, TodoItem, ToolKind } from '@shared/events';
import type { PendingPermission, PermissionUpdate } from './protocol';

export type ParserOutput =
  | { kind: 'event'; event: AgentEvent }
  /** `can_use_tool`: the session emits `approval_request` and waits for `respond()`. */
  | { kind: 'permission'; request: PendingPermission; reason: string | null }
  /** Any other CLI → host control request; it must be answered (the session declines it). */
  | { kind: 'control_request'; requestId: string; subtype: string; request: Record<string, unknown> }
  /** Answer to one of our control requests (e.g. interrupt). */
  | { kind: 'control_response'; requestId: string; ok: boolean; response: unknown; error: string | null }
  /** The CLI withdrew one of its own requests (e.g. a permission prompt after an interrupt). */
  | { kind: 'control_cancel'; requestId: string }
  /** `--replay-user-messages`: the CLI took one of our stdin user messages into the conversation. */
  | { kind: 'replay' }
  /** A top-level message type this parser does not know. */
  | { kind: 'unknown'; type: string };

export interface ParserOptions {
  /** Session cwd; file changes are reported relative to it. */
  cwd: string;
  /** `--json-schema` was passed: a successful turn without `structured_output` is an error. */
  structuredOutput: boolean;
}

/** Tool output kept on `tool_result` events (the full output stays in Claude's transcript). */
export const TOOL_OUTPUT_LIMIT = 16_000;

/** A streaming thinking/tool-input block reports `activity` again after this many more characters. */
export const ACTIVITY_STEP_CHARS = 2_000;

/** Internal tool the CLI injects for `--json-schema`; its call/result are not shown as tool activity. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell']);

/** Top-level message types that carry nothing Legion shows. */
const IGNORED_TYPES = new Set([
  'keep_alive',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'prompt_suggestion',
  'streamlined_text',
  'streamlined_tool_use_summary',
]);

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504, 529]);

const WINDOW_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'weekly' };

export function classifyTool(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (COMMAND_TOOLS.has(name)) return 'command';
  return 'other';
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Splits a byte stream into lines (stdout chunks don't respect line boundaries). */
export class LineBuffer {
  private rest = '';

  push(chunk: string): string[] {
    this.rest += chunk;
    const lines = this.rest.split('\n');
    this.rest = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  flush(): string[] {
    const last = this.rest;
    this.rest = '';
    return last.trim().length > 0 ? [last] : [];
  }
}

/** A content block of the main thread that streams without visible text (see the `activity` event). */
interface StreamingBlock {
  activity: 'thinking' | 'output' | 'tool_input';
  tool: string | null;
  chars: number;
  /** `chars` at the last `activity` event. */
  reported: number;
}

export class ClaudeStreamParser {
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private block: StreamingBlock | null = null;
  private readonly tasks = new Map<string, TodoItem>();
  private interruptRequested = false;
  private startedSessionId: string | null = null;
  private readonly roots: string[];

  constructor(private readonly opts: ParserOptions) {
    this.roots = [opts.cwd];
  }

  /** The session sent an interrupt: the next error result is reported as `reason: "interrupted"`. */
  noteInterrupt(): void {
    this.interruptRequested = true;
  }

  /** Parse one stdout line. Non-JSON lines (the CLI never prints them in stream-json mode) are ignored. */
  handleLine(line: string): ParserOutput[] {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    return this.handle(msg);
  }

  handle(msg: unknown): ParserOutput[] {
    if (!isObj(msg)) return [];
    const type = str(msg.type) ?? '';
    switch (type) {
      case 'system':
        return this.system(msg);
      case 'stream_event':
        return this.streamEvent(msg);
      case 'assistant':
        return this.assistant(msg);
      case 'user':
        return this.user(msg);
      case 'result':
        return this.result(msg);
      case 'rate_limit_event':
        return this.rateLimit(msg);
      case 'control_request':
        return this.controlRequest(msg);
      case 'control_response':
        return this.controlResponse(msg);
      case 'control_cancel_request': {
        const requestId = str(msg.request_id);
        return requestId ? [{ kind: 'control_cancel', requestId }] : [];
      }
      default:
        return IGNORED_TYPES.has(type) ? [] : [{ kind: 'unknown', type: type || '(none)' }];
    }
  }

  private system(msg: Obj): ParserOutput[] {
    switch (msg.subtype) {
      case 'init': {
        // The CLI repeats system/init at the start of every turn; report the session once.
        const sessionId = str(msg.session_id) ?? '';
        if (this.startedSessionId === sessionId) return [];
        this.startedSessionId = sessionId;
        const cwd = str(msg.cwd);
        if (cwd && !this.roots.includes(cwd)) this.roots.push(cwd);
        return [
          ev({ type: 'session_started', sessionId, model: str(msg.model), version: str(msg.claude_code_version) }),
        ];
      }
      case 'api_retry': {
        const status = num(msg.error_status);
        const detail = typeof msg.error === 'string' ? msg.error : status !== null ? `HTTP ${status}` : 'connection';
        return [
          ev({
            type: 'error',
            message: `API retry ${num(msg.attempt) ?? '?'}/${num(msg.max_retries) ?? '?'} (${detail})`,
            retryable: true,
          }),
        ];
      }
      default:
        // status, post_turn_summary, thinking_tokens, task_*, hook_*, compact_boundary, ...: not shown.
        return [];
    }
  }

  private streamEvent(msg: Obj): ParserOutput[] {
    if (msg.parent_tool_use_id) return [];
    const event = isObj(msg.event) ? msg.event : null;
    if (event?.type === 'content_block_start') return this.blockStart(event);
    if (event?.type === 'content_block_stop') {
      this.block = null;
      return [];
    }
    if (event?.type !== 'content_block_delta' || !isObj(event.delta)) return [];
    const delta = event.delta;
    if (delta.type === 'text_delta') {
      const text = str(delta.text);
      return text ? [ev({ type: 'text_delta', text })] : [];
    }
    const chunk = delta.type === 'thinking_delta' ? str(delta.thinking) : str(delta.partial_json);
    if (!this.block || !chunk) return [];
    this.block.chars += chunk.length;
    if (this.block.chars < this.block.reported + ACTIVITY_STEP_CHARS) return [];
    this.block.reported = this.block.chars;
    return [this.activityEvent(this.block)];
  }

  private blockStart(event: Obj): ParserOutput[] {
    const block = isObj(event.content_block) ? event.content_block : null;
    this.block = null;
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      this.block = { activity: 'thinking', tool: null, chars: 0, reported: 0 };
    } else if (block?.type === 'tool_use') {
      const name = str(block.name) ?? 'unknown';
      this.block =
        name === STRUCTURED_OUTPUT_TOOL
          ? { activity: 'output', tool: null, chars: 0, reported: 0 }
          : { activity: 'tool_input', tool: name, chars: 0, reported: 0 };
    }
    return this.block ? [this.activityEvent(this.block)] : [];
  }

  private activityEvent(block: StreamingBlock): ParserOutput {
    return ev({ type: 'activity', activity: block.activity, tool: block.tool, chars: block.chars });
  }

  private assistant(msg: Obj): ParserOutput[] {
    const message = isObj(msg.message) ? msg.message : {};
    const main = !msg.parent_tool_use_id;
    const out: ParserOutput[] = [];
    for (const block of arr(message.content)) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && main) {
        const text = str(block.text);
        if (text) out.push(ev({ type: 'message', text }));
      } else if (block.type === 'thinking' && main) {
        const text = str(block.thinking);
        if (text) out.push(ev({ type: 'reasoning', text }));
      } else if (block.type === 'tool_use') {
        out.push(...this.toolUse(block));
      }
    }
    return out;
  }

  private toolUse(block: Obj): ParserOutput[] {
    const id = str(block.id) ?? '';
    const name = str(block.name) ?? 'unknown';
    const input = block.input ?? {};
    this.tools.set(id, { name, input });
    if (name === STRUCTURED_OUTPUT_TOOL) return [];
    const out: ParserOutput[] = [ev({ type: 'tool_call', id, name, input, kind: classifyTool(name) })];
    if (name === 'TodoWrite' && isObj(input)) {
      const items = arr(input.todos).flatMap((todo) => {
        if (!isObj(todo)) return [];
        const text = str(todo.content) ?? str(todo.activeForm);
        return text ? [{ text, status: todoStatus(todo.status) }] : [];
      });
      out.push(ev({ type: 'todo', items }));
    } else if (name === 'TaskUpdate' && isObj(input)) {
      const taskId = str(input.taskId);
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (taskId && task) {
        if (input.status === 'deleted') this.tasks.delete(taskId);
        else {
          if (input.status) task.status = todoStatus(input.status);
          task.text = str(input.subject) ?? task.text;
        }
        out.push(this.todoEvent());
      }
    }
    return out;
  }

  private user(msg: Obj): ParserOutput[] {
    if (msg.isReplay === true) return [{ kind: 'replay' }];
    const message = isObj(msg.message) ? msg.message : {};
    const results = arr(message.content).filter((block): block is Obj => isObj(block) && block.type === 'tool_result');
    const out: ParserOutput[] = [];
    for (const block of results) {
      const id = str(block.tool_use_id) ?? '';
      const tool = this.tools.get(id);
      if (tool?.name === STRUCTURED_OUTPUT_TOOL) continue;
      const ok = block.is_error !== true;
      out.push(ev({ type: 'tool_result', id, ok, output: toolOutput(block.content) }));
      // `tool_use_result` (the tool's structured output) belongs to the message's single tool_result.
      if (ok && tool && results.length === 1) out.push(...this.toolSideEffects(tool, msg.tool_use_result));
    }
    return out;
  }

  private toolSideEffects(tool: { name: string; input: unknown }, result: unknown): ParserOutput[] {
    if (!isObj(result)) return [];
    if (EDIT_TOOLS.has(tool.name)) {
      const change = fileChange(result);
      if (!change) return [];
      return [
        ev({ type: 'file_change', path: this.relativePath(change.path), added: change.added, removed: change.removed }),
      ];
    }
    if (tool.name === 'TaskCreate' && isObj(result.task)) {
      const id = str(result.task.id);
      const text = str(result.task.subject);
      if (!id || !text) return [];
      this.tasks.set(id, { text, status: 'pending' });
      return [this.todoEvent()];
    }
    if (tool.name === 'TaskList' && Array.isArray(result.tasks)) {
      this.tasks.clear();
      for (const task of result.tasks) {
        if (!isObj(task)) continue;
        const id = str(task.id);
        const text = str(task.subject);
        if (id && text) this.tasks.set(id, { text, status: todoStatus(task.status) });
      }
      return [this.todoEvent()];
    }
    return [];
  }

  private todoEvent(): ParserOutput {
    return ev({ type: 'todo', items: [...this.tasks.values()].map((task) => ({ ...task })) });
  }

  private relativePath(path: string): string {
    if (!isAbsolute(path)) return path;
    for (const root of this.roots) {
      const rel = relative(root, path);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    }
    return path;
  }

  private result(msg: Obj): ParserOutput[] {
    const out: ParserOutput[] = [];
    const usage = resultUsage(msg);
    if (usage) out.push(ev(usage));

    const interrupted = this.interruptRequested || /^aborted/.test(str(msg.terminal_reason) ?? '');
    this.interruptRequested = false;
    const subtype = str(msg.subtype) ?? 'unknown';
    const structured = msg.structured_output ?? null;
    let isError = msg.is_error === true || subtype !== 'success';
    let reason: string | null = null;
    let retryable = false;
    let message: string | null = null;

    if (isError && interrupted) {
      reason = 'interrupted';
    } else if (isError) {
      const status = num(msg.api_error_status);
      reason = subtype !== 'success' ? subtype : status !== null ? `api_error_${status}` : 'error';
      retryable = subtype === 'error_max_structured_output_retries' || (status !== null && RETRYABLE_HTTP.has(status));
      const errors = arr(msg.errors).filter((e): e is string => typeof e === 'string');
      message = errors.length > 0 ? errors.join('; ') : (str(msg.result) ?? reason);
    } else if (this.opts.structuredOutput && structured === null) {
      isError = true;
      reason = 'missing_structured_output';
      retryable = true;
      message = 'The turn ended without structured output';
    }
    if (message !== null) out.push(ev({ type: 'error', message, retryable }));
    out.push(ev({ type: 'turn_complete', structuredOutput: isError ? null : structured, isError, reason }));
    return out;
  }

  private rateLimit(msg: Obj): ParserOutput[] {
    const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : null;
    if (!info) return [];
    const out: ParserOutput[] = [];
    const windows = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
    for (const [key, value] of Object.entries(windows)) {
      if (!isObj(value)) continue;
      const utilization = num(value.utilization);
      if (utilization === null) continue;
      out.push(rateLimitEvent(key, utilization, num(value.resetsAt)));
    }
    const type = str(info.rateLimitType);
    if (out.length === 0 && type && num(info.utilization) !== null) {
      out.push(rateLimitEvent(type, num(info.utilization) ?? 0, num(info.resetsAt)));
    }
    if (info.status === 'rejected' && type) out.push(rateLimitEvent(type, 1, num(info.resetsAt)));
    return out;
  }

  private controlRequest(msg: Obj): ParserOutput[] {
    const requestId = str(msg.request_id);
    const request = isObj(msg.request) ? msg.request : null;
    if (!requestId || !request) return [];
    const subtype = str(request.subtype) ?? 'unknown';
    if (subtype !== 'can_use_tool') return [{ kind: 'control_request', requestId, subtype, request }];
    const toolName = str(request.tool_name) ?? 'unknown';
    return [
      {
        kind: 'permission',
        request: {
          requestId,
          toolUseId: str(request.tool_use_id),
          toolName,
          input: request.input ?? {},
          suggestions: arr(request.permission_suggestions).filter(
            (s): s is PermissionUpdate => isObj(s) && typeof s.type === 'string',
          ),
        },
        reason: str(request.title) ?? str(request.decision_reason) ?? str(request.description),
      },
    ];
  }

  private controlResponse(msg: Obj): ParserOutput[] {
    const response = isObj(msg.response) ? msg.response : null;
    const requestId = response ? str(response.request_id) : null;
    if (!response || !requestId) return [];
    const ok = response.subtype === 'success';
    return [
      { kind: 'control_response', requestId, ok, response: response.response ?? null, error: str(response.error) },
    ];
  }
}

function ev(event: AgentEvent): ParserOutput {
  return { kind: 'event', event };
}

function todoStatus(value: unknown): TodoItem['status'] {
  return value === 'in_progress' || value === 'completed' ? value : 'pending';
}

function toolOutput(content: unknown): string | null {
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      if (!isObj(part)) return [];
      if (part.type === 'text' && typeof part.text === 'string') return [part.text];
      return [`[${String(part.type)}]`];
    });
    text = parts.join('\n');
  }
  if (text === null) return null;
  return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated]` : text;
}

/** Edit/Write/MultiEdit results carry `filePath` + `structuredPatch` hunks (`+`/`-` prefixed lines). */
function fileChange(result: Obj): { path: string; added: number; removed: number } | null {
  const path = str(result.filePath) ?? str(result.file_path) ?? str(result.notebook_path);
  if (!path) return null;
  let added = 0;
  let removed = 0;
  const hunks = arr(result.structuredPatch);
  for (const hunk of hunks) {
    if (!isObj(hunk)) continue;
    for (const line of arr(hunk.lines)) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  if (hunks.length === 0 && result.type === 'create' && typeof result.content === 'string') {
    added = countLines(result.content);
  }
  return { path, added, removed };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/**
 * `usage` from a result. Claude reports running totals for the whole session (and, on resume, including
 * earlier processes), so these values replace earlier ones rather than add to them. Interrupted turns can
 * report zeroed totals; those are skipped.
 */
function resultUsage(msg: Obj): AgentEvent | null {
  const cost = num(msg.total_cost_usd);
  let input = 0;
  let output = 0;
  const models = isObj(msg.modelUsage) ? Object.values(msg.modelUsage).filter(isObj) : [];
  if (models.length > 0) {
    for (const m of models) {
      input += (num(m.inputTokens) ?? 0) + (num(m.cacheReadInputTokens) ?? 0) + (num(m.cacheCreationInputTokens) ?? 0);
      output += num(m.outputTokens) ?? 0;
    }
  } else if (isObj(msg.usage)) {
    const u = msg.usage;
    input =
      (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
    output = num(u.output_tokens) ?? 0;
  }
  if (input === 0 && output === 0 && !cost) return null;
  return { type: 'usage', inputTokens: input, outputTokens: output, costUsd: cost };
}

function rateLimitEvent(window: string, utilization: number, resetsAtSec: number | null): ParserOutput {
  return ev({
    type: 'rate_limit',
    engine: 'claude',
    window: WINDOW_NAMES[window] ?? window,
    usedPct: Math.round(utilization * 1000) / 10,
    resetsAt: resetsAtSec === null ? null : Math.round(resetsAtSec * 1000),
  });
}
