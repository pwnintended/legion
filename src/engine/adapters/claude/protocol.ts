/**
 * Messages Legion writes to the CLI's stdin (stream-json input + control protocol). Shapes follow the
 * published `@anthropic-ai/claude-agent-sdk` 0.3.292 (`SDKUserMessage`, `SDKControlRequest`,
 * `control_response` with `PermissionResult`), which drives the same CLI.
 */
import type { ApprovalDecision, SessionAttachment } from '@shared/engine';
import { hasShellMeta } from '../../util/shell';
import { messageText, type ReadFile, readBase64 } from '../attachments';

export type StdinMessage = Record<string, unknown> & { type: string };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title: string };

/** What Claude takes as content blocks: images (PNG/JPEG/GIF/WebP) and PDFs. */
export const claudeNative = (attachment: SessionAttachment): boolean =>
  attachment.kind === 'image' || attachment.mime === 'application/pdf';

/**
 * The `content` of a user message: the plain text, or with attachments, image / document blocks (base64,
 * verified against the CLI: images and PDFs reach the model this way) followed by one text block that also
 * inlines text files and references anything else by path.
 */
export function userContent(
  text: string,
  attachments?: readonly SessionAttachment[] | null,
  read?: ReadFile,
): string | ContentBlock[] {
  if (!attachments?.length) return text;
  const blocks: ContentBlock[] = [];
  const sent = new Set<SessionAttachment>();
  for (const attachment of attachments) {
    if (!claudeNative(attachment)) continue;
    let data: string;
    try {
      data = readBase64(attachment, read);
    } catch {
      continue; // referenced by path in the text block instead
    }
    sent.add(attachment);
    blocks.push(
      attachment.kind === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: attachment.mime, data } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: attachment.name },
    );
  }
  blocks.push({ type: 'text', text: messageText(text, attachments, (a) => sent.has(a), read) });
  return blocks;
}

/** A user turn. `now` interrupts the running turn and is read immediately; default = next opportunity. */
export function userMessage(
  text: string,
  priority?: 'now' | 'next',
  attachments?: readonly SessionAttachment[] | null,
  read?: ReadFile,
): StdinMessage {
  return {
    type: 'user',
    message: { role: 'user', content: userContent(text, attachments, read) },
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
