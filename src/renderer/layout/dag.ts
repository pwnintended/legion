/** Small DAG helpers over plan nodes (`{id, dependsOn}`), shared by layout sync and the Pipeline view. */

export interface DagNode {
  id: string;
  dependsOn: readonly string[];
}

/** Node ids compare by number (T2 < T10), falling back to string order. */
export function compareNodeIds(a: string, b: string): number {
  const na = Number(a.replace(/^\D+/, ''));
  const nb = Number(b.replace(/^\D+/, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Kahn's algorithm with a sorted ready set: deterministic topological order, lowest id first.
 * Unknown dependencies are ignored; nodes on a cycle are appended at the end in id order.
 */
export function topoOrder(nodes: readonly DagNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = node.dependsOn.filter((d) => ids.has(d) && d !== node.id);
    indegree.set(node.id, deps.length);
    for (const dep of deps) children.set(dep, [...(children.get(dep) ?? []), node.id]);
  }
  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareNodeIds);
    const id = ready.shift() as string;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  if (order.length < nodes.length) {
    const seen = new Set(order);
    order.push(
      ...nodes
        .map((n) => n.id)
        .filter((id) => !seen.has(id))
        .sort(compareNodeIds),
    );
  }
  return order;
}

/** Depth = length of the longest dependency chain above a node (roots are 0). */
export function depths(nodes: readonly DagNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, number>();
  for (const id of topoOrder(nodes)) {
    const node = byId.get(id);
    let depth = 0;
    for (const dep of node?.dependsOn ?? []) {
      const d = result.get(dep);
      if (d !== undefined) depth = Math.max(depth, d + 1);
    }
    result.set(id, depth);
  }
  return result;
}

/**
 * The longest path through the DAG (by node count, ties broken by lowest ids), as an ordered list of ids.
 * `weight` lets callers ignore finished nodes (weight 0) to get the remaining critical path.
 */
export function criticalPath(nodes: readonly DagNode[], weight: (id: string) => number = () => 1): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const best = new Map<string, { total: number; prev: string | null }>();
  for (const id of topoOrder(nodes)) {
    const node = byId.get(id);
    let prev: string | null = null;
    let total = 0;
    for (const dep of [...(node?.dependsOn ?? [])].sort(compareNodeIds)) {
      const entry = best.get(dep);
      if (entry && entry.total > total) {
        total = entry.total;
        prev = dep;
      }
    }
    best.set(id, { total: total + weight(id), prev });
  }
  let end: string | null = null;
  let max = 0;
  // `best` iterates in topological order, so ties go to the earliest end node.
  for (const [id, entry] of best) {
    if (entry.total > max) {
      max = entry.total;
      end = id;
    }
  }
  const path: string[] = [];
  while (end) {
    path.unshift(end);
    end = best.get(end)?.prev ?? null;
  }
  return max > 0 ? path : [];
}
