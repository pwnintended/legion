/**
 * Codex app-server notifications → normalized `AgentEvent`s (architecture §6). Pure and stateful per
 * session: it tracks open tool calls, the last agent message of the turn (structured output), and the
 * last rate-limit values (to drop duplicates). Approval-type server requests are mapped here too, both
 * ways: request → `approval_request` event and Legion `ApprovalDecision` → the method's response shape.
 */
import { isAbsolute, relative } from 'node:path';
import type { ApprovalDecision } from '@shared/engine';
import type { AgentEvent, TodoItem } from '@shared/events';
import type { ServerNotification, ServerRequest } from './methods';
import type { RequestId } from './protocol';
import type {
  CodexErrorInfo,
  CommandAction,
  FileUpdateChange,
  RateLimitSnapshot,
  RateLimitWindow,
  ThreadItem,
  TurnError,
  TurnPlanStepStatus,
} from './protocol/v2';

export interface NormalizerOptions {
  /** Session cwd; file paths inside it are reported relative to it. */
  cwd: string;
  /** Parse the turn's final agent message as JSON for `turn_complete.structuredOutput`. */
  structuredOutput: boolean;
}

/** Max characters of command / MCP output kept in `tool_result.output` (the tail). */
export const TOOL_OUTPUT_LIMIT = 4000;

type ToolItem = Extract<
  ThreadItem,
  {
    type:
      | 'commandExecution'
      | 'fileChange'
      | 'mcpToolCall'
      | 'dynamicToolCall'
      | 'webSearch'
      | 'imageView'
      | 'collabAgentToolCall';
  }
>;

export class CodexNormalizer {
  private readonly openCalls = new Set<string>();
  /** Inputs of started items, so approval requests (which only carry an itemId) can show them. */
  private readonly itemInputs = new Map<string, unknown>();
  private readonly rateLimits = new Map<string, string>();
  private finalMessage: string | null = null;
  private lastMessage: string | null = null;
  private turnErrorEmitted = false;

  constructor(private readonly options: NormalizerOptions) {}

  setStructuredOutput(enabled: boolean): void {
    this.options.structuredOutput = enabled;
  }

  handle(notification: ServerNotification): AgentEvent[] {
    switch (notification.method) {
      case 'turn/started':
        this.finalMessage = null;
        this.lastMessage = null;
        this.turnErrorEmitted = false;
        return [];
      case 'item/agentMessage/delta':
        return notification.params.delta ? [{ type: 'text_delta', text: notification.params.delta }] : [];
      case 'item/started':
        return this.itemStarted(notification.params.item);
      case 'item/completed':
        return this.itemCompleted(notification.params.item);
      case 'turn/plan/updated':
        return [
          {
            type: 'todo',
            items: notification.params.plan.map(
              (step): TodoItem => ({ text: step.step, status: todoStatus(step.status) }),
            ),
          },
        ];
      case 'thread/tokenUsage/updated': {
        const total = notification.params.tokenUsage.total;
        return [{ type: 'usage', inputTokens: total.inputTokens, outputTokens: total.outputTokens, costUsd: null }];
      }
      case 'account/rateLimits/updated':
        return this.rateLimitEvents(notification.params.rateLimits);
      case 'error':
        this.turnErrorEmitted = true;
        return [
          {
            type: 'error',
            message: errorMessage(notification.params.error),
            retryable: notification.params.willRetry || isRetryable(notification.params.error.codexErrorInfo),
          },
        ];
      case 'turn/completed':
        return this.turnCompleted(notification.params.turn.status, notification.params.turn.error);
      default:
        return [];
    }
  }

  /**
   * Close the current turn when no `turn/completed` will come (process exited or was closed mid-turn).
   */
  abortTurn(reason: string): AgentEvent[] {
    return [...this.closeOpenCalls(reason), { type: 'turn_complete', structuredOutput: null, isError: true, reason }];
  }

  /** Map an approval / user-input server request to an `approval_request` event; null if not one. */
  approvalRequest(request: ServerRequest): AgentEvent | null {
    const requestId = approvalRequestId(request.id);
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const p = request.params;
        const input: Record<string, unknown> = {
          command: displayCommand(p.command ?? '', p.commandActions ?? []),
          cwd: p.cwd ? this.path(p.cwd) : null,
        };
        if (p.networkApprovalContext) input.network = p.networkApprovalContext;
        if (p.additionalPermissions) input.additionalPermissions = p.additionalPermissions;
        return { type: 'approval_request', requestId, tool: 'shell', input, reason: p.reason ?? null };
      }
      case 'item/fileChange/requestApproval': {
        const p = request.params;
        const input: Record<string, unknown> = { ...asRecord(this.itemInputs.get(p.itemId)) };
        if (p.grantRoot) input.grantRoot = p.grantRoot;
        return { type: 'approval_request', requestId, tool: 'apply_patch', input, reason: p.reason ?? null };
      }
      case 'item/permissions/requestApproval': {
        const p = request.params;
        return {
          type: 'approval_request',
          requestId,
          tool: 'permissions',
          input: { permissions: p.permissions, cwd: this.path(p.cwd) },
          reason: p.reason,
        };
      }
      case 'item/tool/requestUserInput':
        return {
          type: 'approval_request',
          requestId,
          tool: 'request_user_input',
          input: { questions: request.params.questions },
          reason: null,
        };
      case 'mcpServer/elicitation/request': {
        const { threadId: _t, turnId: _u, serverName, ...rest } = request.params;
        const message = 'message' in rest ? rest.message : rest.description;
        return { type: 'approval_request', requestId, tool: `mcp__${serverName}`, input: rest, reason: message };
      }
      case 'execCommandApproval':
        return {
          type: 'approval_request',
          requestId,
          tool: 'shell',
          input: { command: request.params.command.join(' '), cwd: this.path(request.params.cwd) },
          reason: request.params.reason,
        };
      case 'applyPatchApproval':
        return {
          type: 'approval_request',
          requestId,
          tool: 'apply_patch',
          input: { changes: Object.keys(request.params.fileChanges).map((path) => ({ path: this.path(path) })) },
          reason: request.params.reason,
        };
      default:
        return null;
    }
  }

  private itemStarted(item: ThreadItem): AgentEvent[] {
    const call = toolCall(item, this);
    if (!call) return [];
    this.openCalls.add(item.id);
    this.itemInputs.set(item.id, call.input);
    return [call];
  }

  private itemCompleted(item: ThreadItem): AgentEvent[] {
    switch (item.type) {
      case 'agentMessage':
        this.lastMessage = item.text;
        if (item.phase === 'final_answer') this.finalMessage = item.text;
        return item.text ? [{ type: 'message', text: item.text }] : [];
      case 'reasoning': {
        const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n').trim();
        return text ? [{ type: 'reasoning', text }] : [];
      }
      default:
        break;
    }
    const call = toolCall(item, this);
    if (!call) return [];
    const events: AgentEvent[] = [];
    if (!this.openCalls.has(item.id)) events.push(call);
    this.openCalls.delete(item.id);
    this.itemInputs.delete(item.id);
    events.push(...toolResult(item as ToolItem, this));
    return events;
  }

  private turnCompleted(status: string, error: TurnError | null): AgentEvent[] {
    if (status === 'interrupted') return this.abortTurn('interrupted');
    const events = this.closeOpenCalls(status === 'failed' ? 'failed' : 'turn ended');
    if (status === 'failed') {
      const message = error ? errorMessage(error) : 'turn failed';
      if (!this.turnErrorEmitted) {
        events.push({ type: 'error', message, retryable: isRetryable(error?.codexErrorInfo ?? null) });
      }
      events.push({ type: 'turn_complete', structuredOutput: null, isError: true, reason: message });
      return events;
    }
    if (!this.options.structuredOutput) {
      events.push({ type: 'turn_complete', structuredOutput: null, isError: false, reason: null });
      return events;
    }
    const text = this.finalMessage ?? this.lastMessage;
    const parsed = text === null ? undefined : parseJson(text);
    if (parsed === undefined) {
      const reason = text === null ? 'no structured output' : 'structured output is not valid JSON';
      events.push({ type: 'error', message: reason, retryable: true });
      events.push({ type: 'turn_complete', structuredOutput: null, isError: true, reason });
      return events;
    }
    events.push({ type: 'turn_complete', structuredOutput: parsed, isError: false, reason: null });
    return events;
  }

  private closeOpenCalls(reason: string): AgentEvent[] {
    const events: AgentEvent[] = [...this.openCalls].map((id) => ({
      type: 'tool_result',
      id,
      ok: false,
      output: reason,
    }));
    this.openCalls.clear();
    this.itemInputs.clear();
    return events;
  }

  private rateLimitEvents(snapshot: RateLimitSnapshot): AgentEvent[] {
    const events: AgentEvent[] = [];
    const windows: [string, RateLimitWindow | null][] = [
      ['primary', snapshot.primary],
      ['secondary', snapshot.secondary],
    ];
    for (const [slot, window] of windows) {
      if (!window) continue;
      const label = windowLabel(window.windowDurationMins, slot);
      const name = snapshot.limitId && snapshot.limitId !== 'codex' ? `${snapshot.limitId}:${label}` : label;
      const resetsAt = window.resetsAt === null ? null : window.resetsAt * 1000;
      const key = `${window.usedPercent}|${resetsAt}`;
      if (this.rateLimits.get(name) === key) continue;
      this.rateLimits.set(name, key);
      events.push({ type: 'rate_limit', engine: 'codex', window: name, usedPct: window.usedPercent, resetsAt });
    }
    return events;
  }

  /** Paths inside the session cwd become relative. */
  path(path: string): string {
    if (!isAbsolute(path)) return path;
    const rel = relative(this.options.cwd, path);
    if (rel === '') return '.';
    return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
  }
}

function toolCall(item: ThreadItem, n: CodexNormalizer): Extract<AgentEvent, { type: 'tool_call' }> | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_call',
        id: item.id,
        name: 'shell',
        input: { command: displayCommand(item.command, item.commandActions), cwd: n.path(item.cwd) },
        kind: 'command',
      };
    case 'fileChange':
      return {
        type: 'tool_call',
        id: item.id,
        name: 'apply_patch',
        input: { changes: item.changes.map((c) => ({ path: n.path(changePath(c)), kind: c.kind.type })) },
        kind: 'edit',
      };
    case 'mcpToolCall':
      return {
        type: 'tool_call',
        id: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
        kind: 'mcp',
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_call',
        id: item.id,
        name: item.namespace ? `${item.namespace}__${item.tool}` : item.tool,
        input: item.arguments,
        kind: 'other',
      };
    case 'webSearch':
      return { type: 'tool_call', id: item.id, name: 'web_search', input: { query: item.query }, kind: 'read' };
    case 'imageView':
      return { type: 'tool_call', id: item.id, name: 'view_image', input: { path: n.path(item.path) }, kind: 'read' };
    case 'collabAgentToolCall':
      return {
        type: 'tool_call',
        id: item.id,
        name: `agent_${item.tool}`,
        input: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds },
        kind: 'other',
      };
    default:
      return null;
  }
}

function toolResult(item: ToolItem, n: CodexNormalizer): AgentEvent[] {
  switch (item.type) {
    case 'commandExecution': {
      if (item.status === 'declined') return [{ type: 'tool_result', id: item.id, ok: false, output: 'declined' }];
      const output = item.aggregatedOutput ? tail(item.aggregatedOutput, TOOL_OUTPUT_LIMIT) : '';
      const head = item.exitCode === null ? `status ${item.status}` : `exit ${item.exitCode}`;
      return [
        {
          type: 'tool_result',
          id: item.id,
          ok: item.status === 'completed' && (item.exitCode ?? 0) === 0,
          output: output ? `${head}\n${output}` : head,
        },
      ];
    }
    case 'fileChange': {
      const ok = item.status === 'completed';
      const events: AgentEvent[] = [{ type: 'tool_result', id: item.id, ok, output: ok ? null : item.status }];
      if (ok) {
        for (const change of item.changes) {
          events.push({ type: 'file_change', path: n.path(changePath(change)), ...countChange(change) });
        }
      }
      return events;
    }
    case 'mcpToolCall': {
      const ok = item.status === 'completed' && item.error === null;
      const output = item.error ? item.error.message : item.result ? mcpText(item.result.content) : null;
      return [
        { type: 'tool_result', id: item.id, ok, output: output === null ? null : tail(output, TOOL_OUTPUT_LIMIT) },
      ];
    }
    case 'dynamicToolCall': {
      const text = (item.contentItems ?? []).flatMap((c) => (c.type === 'inputText' ? [c.text] : [])).join('\n');
      return [
        { type: 'tool_result', id: item.id, ok: item.success ?? item.status === 'completed', output: text || null },
      ];
    }
    default:
      return [{ type: 'tool_result', id: item.id, ok: true, output: null }];
  }
}

function changePath(change: FileUpdateChange): string {
  return change.kind.type === 'update' && change.kind.move_path ? change.kind.move_path : change.path;
}

/**
 * Added/removed line counts. Observed in 0.160.0: `add` carries the new file's content, `delete` the old
 * content, `update` a unified diff (hunks only, sometimes with git headers).
 */
export function countChange(change: FileUpdateChange): { added: number; removed: number } {
  const diff = change.diff;
  if (looksLikeUnifiedDiff(diff)) return countUnifiedDiff(diff);
  if (change.kind.type === 'add') return { added: countLines(diff), removed: 0 };
  if (change.kind.type === 'delete') return { added: 0, removed: countLines(diff) };
  return countUnifiedDiff(diff);
}

function looksLikeUnifiedDiff(diff: string): boolean {
  return diff.startsWith('@@') || diff.startsWith('diff --git') || diff.startsWith('--- ');
}

export function countUnifiedDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/** The command as the model wrote it: codex wraps it in `/bin/zsh -lc '…'`. */
export function displayCommand(command: string, actions: readonly CommandAction[]): string {
  const [only] = actions;
  if (actions.length === 1 && only) return only.command;
  return unwrapShell(command);
}

export function unwrapShell(command: string): string {
  const match = /^\S*\/(?:ba|z)?sh -l?c (.*)$/s.exec(command);
  const inner = match?.[1];
  if (inner === undefined) return command;
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
    return inner.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) {
    return inner.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return inner;
}

function mcpText(content: readonly unknown[]): string | null {
  const parts = content.flatMap((c) => {
    const record = asRecord(c);
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : null;
}

function todoStatus(status: TurnPlanStepStatus): TodoItem['status'] {
  return status === 'inProgress' ? 'in_progress' : status;
}

function windowLabel(mins: number | null, slot: string): string {
  if (mins === null) return slot;
  if (mins === 10080) return 'weekly';
  if (mins === 1440) return 'daily';
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function errorMessage(error: TurnError): string {
  return error.additionalDetails ? `${error.message} (${error.additionalDetails})` : error.message;
}

const RETRYABLE_ERRORS = new Set([
  'usageLimitExceeded',
  'rateLimitExceeded',
  'serverOverloaded',
  'internalServerError',
  'flexUnavailable',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

function isRetryable(info: CodexErrorInfo | null): boolean {
  if (info === null) return false;
  return RETRYABLE_ERRORS.has(typeof info === 'string' ? info : (Object.keys(info)[0] ?? ''));
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    return undefined;
  }
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The id Legion uses for a server request (`AgentEvent.approval_request.requestId`). */
export function approvalRequestId(id: RequestId): string {
  return String(id);
}

/**
 * Encode a Legion decision as the response a given approval-type server request expects.
 * Codex: allow/once → accept, allow/session → acceptForSession, deny → decline, deny+interrupt → cancel.
 */
export function approvalResponse(request: ServerRequest, decision: ApprovalDecision): unknown {
  const allow = decision.behavior === 'allow';
  const forSession = allow && decision.scope === 'session';
  const cancel = decision.behavior === 'deny' && decision.interrupt;
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? (forSession ? 'acceptForSession' : 'accept') : cancel ? 'cancel' : 'decline' };
    case 'item/permissions/requestApproval': {
      if (!allow) return { permissions: {}, scope: 'turn' };
      const requested = request.params.permissions;
      const permissions: Record<string, unknown> = {};
      if (requested.network) permissions.network = requested.network;
      if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
      return { permissions, scope: forSession ? 'session' : 'turn' };
    }
    case 'item/tool/requestUserInput':
      return { answers: allow ? userInputAnswers(decision.updatedInput) : {} };
    case 'mcpServer/elicitation/request':
      return allow
        ? { action: 'accept', content: decision.updatedInput ?? {}, _meta: null }
        : { action: cancel ? 'cancel' : 'decline', content: null, _meta: null };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return {
        decision: allow
          ? forSession
            ? 'approved_for_session'
            : 'approved'
          : cancel
            ? 'abort'
            : { denied: { rejection: decision.message } },
      };
    default:
      throw new Error(`not an approval request: ${request.method}`);
  }
}

/**
 * `request_user_input` answers come back through `ApprovalDecision.updatedInput`, either already in
 * Codex's shape `{answers: {id: {answers: [...]}}}` or as a plain `{id: string | string[]}` map.
 */
function userInputAnswers(input: unknown): Record<string, { answers: string[] }> {
  const record = asRecord(input);
  const source = 'answers' in record && typeof record.answers === 'object' ? asRecord(record.answers) : record;
  const out: Record<string, { answers: string[] }> = {};
  for (const [id, value] of Object.entries(source)) {
    if (typeof value === 'string') out[id] = { answers: [value] };
    else if (Array.isArray(value)) out[id] = { answers: value.map(String) };
    else {
      const answers = asRecord(value).answers;
      if (Array.isArray(answers)) out[id] = { answers: answers.map(String) };
    }
  }
  return out;
}

export const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'execCommandApproval',
  'applyPatchApproval',
]);
