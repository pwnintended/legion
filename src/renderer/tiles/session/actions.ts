/**
 * Session-side actions shared by the session tile, the inbox and the palette: answering approvals, steering,
 * interrupting, taking over, opening a task's diff. Small external stores track in-flight state so a decision
 * made by keyboard (`a`/`A`/`d`) shows the same feedback as a click.
 */
import type { ApprovalDecision, Attempt, InboxItemOf, Task } from '@shared/domain';
import { useSyncExternalStore } from 'react';
import { attemptsOfRun, type DataState, openInbox } from '../../app/data';
import { rpc } from '../../app/hooks';
import { itemResolved, whenData } from '../../app/pending';
import { actions, dataStore, uiStore } from '../../app/store';
import {
  allocateId,
  allTiles,
  columnOfTile,
  focusTile,
  insertColumn,
  type LayoutTile,
  makeColumn,
  type Workspace,
} from '../../layout/tree';

// ---------------------------------------------------------------------------------------------
// Tiny external store
// ---------------------------------------------------------------------------------------------

function createMapStore<V>() {
  let map = new Map<string, V>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    get: (key: string) => map.get(key),
    set(key: string, value: V | undefined) {
      map = new Map(map);
      if (value === undefined) map.delete(key);
      else map.set(key, value);
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => map,
  };
}

function useMapStore<V>(store: ReturnType<typeof createMapStore<V>>, key: string | null | undefined): V | undefined {
  const map = useSyncExternalStore(store.subscribe, store.snapshot);
  return key ? map.get(key) : undefined;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'not_implemented') return 'The engine does not support this yet.';
  if (code === 'disconnected') return 'Engine disconnected; try again in a moment.';
  return message;
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

export type ApprovalChoice = 'accept' | 'acceptTask' | 'deny';

export function approvalDecision(choice: ApprovalChoice): ApprovalDecision {
  switch (choice) {
    case 'accept':
      return { behavior: 'allow', scope: 'once', updatedInput: null };
    case 'acceptTask':
      return { behavior: 'allow', scope: 'session', updatedInput: null };
    case 'deny':
      return { behavior: 'deny', message: 'The user denied this request.', interrupt: false };
  }
}

/** `choice` is the approval choice, or the escalation action, being sent. */
type Pending = { state: 'pending'; choice: string } | { state: 'error'; message: string };
const pendingStore = createMapStore<Pending>();

export const usePendingResolution = (itemId: string | null | undefined) => useMapStore(pendingStore, itemId);
export const pendingResolution = (itemId: string) => pendingStore.get(itemId);

/**
 * Generic inbox resolution with in-flight/error tracking (inbox, approval and escalation cards, keys). The
 * item stays pending until the store shows it resolved (the `inbox.updated` event), not just until the RPC
 * returns: a held or repeated key in between must not send a second `inbox.resolve`.
 */
export async function trackResolution(itemId: string, choice: string, run: () => Promise<unknown>): Promise<void> {
  const current = pendingStore.get(itemId);
  if (current?.state === 'pending') return;
  pendingStore.set(itemId, { state: 'pending', choice });
  try {
    await run();
    await whenData(itemResolved(itemId));
    pendingStore.set(itemId, undefined);
  } catch (error) {
    pendingStore.set(itemId, { state: 'error', message: errorMessage(error) });
  }
}

export function resolveApproval(item: InboxItemOf<'approval'>, choice: ApprovalChoice): Promise<void> {
  return trackResolution(item.id, choice, () =>
    rpc('inbox.resolve', { itemId: item.id, resolution: { kind: 'approval', decision: approvalDecision(choice) } }),
  );
}

/** Open approvals that belong to an attempt (or to its task when the item has no attempt id). */
export function openApprovals(state: DataState, runId: string, attempt: Attempt | null): InboxItemOf<'approval'>[] {
  if (!attempt) return [];
  return openInbox(state.inbox, runId).filter(
    (i): i is InboxItemOf<'approval'> =>
      i.kind === 'approval' &&
      (i.attemptId === attempt.id || (i.attemptId === null && attempt.taskId !== null && i.taskId === attempt.taskId)),
  );
}

// ---------------------------------------------------------------------------------------------
// Attempt selection
// ---------------------------------------------------------------------------------------------

const WORKING_ROLES: readonly Attempt['role'][] = ['coder', 'resolver'];

/** The attempt a session tile shows by default: the latest coder/resolver attempt, else the latest attempt. */
export function defaultAttempt(attempts: readonly Attempt[]): Attempt | null {
  return attempts.filter((a) => WORKING_ROLES.includes(a.role)).at(-1) ?? attempts.at(-1) ?? null;
}

export function taskAttempts(state: DataState, task: Task | null): Attempt[] {
  return task ? attemptsOfRun(state.attempts, task.runId).filter((a) => a.taskId === task.id) : [];
}

/** The attempt behind a session tile's params (explicit attempt, else the task's default). */
export function resolveSessionAttempt(
  state: DataState,
  params: { attemptId: string | null; taskId: string | null },
): Attempt | null {
  if (params.attemptId) return state.attempts[params.attemptId] ?? null;
  const task = params.taskId ? (state.tasks[params.taskId] ?? null) : null;
  return defaultAttempt(taskAttempts(state, task));
}

// ---------------------------------------------------------------------------------------------
// Steering (optimistic "you" rows; the engine has no user-message event)
// ---------------------------------------------------------------------------------------------

export interface SentMessage {
  id: number;
  text: string;
  priority: 'now' | 'next';
  status: 'sending' | 'sent' | 'error';
  error: string | null;
  ts: number;
}

const sentStore = createMapStore<SentMessage[]>();
let sentId = 0;
const NO_SENT: SentMessage[] = [];

export const useSentMessages = (attemptId: string | null | undefined) => useMapStore(sentStore, attemptId) ?? NO_SENT;

export async function steer(attemptId: string, text: string, priority: 'now' | 'next'): Promise<void> {
  const id = ++sentId;
  const message: SentMessage = { id, text, priority, status: 'sending', error: null, ts: Date.now() };
  const update = (patch: Partial<SentMessage>) =>
    sentStore.set(
      attemptId,
      (sentStore.get(attemptId) ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  sentStore.set(attemptId, [...(sentStore.get(attemptId) ?? []), message]);
  try {
    await rpc('sessions.send', { attemptId, text, priority });
    update({ status: 'sent' });
  } catch (error) {
    update({ status: 'error', error: errorMessage(error) });
  }
}

export function dismissSent(attemptId: string, id: number): void {
  sentStore.set(
    attemptId,
    (sentStore.get(attemptId) ?? []).filter((m) => m.id !== id),
  );
}

// ---------------------------------------------------------------------------------------------
// Session notices (interrupt / takeover feedback)
// ---------------------------------------------------------------------------------------------

export interface Notice {
  tone: 'info' | 'error';
  text: string;
}
const noticeStore = createMapStore<Notice>();
export const useNotice = (attemptId: string | null | undefined) => useMapStore(noticeStore, attemptId);
export const clearNotice = (attemptId: string) => noticeStore.set(attemptId, undefined);

export async function interrupt(attemptId: string): Promise<void> {
  try {
    await rpc('sessions.interrupt', { attemptId });
    noticeStore.set(attemptId, { tone: 'info', text: 'Interrupted. The session is waiting for your next message.' });
  } catch (error) {
    noticeStore.set(attemptId, { tone: 'error', text: `Interrupt failed: ${errorMessage(error)}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------------------------

function newColumnAfter(layout: Workspace, anchorTileId: string | null, tile: Omit<LayoutTile, 'id'>, prefix: string) {
  const [id, next] = allocateId(layout, prefix);
  const column = makeColumn({ id: `col:${id}`, width: '1/2', tiles: [{ ...tile, id } as LayoutTile] });
  const anchor = anchorTileId ? columnOfTile(next, anchorTileId) : null;
  return insertColumn(next, column, anchor?.id ?? next.focus?.column ?? null, true);
}

/** Focus the task's diff tile, or open one right of the session tile. */
export function openTaskDiff(runId: string, taskId: string, anchorTileId: string | null): void {
  actions.updateLayout(
    runId,
    (layout) => {
      const existing = allTiles(layout).find(
        ({ tile }) =>
          tile.kind === 'diff' &&
          (tile.params as { target: { kind: string; taskId?: string } }).target.kind === 'task' &&
          (tile.params as { target: { taskId?: string } }).target.taskId === taskId,
      );
      if (existing) return focusTile(layout, existing.tile.id);
      return newColumnAfter(
        layout,
        anchorTileId,
        { kind: 'diff', params: { target: { kind: 'task', taskId } }, auto: false },
        'diff',
      );
    },
    true,
  );
  if (uiStore.getState().layoutMode !== 'strip' && uiStore.getState().layoutMode !== 'focus')
    actions.setLayoutMode('strip');
}

/**
 * Take over a session: stop the structured session and resume it in a PTY (`sessions.takeover`), then put a
 * terminal tile for that attempt next to the session tile.
 */
export async function takeOver(
  attempt: Attempt,
  anchorTileId: string | null,
  size = { cols: 120, rows: 36 },
): Promise<boolean> {
  try {
    const { terminalId } = await rpc('sessions.takeover', { attemptId: attempt.id, ...size });
    const cwd = attempt.taskId ? (dataStore.getState().tasks[attempt.taskId]?.worktreePath ?? null) : null;
    actions.updateLayout(
      attempt.runId,
      (layout) =>
        newColumnAfter(
          layout,
          anchorTileId,
          { kind: 'terminal', params: { terminalId, cwd, attemptId: attempt.id }, auto: false },
          'terminal',
        ),
      true,
    );
    actions.setLayoutMode('strip');
    clearNotice(attempt.id);
    return true;
  } catch (error) {
    noticeStore.set(attempt.id, { tone: 'error', text: `Takeover failed: ${errorMessage(error)}` });
    return false;
  }
}

/** The session tile of a task in a run's layout (for palette/inbox jumps). */
export function sessionTileOf(layout: Workspace | null | undefined, taskId: string): string | null {
  if (!layout) return null;
  const hit = allTiles(layout).find(
    ({ tile }) => tile.kind === 'session' && (tile.params as { taskId: string | null }).taskId === taskId,
  );
  return hit?.tile.id ?? null;
}
