/**
 * `syncWithRun`: derive the strip from a run (architecture §11 "the run's DAG drives insertion").
 *
 * Desired columns, in order: plan (with a clarify tile on top while questions are open), the DAG while a plan
 * awaits sign-off, one column per task in topological order (session tile, plus the review tile stacked under
 * it while reviewing/fixing), and an `end` column (integration, then PR) once execution starts.
 *
 * The user's manual changes survive: existing columns are never reordered, pinned width/collapse/mode are left
 * alone, user-created columns and tiles are never removed, and focus only moves when its target disappears.
 */
import type { RunStatus, TaskStatus } from '@shared/domain';
import { compareNodeIds, type DagNode, topoOrder } from './dag';
import {
  type Column,
  type ColumnMode,
  type ExpandedWidth,
  emptyWorkspace,
  focusTile,
  type LayoutTile,
  normalize,
  type Workspace,
} from './tree';

export interface RunLayoutInput {
  runId: string;
  status: RunStatus;
  /** Latest plan's DAG nodes (empty before the first plan). */
  nodes: readonly DagNode[];
  tasks: readonly { id: string; nodeId: string; status: TaskStatus }[];
  /** Open clarify question (inbox item id), if any. */
  clarifyItemId: string | null;
  /** The run's assistant attempt (the conversation), if any. */
  assistantAttemptId: string | null;
  /** The run has coordinating agents (an assistant or a lead): show the agents and messages tiles. */
  hierarchy: boolean;
}

interface DesiredColumn {
  key: string;
  mode: ColumnMode;
  width: ExpandedWidth;
  /** Collapsed unless the user pinned it otherwise. */
  collapsed: boolean;
  tiles: LayoutTile[];
  /** For task columns: the node, its topological index and its first dependency. */
  task?: { nodeId: string; topo: number; firstDep: string | null };
}

const PRE_EXECUTION: readonly RunStatus[] = ['chatting', 'draft', 'clarifying', 'planning', 'awaiting_approval'];
const END_STATUSES: readonly RunStatus[] = ['executing', 'integrating', 'finalizing', 'pr_ready', 'done'];
const PR_STATUSES: readonly RunStatus[] = ['finalizing', 'pr_ready', 'done'];
/** Tasks that have not started or are finished collapse to thin columns. */
const THIN_TASK_STATUSES: readonly TaskStatus[] = ['blocked', 'queued', 'merged', 'skipped', 'cancelled'];
const REVIEW_TASK_STATUSES: readonly TaskStatus[] = ['reviewing', 'fixing'];
/** Where initial focus goes, best first. */
const FOCUS_PRIORITY: readonly TaskStatus[] = [
  'awaiting_human',
  'failed',
  'running',
  'fixing',
  'reviewing',
  'verifying',
];

export const columnIdForKey = (key: string): string => `col:${key}`;
export const taskKey = (nodeId: string): string => `task:${nodeId}`;

function tile<K extends LayoutTile['kind']>(id: string, kind: K, params: LayoutTile<K>['params']): LayoutTile {
  return { id, kind, params, auto: true } as LayoutTile;
}

export function desiredColumns(input: RunLayoutInput): DesiredColumn[] {
  const out: DesiredColumn[] = [];
  if (input.assistantAttemptId) {
    out.push({
      key: 'assistant',
      mode: 'split',
      width: '1/2',
      collapsed: false,
      tiles: [tile('assistant', 'session', { attemptId: input.assistantAttemptId, taskId: null })],
    });
  }
  const planTiles: LayoutTile[] = [];
  if (input.clarifyItemId) planTiles.push(tile('clarify', 'clarify', { inboxItemId: input.clarifyItemId }));
  planTiles.push(tile('plan', 'plan', { planId: null }));
  out.push({ key: 'plan', mode: 'split', width: '1/3', collapsed: false, tiles: planTiles });

  if (input.hierarchy) {
    out.push({
      key: 'agents',
      mode: 'stacked',
      width: '1/3',
      collapsed: input.status !== 'executing',
      tiles: [tile('agents', 'agents', {}), tile('messages', 'messages', {})],
    });
  }

  if (input.nodes.length > 0 && PRE_EXECUTION.includes(input.status)) {
    out.push({
      key: 'dag',
      mode: 'split',
      width: '1/2',
      collapsed: input.status !== 'awaiting_approval',
      tiles: [tile('dag', 'dag', {})],
    });
  }

  const order = topoOrder(
    input.nodes.length > 0 ? input.nodes : input.tasks.map((t) => ({ id: t.nodeId, dependsOn: [] })),
  );
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const taskByNode = new Map(input.tasks.map((t) => [t.nodeId, t]));
  // Tasks whose node is missing from the latest plan still get a column (at the end, by id).
  const extra = input.tasks.map((t) => t.nodeId).filter((id) => !order.includes(id));
  order.push(...extra.sort(compareNodeIds));
  order.forEach((nodeId, topo) => {
    const task = taskByNode.get(nodeId);
    if (!task) return;
    const tiles = [tile(`session:${nodeId}`, 'session', { taskId: task.id, attemptId: null })];
    if (REVIEW_TASK_STATUSES.includes(task.status)) tiles.push(tile(`review:${nodeId}`, 'review', { taskId: task.id }));
    out.push({
      key: taskKey(nodeId),
      mode: 'split',
      width: '1/2',
      collapsed: THIN_TASK_STATUSES.includes(task.status),
      tiles,
      task: { nodeId, topo, firstDep: nodeById.get(nodeId)?.dependsOn[0] ?? null },
    });
  });

  if (END_STATUSES.includes(input.status)) {
    const tiles = [tile('integration', 'integration', {})];
    if (PR_STATUSES.includes(input.status)) tiles.push(tile('pr', 'pr', {}));
    out.push({ key: 'end', mode: 'split', width: '1/3', collapsed: input.status === 'executing', tiles });
  }
  return out;
}

/** Reconcile a column's auto tiles with the desired ones, keeping user tiles and their relative order. */
function reconcileTiles(column: Column, desired: DesiredColumn): Column {
  const wanted = new Map(desired.tiles.map((t) => [t.id, t]));
  let tiles = column.tiles.filter((t) => !t.auto || wanted.has(t.id));
  // Refresh params of auto tiles (e.g. a clarify tile pointing at a new inbox item).
  tiles = tiles.map((t) => {
    const want = wanted.get(t.id);
    return want && JSON.stringify(want.params) !== JSON.stringify(t.params) ? { ...t, params: want.params } : t;
  });
  desired.tiles.forEach((want, index) => {
    if (tiles.some((t) => t.id === want.id)) return;
    // Insert after the previous desired tile that is present, else at the top.
    const prev = desired.tiles
      .slice(0, index)
      .reverse()
      .find((p) => tiles.some((t) => t.id === p.id));
    const at = prev ? tiles.findIndex((t) => t.id === prev.id) + 1 : 0;
    tiles = [...tiles.slice(0, at), want, ...tiles.slice(at)];
  });
  const collapsed = column.pinned.collapsed ? column.collapsed : desired.collapsed;
  const unchanged =
    collapsed === column.collapsed &&
    tiles.length === column.tiles.length &&
    tiles.every((t, i) => t === column.tiles[i]);
  if (unchanged) return column;
  const active = tiles.some((t) => t.id === column.active) ? column.active : (tiles[0]?.id ?? column.active);
  return { ...column, tiles, collapsed, active };
}

function newColumn(desired: DesiredColumn): Column {
  return {
    id: columnIdForKey(desired.key),
    key: desired.key,
    mode: desired.mode,
    width: desired.width,
    collapsed: desired.collapsed,
    tiles: desired.tiles,
    active: (desired.tiles[0] as LayoutTile).id,
    pinned: {},
  };
}

function insertionIndex(columns: readonly Column[], desired: DesiredColumn, all: readonly DesiredColumn[]): number {
  if (desired.key === 'end') return columns.length;
  const indexOfKey = (key: string) => columns.findIndex((c) => c.key === key);
  const topoOf = (column: Column): number | null => all.find((d) => d.key === column.key && d.task)?.task?.topo ?? null;

  if (desired.task?.firstDep) {
    const depIndex = indexOfKey(taskKey(desired.task.firstDep));
    if (depIndex !== -1) {
      let index = depIndex + 1;
      // Skip siblings that come earlier in topological order, so T2, T3 (both after T1) stay in order.
      while (index < columns.length) {
        const topo = topoOf(columns[index] as Column);
        if (topo === null || topo >= desired.task.topo) break;
        index++;
      }
      return index;
    }
  }
  // Otherwise: right after the closest preceding desired column that already exists.
  const position = all.indexOf(desired);
  for (let i = position - 1; i >= 0; i--) {
    const index = indexOfKey((all[i] as DesiredColumn).key);
    if (index !== -1) return index + 1;
  }
  const end = indexOfKey('end');
  return end === -1 ? Math.min(columns.length, position) : end;
}

function defaultFocus(ws: Workspace, input: RunLayoutInput): Workspace {
  if (input.status === 'chatting') {
    const conversation = ws.strip.columns.find((c) => c.key === 'assistant');
    if (conversation) return { ...ws, focus: { column: conversation.id, tile: conversation.active } };
  }
  for (const status of FOCUS_PRIORITY) {
    const task = [...input.tasks].sort((a, b) => compareNodeIds(a.nodeId, b.nodeId)).find((t) => t.status === status);
    const column = task && ws.strip.columns.find((c) => c.key === taskKey(task.nodeId));
    if (column) return { ...ws, focus: { column: column.id, tile: column.active } };
  }
  // A run past execution lands on its PR (the human gate, or the result).
  const end = PR_STATUSES.includes(input.status) ? ws.strip.columns.find((c) => c.key === 'end') : undefined;
  const prTile = end?.tiles.find((t) => t.kind === 'pr');
  if (end && prTile) return focusTile(ws, prTile.id);
  const plan = ws.strip.columns.find((c) => c.key === 'plan');
  return plan ? { ...ws, focus: { column: plan.id, tile: plan.active } } : normalize(ws);
}

export function syncWithRun(layout: Workspace | null, input: RunLayoutInput): Workspace {
  const base = layout && layout.runId === input.runId ? layout : emptyWorkspace(input.runId);
  const desired = desiredColumns(input);
  const desiredByKey = new Map(desired.map((d) => [d.key, d]));
  const fresh = base.strip.columns.length === 0;

  // 1. Drop auto columns the run no longer has; reconcile the rest.
  const focusIndex = base.focus ? base.strip.columns.findIndex((c) => c.id === base.focus?.column) : -1;
  let columns = base.strip.columns
    .filter((c) => c.key === null || desiredByKey.has(c.key) || c.tiles.some((t) => !t.auto))
    .map((c) => {
      const want = c.key === null ? undefined : desiredByKey.get(c.key);
      if (!want) return c.key === null ? c : { ...c, key: null, tiles: c.tiles.filter((t) => !t.auto) };
      return reconcileTiles(c, want);
    })
    .filter((c) => c.tiles.length > 0)
    .map((c) => (c.tiles.some((t) => t.id === c.active) ? c : { ...c, active: (c.tiles[0] as LayoutTile).id }));

  // 2. Insert missing columns.
  for (const want of desired) {
    if (columns.some((c) => c.key === want.key)) continue;
    const column = newColumn(want);
    if (columns.some((c) => c.id === column.id)) continue;
    const index = fresh ? columns.length : insertionIndex(columns, want, desired);
    columns = [...columns.slice(0, index), column, ...columns.slice(index)];
  }

  let next: Workspace = { ...base, strip: { columns } };
  next = base.focus ? normalize(next, Math.max(0, focusIndex)) : defaultFocus(next, input);
  return sameWorkspace(base, next) && layout ? layout : next;
}

export function sameWorkspace(a: Workspace, b: Workspace): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
