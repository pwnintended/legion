/** DAG tile geometry: dagre left→right layout and spatial keyboard navigation (pure). */
import dagre from '@dagrejs/dagre';

export const NODE_W = 158;
export const NODE_H = 72;

export interface LayoutNode {
  id: string;
  dependsOn: readonly string[];
}

export interface Point {
  x: number;
  y: number;
}

/** Top-left positions by node id, layered left→right by dependency depth. */
export function layoutDag(nodes: readonly LayoutNode[]): Map<string, Point> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 46, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const node of nodes)
    for (const dep of node.dependsOn) if (ids.has(dep) && dep !== node.id) g.setEdge(dep, node.id);
  try {
    dagre.layout(g);
  } catch {
    // A cycle in an unsaved edit: fall back to a grid so the graph stays visible.
    return new Map(nodes.map((n, i) => [n.id, { x: (i % 4) * (NODE_W + 64), y: Math.floor(i / 4) * (NODE_H + 26) }]));
  }
  const out = new Map<string, Point>();
  for (const node of nodes) {
    const p = g.node(node.id) as { x: number; y: number } | undefined;
    if (p) out.set(node.id, { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) });
  }
  return out;
}

export type Arrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/** The nearest node in a direction (favouring alignment), or null. */
export function neighbour(positions: ReadonlyMap<string, Point>, from: string, arrow: Arrow): string | null {
  const origin = positions.get(from);
  if (!origin) return null;
  let best: { id: string; score: number } | null = null;
  for (const [id, p] of positions) {
    if (id === from) continue;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const along = arrow === 'ArrowRight' ? dx : arrow === 'ArrowLeft' ? -dx : arrow === 'ArrowDown' ? dy : -dy;
    const across = arrow === 'ArrowRight' || arrow === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const score = along + across * 2.2;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}
