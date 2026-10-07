/**
 * The route map's model (pure): a run's plan as one trunk from Plan to Pull request, its tasks grouped in waves
 * by dependency depth, and what of it is folded. Parallel work grows the map downward, never sideways: a wave
 * is a column of rows hanging off the trunk, however many tasks run side by side.
 *
 * Folding keeps the part of the run that is still moving open: finished waves fold to one line, an open wave's
 * merged rows fold to one line, and the waves after the first one still ahead fold into "Then n waves". Nothing
 * is ever reordered by attention; a selected row is never folded away.
 */
import type { TaskStatus } from '@shared/domain';
import { compareNodeIds, criticalPath, depths } from '../layout/dag';

/** Stations of the map: the crew, the plan, one per task (`task:<nodeId>`), integration, the pull request. */
export type StationKey = 'crew' | 'plan' | 'integration' | 'pr' | `task:${string}`;

export const taskStation = (nodeId: string): StationKey => `task:${nodeId}`;
export const stationNode = (station: StationKey | null): string | null =>
  station?.startsWith('task:') ? station.slice('task:'.length) : null;

/** How a row reads at a glance (marker colour): the human is needed, it failed, it moves, it is done, or not yet. */
export type RowState = 'waiting' | 'failed' | 'live' | 'done' | 'gone' | 'pending';

export interface RouteNode {
  id: string;
  title: string;
  dependsOn: readonly string[];
}

export interface RouteTask {
  id: string;
  status: TaskStatus;
  fixRounds: number;
}

export interface RouteRow {
  nodeId: string;
  title: string;
  /** Null before the plan is executed: the node has no task yet. */
  task: RouteTask | null;
  state: RowState;
  /** On the run's remaining critical path. */
  critical: boolean;
  deps: readonly string[];
  dependents: readonly string[];
}

export type WavePhase = 'done' | 'active' | 'ahead';

export interface Wave {
  /** 1-based, by dependency depth. */
  index: number;
  rows: RouteRow[];
  phase: WavePhase;
}

const LIVE: readonly TaskStatus[] = [
  'provisioning',
  'running',
  'verifying',
  'reviewing',
  'fixing',
  'approved',
  'merging',
];

export function rowState(task: RouteTask | null, waiting: boolean): RowState {
  // A failed task reads as failed even while its escalation waits on you: the title bar counts the waiting.
  if (task?.status === 'failed') return 'failed';
  if (waiting) return 'waiting';
  if (!task) return 'pending';
  if (task.status === 'awaiting_human') return 'waiting';
  if (task.status === 'merged') return 'done';
  if (task.status === 'skipped' || task.status === 'cancelled') return 'gone';
  if (LIVE.includes(task.status)) return 'live';
  return 'pending';
}

const finished = (state: RowState) => state === 'done' || state === 'gone';

/**
 * The run's waves: plan nodes grouped by dependency depth, in plan order within a wave. Tasks whose node is
 * missing from the plan (an amended plan) join a last wave of their own.
 */
export function buildWaves(
  nodes: readonly RouteNode[],
  tasks: ReadonlyMap<string, RouteTask>,
  waiting: ReadonlySet<string>,
): Wave[] {
  const depth = depths(nodes);
  const dependents = new Map<string, string[]>();
  for (const node of nodes)
    for (const dep of node.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
  // The critical path of what is left: finished work weighs nothing.
  const states = new Map(nodes.map((n) => [n.id, rowState(tasks.get(n.id) ?? null, waiting.has(n.id))]));
  const remaining = nodes.some((n) => !finished(states.get(n.id) ?? 'pending'));
  const critical = new Set(
    remaining ? criticalPath(nodes, (id) => (finished(states.get(id) ?? 'pending') ? 0 : 1)) : [],
  );

  const byDepth = new Map<number, RouteRow[]>();
  for (const node of [...nodes].sort((a, b) => compareNodeIds(a.id, b.id))) {
    const d = depth.get(node.id) ?? 0;
    const row: RouteRow = {
      nodeId: node.id,
      title: node.title,
      task: tasks.get(node.id) ?? null,
      state: states.get(node.id) ?? 'pending',
      critical: critical.has(node.id) && !finished(states.get(node.id) ?? 'pending'),
      deps: node.dependsOn,
      dependents: dependents.get(node.id) ?? [],
    };
    byDepth.set(d, [...(byDepth.get(d) ?? []), row]);
  }
  const known = new Set(nodes.map((n) => n.id));
  const orphans = [...tasks.entries()]
    .filter(([nodeId]) => !known.has(nodeId))
    .sort(([a], [b]) => compareNodeIds(a, b))
    .map<RouteRow>(([nodeId, task]) => ({
      nodeId,
      title: nodeId,
      task,
      state: rowState(task, waiting.has(nodeId)),
      critical: false,
      deps: [],
      dependents: [],
    }));
  const groups = [...byDepth.entries()].sort(([a], [b]) => a - b).map(([, rows]) => rows);
  if (orphans.length) groups.push(orphans);
  return groups.map((rows, i) => ({ index: i + 1, rows, phase: wavePhase(rows) }));
}

function wavePhase(rows: readonly RouteRow[]): WavePhase {
  if (rows.every((r) => finished(r.state))) return 'done';
  if (rows.every((r) => r.state === 'pending')) return 'ahead';
  return 'active';
}

// ---------------------------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------------------------

/** What the map draws between the Plan and Integration termini, top to bottom. */
export type MapItem =
  /** A wave folded to one line on the trunk. */
  | { kind: 'wave-folded'; key: string; wave: Wave }
  /** The head of an open wave of several rows (its bus hangs below it). */
  | { kind: 'wave-head'; key: string; wave: Wave; foldable: boolean }
  /** An open wave's merged rows, folded to one line on its bus. */
  | { kind: 'merged-fold'; key: string; wave: Wave; rows: RouteRow[] }
  /** A task row: on its wave's bus, or on the trunk itself when the wave has one row (`solo`). */
  | { kind: 'row'; key: string; wave: Wave; row: RouteRow; solo: boolean; dim: boolean; dense: boolean }
  /** The waves still ahead after the open ones, folded to one line. */
  | { kind: 'later'; key: string; waves: Wave[] };

/** Fold keys a user opened (`wave:<n>`, `merged:<n>`, `later`), or closed (`closed:wave:<n>`). */
export type Expanded = ReadonlySet<string>;

/** Rows of later waves shown before the rest folds into "Then n waves" (the next wave always opens). */
const AHEAD_BUDGET = 5;
/** Before anything ran, more of the plan is worth seeing. */
const AHEAD_BUDGET_UNSTARTED = 14;
/** A wave with more rows than this reads at the dense row height. */
export const DENSE_ROWS = 15;

export function foldMap(waves: readonly Wave[], selected: string | null, expanded: Expanded): MapItem[] {
  const out: MapItem[] = [];
  const has = (wave: Wave, nodeId: string | null) => nodeId !== null && wave.rows.some((r) => r.nodeId === nodeId);
  const started = waves.some((w) => w.phase !== 'ahead');
  const lastMoving = waves.reduce((at, w, i) => (w.phase === 'ahead' ? at : i), -1);
  let aheadShown = 0;
  let budget = started ? AHEAD_BUDGET : AHEAD_BUDGET_UNSTARTED;

  const pushRows = (wave: Wave, rows: readonly RouteRow[], dim: boolean) => {
    const solo = wave.rows.length === 1;
    const dense = wave.rows.length > DENSE_ROWS;
    for (const row of rows)
      out.push({ kind: 'row', key: `row:${row.nodeId}`, wave, row, solo, dim: dim && row.nodeId !== selected, dense });
  };

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i] as Wave;
    const solo = wave.rows.length === 1;
    if (wave.phase === 'done') {
      if (solo || expanded.has(`wave:${wave.index}`) || has(wave, selected)) {
        if (!solo) out.push({ kind: 'wave-head', key: `head:${wave.index}`, wave, foldable: !has(wave, selected) });
        pushRows(wave, wave.rows, false);
      } else out.push({ kind: 'wave-folded', key: `fold:${wave.index}`, wave });
      continue;
    }
    if (wave.phase === 'active') {
      if (!solo) out.push({ kind: 'wave-head', key: `head:${wave.index}`, wave, foldable: false });
      const merged = wave.rows.filter((r) => finished(r.state));
      const foldMerged =
        merged.length >= 2 && !expanded.has(`merged:${wave.index}`) && !has({ ...wave, rows: merged }, selected);
      if (foldMerged) out.push({ kind: 'merged-fold', key: `merged:${wave.index}`, wave, rows: merged });
      pushRows(wave, foldMerged ? wave.rows.filter((r) => !finished(r.state)) : wave.rows, false);
      continue;
    }
    // Ahead. In the tail (nothing moves after it), the first wave is always open, then the budget decides; the
    // rest folds into one line. An ahead wave between moving ones stays open.
    const inTail = i > lastMoving;
    const opened = expanded.has(`wave:${wave.index}`) || expanded.has('later');
    const fits = aheadShown === 0 || aheadShown + wave.rows.length <= budget;
    if (!inTail || opened || has(wave, selected) || (fits && !expanded.has(`closed:wave:${wave.index}`))) {
      if (!solo)
        out.push({ kind: 'wave-head', key: `head:${wave.index}`, wave, foldable: inTail && !has(wave, selected) });
      pushRows(wave, wave.rows, true);
      if (inTail) aheadShown += wave.rows.length;
      continue;
    }
    // Fold this wave and every later one, unless the selection sits further down: then open up to it.
    const rest = waves.slice(i);
    const selectedAt = rest.findIndex((w) => has(w, selected));
    if (selectedAt > 0) {
      budget = Number.POSITIVE_INFINITY;
      i--;
      expanded = new Set([...expanded, `wave:${wave.index}`]);
      continue;
    }
    out.push({ kind: 'later', key: 'later', waves: rest });
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Counts and words
// ---------------------------------------------------------------------------------------------

export interface RouteCounts {
  tasks: number;
  working: number;
  waiting: number;
  failed: number;
  done: number;
}

export function routeCounts(waves: readonly Wave[]): RouteCounts {
  const counts: RouteCounts = { tasks: 0, working: 0, waiting: 0, failed: 0, done: 0 };
  for (const wave of waves)
    for (const row of wave.rows) {
      counts.tasks++;
      if (row.state === 'live') counts.working++;
      else if (row.state === 'waiting') counts.waiting++;
      else if (row.state === 'failed') counts.failed++;
      else if (row.state === 'done') counts.done++;
    }
  return counts;
}

/** The map's short stage word for a row ("coding", "fix 1/2", "waiting"): short, so titles keep their width. */
export function stageWord(row: RouteRow, maxFixRounds: number): string {
  if (row.state === 'failed') return 'failed';
  if (row.state === 'waiting') return 'waiting';
  const task = row.task;
  if (!task) return 'pending';
  switch (task.status) {
    case 'blocked':
      return 'pending';
    case 'provisioning':
      return 'setup';
    case 'running':
      return 'coding';
    case 'verifying':
      return 'checks';
    case 'reviewing':
      return 'review';
    case 'fixing':
      return `fix ${task.fixRounds}/${maxFixRounds}`;
    default:
      return task.status;
  }
}

/** The rows in map order, for keyboard travel (⌘⌥J/K), folded ones included. */
export function rowOrder(waves: readonly Wave[]): string[] {
  return waves.flatMap((w) => w.rows.map((r) => r.nodeId));
}

/** "Wave 2 · 11 in parallel · 4 merged" and the folded forms. */
export function waveLabel(wave: Wave): { title: string; detail: string } {
  const n = wave.rows.length;
  const merged = wave.rows.filter((r) => r.state === 'done').length;
  const gone = wave.rows.filter((r) => r.state === 'gone').length;
  const title = `Wave ${wave.index}`;
  if (wave.phase === 'done')
    return { title, detail: [`${merged} merged`, gone ? `${gone} skipped` : ''].filter(Boolean).join(' · ') };
  if (wave.phase === 'ahead') return { title, detail: `${n} ${n === 1 ? 'task' : 'tasks'}` };
  return { title, detail: [`${n} in parallel`, merged ? `${merged} merged` : ''].filter(Boolean).join(' · ') };
}
