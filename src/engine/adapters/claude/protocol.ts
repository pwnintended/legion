/**
 * Messages Legion writes to the CLI's stdin (stream-json input + control protocol). Shapes follow the
 * published `@anthropic-ai/claude-agent-sdk` 0.3.292 (`SDKUserMessage`, `SDKControlRequest`,
 * `control_response` with `PermissionResult`), which drives the same CLI.
 */
import type { ApprovalDecision } from '@shared/engine';

export type StdinMessage = Record<string, unknown> & { type: string };

/** A user turn. `now` interrupts the running turn and is read immediately; default = next opportunity. */
export function userMessage(text: string, priority?: 'now' | 'next'): StdinMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
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
 * `destination: "session"` (never `localSettings`, which would write the repo's `.claude/settings.local.json`),
 * or adds a whole-tool session rule when the CLI offered none.
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
  if (decision.scope === 'session') response.updatedPermissions = sessionPermissions(pending);
  if (toolUseID) response.toolUseID = toolUseID;
  return controlSuccess(pending.requestId, response);
}

export function sessionPermissions(pending: PendingPermission): PermissionUpdate[] {
  const updates: PermissionUpdate[] = pending.suggestions
    .filter((s) => s.type === 'addRules' || s.type === 'addDirectories')
    .filter((s) => s.type !== 'addRules' || s.behavior === 'allow')
    .map((s) => ({ ...s, destination: 'session' }));
  if (!updates.some((u) => u.type === 'addRules')) {
    updates.push({
      type: 'addRules',
      rules: [{ toolName: pending.toolName }],
      behavior: 'allow',
      destination: 'session',
    });
  }
  return updates;
}
