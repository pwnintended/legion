/**
 * Stations ↔ tiles. The run's layout tree stays the model behind the route map: the pane shows the focused tile,
 * and a station's tabs are tiles of the tree (focused when they exist, opened when they don't). Keeping the
 * tree means tile ids, ⌘U jumps, approvals on the focused session and ⌘⏎ on a focused review keep working.
 */
import type { InboxItem } from '@shared/domain';
import { type DataState, latestPlan, openInbox, taskByNode } from '../app/data';
import { actions, dataStore, uiStore } from '../app/store';
import { allTiles, focusedTile, focusTile, type LayoutTile, type Workspace } from '../layout/tree';
import type { TileKind, TileParamsByKind } from '../layout/types';
import { openTile } from '../tiles/plan/kit';
import { type StationKey, stationNode, taskStation } from './route';

export interface TabSpec<K extends TileKind = TileKind> {
  /** Stable across stations of a kind ("changes" on T4 and on T5), so moving along the map keeps the tab. */
  id: string;
  label: string;
  kind: K;
  params: TileParamsByKind[K];
}

const tab = <K extends TileKind>(id: string, label: string, kind: K, params: TileParamsByKind[K]): TabSpec =>
  ({ id, label, kind, params }) as TabSpec;

/** The clarify question of the run still open, if any. */
function openClarify(data: DataState, runId: string): InboxItem | null {
  return openInbox(data.inbox, runId).find((i) => i.kind === 'question' && i.payload.source === 'clarify') ?? null;
}

/** The station a tile belongs to. */
export function stationOfTile(data: DataState, tile: LayoutTile): StationKey {
  const params = tile.params as Record<string, unknown>;
  const taskOf = (taskId: unknown): StationKey | null => {
    const task = typeof taskId === 'string' ? data.tasks[taskId] : undefined;
    return task ? taskStation(task.nodeId) : null;
  };
  switch (tile.kind) {
    case 'session': {
      const attempt = typeof params.attemptId === 'string' ? data.attempts[params.attemptId] : undefined;
      return taskOf(params.taskId) ?? taskOf(attempt?.taskId) ?? 'crew';
    }
    case 'review':
      return taskOf(params.taskId) ?? 'pr';
    case 'diff': {
      const target = params.target as { kind: string; taskId?: string };
      return (target.kind === 'task' ? taskOf(target.taskId) : null) ?? 'pr';
    }
    case 'terminal': {
      const attempt = typeof params.attemptId === 'string' ? data.attempts[params.attemptId] : undefined;
      return taskOf(attempt?.taskId) ?? 'crew';
    }
    case 'plan':
    case 'dag':
    case 'clarify':
      return 'plan';
    case 'integration':
      return 'integration';
    case 'pr':
      return 'pr';
    default:
      return 'crew';
  }
}

/** The tabs of a station, in order. */
export function stationTabs(data: DataState, runId: string, station: StationKey): TabSpec[] {
  const nodeId = stationNode(station);
  if (nodeId) {
    const task = taskByNode(data, runId, nodeId);
    if (!task) return [];
    return [
      tab('transcript', 'Transcript', 'session', { taskId: task.id, attemptId: null }),
      tab('changes', 'Changes', 'diff', { target: { kind: 'task', taskId: task.id } }),
      tab('review', 'Review', 'review', { taskId: task.id }),
    ];
  }
  switch (station) {
    case 'plan': {
      const tabs = [tab('plan', 'Plan', 'plan', { planId: null })];
      if ((latestPlan(data, runId)?.dag.nodes.length ?? 0) > 0) tabs.push(tab('graph', 'Graph', 'dag', {}));
      const clarify = openClarify(data, runId);
      if (clarify) tabs.unshift(tab('questions', 'Questions', 'clarify', { inboxItemId: clarify.id }));
      return tabs;
    }
    case 'integration':
      return [tab('integration', 'Integration', 'integration', {})];
    case 'pr':
      return [
        tab('pr', 'Pull request', 'pr', {}),
        tab('final', 'Final review', 'review', { taskId: null }),
        tab('changes', 'Changes', 'diff', { target: { kind: 'run', runId } }),
      ];
    default:
      return [tab('agents', 'Agents', 'agents', {}), tab('messages', 'Messages', 'messages', {})];
  }
}

/** Does `tile` show what `spec` asks for? (A session tile showing another attempt of the task still counts.) */
export function tileMatches(tile: LayoutTile, spec: TabSpec): boolean {
  if (tile.kind !== spec.kind) return false;
  const a = tile.params as Record<string, unknown>;
  const b = spec.params as Record<string, unknown>;
  switch (spec.kind) {
    case 'session':
    case 'review':
      return a.taskId === b.taskId;
    case 'diff':
      return JSON.stringify(a.target) === JSON.stringify(b.target);
    case 'clarify':
    case 'plan':
      return true;
    default:
      return JSON.stringify(a) === JSON.stringify(b);
  }
}

/** The focused tile's station, the selected plan node (a task-less station), or the plan before anything. */
export function selectedStation(data: DataState, layout: Workspace, mapNode: string | null): StationKey {
  if (mapNode) return taskStation(mapNode);
  const tile = focusedTile(layout);
  return tile ? stationOfTile(data, tile) : 'plan';
}

/** Show a tab of the run's pane: focus the tile that shows it, or open one. */
export function openTab(runId: string, spec: TabSpec): void {
  const layout = uiStore.getState().layouts[runId];
  if (!layout) return;
  actions.selectMapNode(runId, null);
  const existing = allTiles(layout).find(({ tile }) => tileMatches(tile, spec));
  if (existing) actions.updateLayout(runId, (l) => focusTile(l, existing.tile.id));
  else openTile(runId, spec.kind, spec.params);
}

/**
 * Select a station on the map. Moving between tasks keeps the tab ("changes" stays "changes"); a station
 * without that tab opens its first one. A plan node with no task yet is selected as a node.
 */
export function selectStation(runId: string, station: StationKey, keepTab: string | null = null): void {
  const data = dataStore.getState();
  const tabs = stationTabs(data, runId, station);
  const nodeId = stationNode(station);
  if (tabs.length === 0) {
    if (nodeId) actions.selectMapNode(runId, nodeId);
    return;
  }
  const spec = tabs.find((t) => t.id === keepTab) ?? (tabs[0] as TabSpec);
  openTab(runId, spec);
}

/** The tab the focused tile shows, among a station's tabs. */
export function activeTab(tabs: readonly TabSpec[], tile: LayoutTile | null): TabSpec | null {
  return tile ? (tabs.find((t) => tileMatches(tile, t)) ?? null) : null;
}
