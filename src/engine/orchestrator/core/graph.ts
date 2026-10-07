/**
 * Graph utilities over plan nodes. Edges point from a dependency to its dependent (`dep → node` iff
 * `node.dependsOn` contains `dep`). Every function is deterministic: ties are broken by node id
 * (`T2` < `T10`). Functions that need an acyclic graph throw `CycleError`; run `findCycle` first.
 */
import type { TaskSize } from '@shared/domain';

export interface GraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** Weight of a node in path computations (critical path, remaining path, priorities). */
export const SIZE_WEIGHT: { readonly [S in TaskSize]: number } = { S: 1, M: 2, L: 4 };

export type Weight<N extends GraphNode> = (node: N) => number;

export function sizeWeight(node: GraphNode & { readonly size?: TaskSize }): number {
  return node.size ? SIZE_WEIGHT[node.size] : 1;
}

export class CycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`dependency cycle: ${cycle.join(' → ')}`);
    this.name = 'CycleError';
  }
}

/** `T2` < `T10`; non-`T<n>` ids sort after, lexicographically. */
export function compareNodeIds(a: string, b: string): number {
  const na = /^T(\d+)$/.exec(a);
  const nb = /^T(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]) || a.localeCompare(b);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface GraphIndex<N extends GraphNode> {
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, N>;
  /** Known dependencies only (unknown ids are ignored), deduplicated, sorted. */
  readonly deps: ReadonlyMap<string, readonly string[]>;
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

export function indexGraph<N extends GraphNode>(nodes: readonly N[]): GraphIndex<N> {
  const byId = new Map<string, N>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const ids = [...byId.keys()].sort(compareNodeIds);
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    const node = byId.get(id) as N;
    const known = [...new Set(node.dependsOn)].filter((d) => byId.has(d) && d !== id).sort(compareNodeIds);
    deps.set(id, known);
    for (const dep of known) dependents.get(dep)?.push(id);
  }
  return { ids, byId, deps, dependents };
}

/** A cycle as `[a, b, ..., a]` (dependency direction), or null. Self-dependencies count. */
export function findCycle(nodes: readonly GraphNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    const deps = [...new Set(byId.get(id)?.dependsOn ?? [])].filter((d) => byId.has(d)).sort(compareNodeIds);
    for (const dep of deps) {
      const s = state.get(dep);
      if (s === 1) return [...stack.slice(stack.indexOf(dep)), dep].reverse();
      if (s === undefined) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of [...byId.keys()].sort(compareNodeIds)) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Longest-chain depth of each node: roots are 0, otherwise 1 + max depth of its deps. This is the
 * "topological rank" used for layouts and for orienting auto edges.
 */
export function depths(nodes: readonly GraphNode[]): Map<string, number> {
  const index = indexGraph(nodes);
  const depth = new Map<string, number>();
  for (const id of topologicalOrder(nodes)) {
    const ds = index.deps.get(id) ?? [];
    depth.set(id, ds.length === 0 ? 0 : 1 + Math.max(...ds.map((d) => depth.get(d) ?? 0)));
  }
  return depth;
}

/**
 * Deterministic topological order (Kahn, lowest available id first): dependencies always come before
 * dependents. Throws `CycleError`.
 */
export function topologicalOrder(nodes: readonly GraphNode[]): string[] {
  const index = indexGraph(nodes);
  const remaining = new Map(index.ids.map((id) => [id, (index.deps.get(id) ?? []).length]));
  const available = index.ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (available.length > 0) {
    available.sort(compareNodeIds);
    const id = available.shift() as string;
    order.push(id);
    for (const next of index.dependents.get(id) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) available.push(next);
    }
  }
  if (order.length !== index.ids.length) throw new CycleError(findCycle(nodes) ?? []);
  return order;
}

/**
 * Topological order sorted by (depth, id): all of layer 0, then layer 1, ... Still a valid
 * linear extension (every dep has a strictly smaller depth).
 */
export function layeredOrder(nodes: readonly GraphNode[]): string[] {
  const depth = depths(nodes);
  return [...depth.keys()].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || compareNodeIds(a, b));
}

/** Depth layers for the Pipeline layout: `layers[k]` = ids with depth k, sorted by id. */
export function depthLayers(nodes: readonly GraphNode[]): string[][] {
  const layers: string[][] = [];
  for (const [id, d] of depths(nodes)) {
    while (layers.length <= d) layers.push([]);
    layers[d]?.push(id);
  }
  for (const layer of layers) layer.sort(compareNodeIds);
  return layers;
}

function walk(start: string, next: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(next.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return seen;
}

/** Transitive dependencies of `id` (excluding itself). */
export function ancestors(nodes: readonly GraphNode[], id: string): Set<string> {
  return walk(id, indexGraph(nodes).deps);
}

/** Transitive dependents of `id` (excluding itself). */
export function descendants(nodes: readonly GraphNode[], id: string): Set<string> {
  return walk(id, indexGraph(nodes).dependents);
}

/** reach.get(a).has(b) ⇔ there is a non-empty path a → … → b (b transitively depends on a). */
export function reachability(nodes: readonly GraphNode[]): Map<string, Set<string>> {
  const index = indexGraph(nodes);
  return new Map(index.ids.map((id) => [id, walk(id, index.dependents)]));
}

/** Two nodes are ordered iff one transitively depends on the other. */
export function areOrdered(reach: ReadonlyMap<string, ReadonlySet<string>>, a: string, b: string): boolean {
  return reach.get(a)?.has(b) === true || reach.get(b)?.has(a) === true;
}

export interface Edge {
  /** The dependency. */
  readonly from: string;
  /** The dependent (`to.dependsOn` contains `from`). */
  readonly to: string;
}

/** Declared edges implied by a longer path (`A→C` when `A→B→C` exists). Sorted. Throws on cycles. */
export function redundantEdges(nodes: readonly GraphNode[]): Edge[] {
  const index = indexGraph(nodes);
  topologicalOrder(nodes);
  const reach = reachability(nodes);
  const out: Edge[] = [];
  for (const to of index.ids) {
    const deps = index.deps.get(to) ?? [];
    for (const from of deps) {
      if (deps.some((other) => other !== from && reach.get(from)?.has(other))) out.push({ from, to });
    }
  }
  return out;
}

/** Same nodes with redundant dependencies removed (the unique transitive reduction of a DAG). */
export function transitiveReduction<N extends GraphNode>(nodes: readonly N[]): N[] {
  const redundant = new Set(redundantEdges(nodes).map((e) => `${e.from}>${e.to}`));
  return nodes.map((node) => ({
    ...node,
    dependsOn: node.dependsOn.filter((dep) => !redundant.has(`${dep}>${node.id}`)),
  }));
}

export function isTransitivelyReduced(nodes: readonly GraphNode[]): boolean {
  return redundantEdges(nodes).length === 0;
}

/** Direct dependents per node. */
export function fanOut(nodes: readonly GraphNode[]): Map<string, number> {
  const index = indexGraph(nodes);
  return new Map(index.ids.map((id) => [id, (index.dependents.get(id) ?? []).length]));
}

/**
 * Longest remaining path per node: its own weight plus the heaviest chain of dependents below it.
 * This is the scheduler's primary priority (start the long chains first).
 */
export function longestRemainingPath<N extends GraphNode>(
  nodes: readonly N[],
  weight: Weight<N> = sizeWeight as Weight<N>,
): Map<string, number> {
  const index = indexGraph(nodes);
  const order = topologicalOrder(nodes);
  const result = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i] as string;
    const below = (index.dependents.get(id) ?? []).map((d) => result.get(d) ?? 0);
    result.set(id, weight(index.byId.get(id) as N) + (below.length > 0 ? Math.max(...below) : 0));
  }
  return result;
}

export interface CriticalPath {
  /** Heaviest dependency chain, from a root to a leaf. Ties: lowest ids. */
  readonly path: string[];
  readonly length: number;
}

export function criticalPath<N extends GraphNode>(
  nodes: readonly N[],
  weight: Weight<N> = sizeWeight as Weight<N>,
): CriticalPath {
  const index = indexGraph(nodes);
  const remaining = longestRemainingPath(nodes, weight);
  const pickMax = (ids: readonly string[]): string | undefined => {
    let best: string | undefined;
    for (const id of ids) {
      if (best === undefined || (remaining.get(id) ?? 0) > (remaining.get(best) ?? 0)) best = id;
    }
    return best;
  };
  const roots = index.ids.filter((id) => (index.deps.get(id) ?? []).length === 0);
  const path: string[] = [];
  let current = pickMax(roots);
  const length = current === undefined ? 0 : (remaining.get(current) ?? 0);
  while (current !== undefined) {
    path.push(current);
    current = pickMax(index.dependents.get(current) ?? []);
  }
  return { path, length };
}
