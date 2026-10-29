/**
 * Messages Legion writes to the CLI's stdin (stream-json input + control protocol). Shapes follow the
 * published `@anthropic-ai/claude-agent-sdk` 0.3.292 (`SDKUserMessage`, `SDKControlRequest`,
 * `control_response` with `PermissionResult`), which drives the same CLI.
 */
import { readFileSync } from 'node:fs';
import { hasShellMeta } from '../../util/shell.ts';
import type { ApprovalDecision, QuestionAnswers, UserQuestion } from '../types.ts';

export type StdinMessage = Record<string, unknown> & { type: string };

/**
 * A user turn. `now` interrupts the running turn and is read immediately; default = next opportunity. `images`
 * (PNG files) go first as base64 image blocks, the text after them.
 */
export function userMessage(text: string, priority?: 'now' | 'next', images: readonly string[] = []): StdinMessage {
  const content =
    images.length === 0
      ? text
      : [
          ...images.map((path) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: readFileSync(path).toString('base64') },
          })),
          ...(text ? [{ type: 'text', text }] : []),
        ];
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
    ...(priority === 'now' ? { priority: 'now' } : {}),
  };
}

export function controlRequest(requestId: string, request: Record<string, unknown>): StdinMessage {
  return { type: 'control_request', request_id: requestId, request };
}

export function interruptRequest(requestId: string): StdinMessage {
  return controlRequest(requestId, { subtype: 'interrupt' });
}

/** Switch a live session's permission mode (`auto` is refused for models without auto mode). */
export function setPermissionModeRequest(requestId: string, mode: 'auto' | 'acceptEdits'): StdinMessage {
  return controlRequest(requestId, { subtype: 'set_permission_mode', mode });
}

export function controlSuccess(requestId: string, response: Record<string, unknown>): StdinMessage {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

export function controlError(requestId: string, error: string): StdinMessage {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}

/** A `PermissionUpdate` as the CLI sends it in `permission_suggestions`. */
export type PermissionUpdate = Record<string, unknown> & { type: string; destination?: string };

export interface PendingPermission {
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  suggestions: PermissionUpdate[];
}

/**
 * The `can_use_tool` answer. "Allow for session" re-targets the CLI's own rule/directory suggestions to
 * `destination: "session"` (never `localSettings`, which would write the repo's `.claude/settings.local.json`).
 * It never widens to a whole tool (see {@link sessionPermissions}).
 */
export function permissionResponse(pending: PendingPermission, decision: ApprovalDecision): StdinMessage {
  const toolUseID = pending.toolUseId ?? undefined;
  if (decision.behavior === 'deny') {
    return controlSuccess(pending.requestId, {
      behavior: 'deny',
      message: decision.message,
      ...(decision.interrupt ? { interrupt: true } : {}),
      ...(toolUseID ? { toolUseID } : {}),
    });
  }
  const updatedInput = decision.updatedInput ?? pending.input ?? {};
  const response: Record<string, unknown> = { behavior: 'allow', updatedInput };
  if (decision.scope === 'session') {
    const updates = sessionPermissions(pending);
    if (updates.length > 0) response.updatedPermissions = updates;
  }
  if (toolUseID) response.toolUseID = toolUseID;
  return controlSuccess(pending.requestId, response);
}

/**
 * Session-scoped permission updates for "allow for session": the CLI's own `addDirectories` and allow
 * `addRules` suggestions whose rules are scoped (`Tool(content)`, or a specific MCP tool). When no rule
 * survives, a plain Bash command gets an exact `Bash(<command>)` rule; anything else gets no rule at all
 * (the approval degrades to allow-once, plus any suggested directory). Never an unscoped whole-tool rule.
 */
export function sessionPermissions(pending: PendingPermission): PermissionUpdate[] {
  const updates: PermissionUpdate[] = pending.suggestions
    .filter((s) => s.type === 'addDirectories' || (s.type === 'addRules' && s.behavior === 'allow' && scopedRules(s)))
    .map((s) => ({ ...s, destination: 'session' }));
  if (!updates.some((u) => u.type === 'addRules')) {
    const command = exactBashCommand(pending);
    if (command !== null) {
      updates.push({
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: command }],
        behavior: 'allow',
        destination: 'session',
      });
    }
  }
  return updates;
}

/** Every rule names content (`Tool(content)`) or one MCP tool; none is a bare built-in tool. */
function scopedRules(suggestion: PermissionUpdate): boolean {
  const rules: unknown = suggestion.rules;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  return rules.every((rule: unknown) => {
    const { toolName, ruleContent } = (rule ?? {}) as { toolName?: unknown; ruleContent?: unknown };
    if (typeof ruleContent === 'string' && ruleContent.trim().length > 0) return true;
    return typeof toolName === 'string' && /^mcp__[^_\s]\S*__\S+$/.test(toolName);
  });
}

/** The command of a Bash request when an exact `Bash(<command>)` rule cannot match anything else. */
function exactBashCommand(pending: PendingPermission): string | null {
  if (pending.toolName !== 'Bash') return null;
  const command = (pending.input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  return trimmed.length > 0 && trimmed.length <= 500 && !hasShellMeta(trimmed) ? trimmed : null;
}

/**
 * `AskUserQuestion`'s input as Legion questions. The tool takes `questions: [{ question, header, options: [{ label,
 * description }], multiSelect }]`; its answers are keyed by the question text, so that is the id.
 */
export function askUserQuestions(input: unknown): UserQuestion[] {
  const list = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  return list.filter(isRecord).map((q) => ({
    id: String(q.question ?? ''),
    header: typeof q.header === 'string' ? q.header : null,
    question: String(q.question ?? ''),
    options: (Array.isArray(q.options) ? q.options : []).filter(isRecord).map((o) => ({
      label: String(o.label ?? ''),
      description: typeof o.description === 'string' ? o.description : null,
    })),
    multiSelect: q.multiSelect === true,
    // The CLI always offers "Other" with a typed answer.
    allowOther: true,
    secret: false,
  }));
}

/** The tool input that carries the user's answers: the original questions plus `answers` (labels, comma-joined). */
export function askUserAnswerInput(input: unknown, answers: QuestionAnswers): Record<string, unknown> {
  const joined: Record<string, string> = {};
  for (const [question, values] of Object.entries(answers)) joined[question] = values.join(', ');
  return { ...(isRecord(input) ? input : {}), answers: joined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
