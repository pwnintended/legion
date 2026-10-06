/**
 * Pure plan logic for the plan and DAG tiles: markdown sections, validation + estimate (the orchestrator's
 * own pure core, so the UI and the engine agree), and DAG edits (edges, nodes, overlaps).
 */
import { undoAutoEdge, type ValidationResult, validatePlan, writeOverlaps } from '@engine/orchestrator/core/dag';
import { compareNodeIds } from '@engine/orchestrator/core/graph';
import type { PlanAnnotation, PlanDag, Settings, TaskNode } from '@shared/domain';

// ---------------------------------------------------------------------------------------------
// Markdown sections
// ---------------------------------------------------------------------------------------------

export interface MdSection {
  heading: string;
  body: string;
}

/** Split markdown at `##` headings: the preamble (title + intro) and the level-2 sections in order. */
export function splitSections(markdown: string): { preamble: string; sections: MdSection[] } {
  const lines = markdown.split('\n');
  const sections: MdSection[] = [];
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (match) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
      current = { heading: match[1] as string, lines: [] };
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
  return { preamble: preamble.join('\n').trim(), sections };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();

export function findSection(markdown: string, names: readonly string[]): MdSection | null {
  const wanted = names.map(norm);
  return splitSections(markdown).sections.find((s) => wanted.includes(norm(s.heading))) ?? null;
}

/** The markdown without the named `##` sections. */
export function withoutSections(markdown: string, names: readonly string[]): string {
  const wanted = names.map(norm);
  const { preamble, sections } = splitSections(markdown);
  return [
    preamble,
    ...sections.filter((s) => !wanted.includes(norm(s.heading))).map((s) => `## ${s.heading}\n\n${s.body}`),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** List items (`-`, `*`, `1.`) of a section body; non-list text becomes one item per paragraph. */
export function listItems(body: string): string[] {
  const items: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) items.push(m[1] as string);
    else if (items.length > 0 && raw.startsWith('  ')) items[items.length - 1] += ` ${line}`;
    else items.push(line);
  }
  return items;
}

/** Commands of a "Verification" section: fenced code lines, inline code spans, or list items. */
export function verificationCommands(body: string): string[] {
  const fenced = /```[a-z]*\n([\s\S]*?)```/.exec(body);
  if (fenced)
    return (fenced[1] as string)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  return listItems(body).map((item) => {
    const code = /`([^`]+)`/.exec(item);
    return code ? (code[1] as string) : item;
  });
}

export const PLAN_SIDE_SECTIONS = ['Assumptions', 'Verification', 'Global verification'] as const;

// ---------------------------------------------------------------------------------------------
// Validation & estimate
// ---------------------------------------------------------------------------------------------

export interface Overlap {
  from: string;
  to: string;
  paths: string[];
  reason: string;
  /** A common ancestor that could own the shared files instead (so the edge can go), or null. */
  giveTo: string | null;
}

export interface PlanAnalysis {
  validation: ValidationResult;
  /** The DAG to display: validated (auto edges added) when the structure is sound, else the input. */
  dag: PlanDag;
  overlaps: Overlap[];
  estimate: {
    tasks: number;
    maxParallel: number;
    costLow: number;
    costHigh: number;
    minutes: number;
    criticalPath: readonly string[];
  } | null;
}

function ancestorsOf(nodes: readonly TaskNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const next = stack.pop() as string;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return out;
}

/** Deepest common ancestor of two nodes (ties: lowest id), ignoring the edge between them. */
export function commonOwner(nodes: readonly TaskNode[], a: string, b: string): string | null {
  const withoutEdge = nodes.map((n) => (n.id === b ? { ...n, dependsOn: n.dependsOn.filter((d) => d !== a) } : n));
  const left = ancestorsOf(withoutEdge, a);
  const right = ancestorsOf(withoutEdge, b);
  const common = [...left].filter((id) => right.has(id) && id !== a && id !== b);
  if (common.length === 0) return null;
  const depth = (id: string) => ancestorsOf(withoutEdge, id).size;
  return common.sort((x, y) => depth(y) - depth(x) || compareNodeIds(x, y))[0] ?? null;
}

function maxParallel(schedule: readonly { start: number; end: number }[], cap: number): number {
  let best = 0;
  for (const s of schedule) {
    const at = s.start + 1e-6;
    best = Math.max(best, schedule.filter((o) => o.start <= at && o.end > at).length);
  }
  return Math.min(Math.max(best, schedule.length ? 1 : 0), cap);
}

/** Round a cost range to friendly numbers ($4–6, $0.80–1.20). */
export function costRange(usd: number): [number, number] {
  const low = usd * 0.8;
  const high = usd * 1.3;
  if (high < 3) return [Math.round(low * 10) / 10, Math.round(high * 10) / 10];
  return [Math.max(1, Math.floor(low)), Math.ceil(high)];
}

export function formatCostRange([low, high]: [number, number]): string {
  const f = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/0$/, ''));
  return low === high ? `$${f(low)}` : `$${f(low)}–${f(high)}`;
}

export function analyzePlan(dag: PlanDag, settings: Settings | null): PlanAnalysis {
  const validation = validatePlan(dag, {
    estimate: settings
      ? { concurrency: settings.concurrency, maxFixRounds: settings.limits.maxFixRounds }
      : { concurrency: { global: 3, perEngine: {} } },
  });
  const structural = validation.errors.some((e) =>
    ['no_nodes', 'invalid_id', 'duplicate_id', 'unknown_dependency', 'self_dependency', 'cycle'].includes(e.code),
  );
  const shown = structural ? dag : validation.dag;
  const overlaps: Overlap[] = [];
  for (const a of validation.annotations) {
    if (a.kind !== 'auto_edge') continue;
    overlaps.push({
      from: a.from,
      to: a.to,
      paths: [...a.paths],
      reason: a.reason,
      giveTo: commonOwner(shown.nodes, a.from, a.to),
    });
  }
  const est = validation.estimate;
  return {
    validation,
    dag: shown,
    overlaps,
    estimate: est
      ? {
          tasks: dag.nodes.length,
          maxParallel: maxParallel(est.schedule, est.concurrency),
          costLow: costRange(est.totalCostUsd)[0],
          costHigh: costRange(est.totalCostUsd)[1],
          minutes: Math.round(est.wallClockMinutes),
          criticalPath: est.criticalPath,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// DAG edits (all pure; the engine re-validates whatever is saved)
// ---------------------------------------------------------------------------------------------

const isEdgeAnnotation = (a: PlanAnnotation, from: string, to: string) =>
  a.kind === 'serializing_edge' && a.nodeIds[0] === from && a.nodeIds[1] === to;

export function isAutoEdge(dag: PlanDag, from: string, to: string): boolean {
  return dag.annotations.some((a) => isEdgeAnnotation(a, from, to));
}

/** `to` depends on `from` after the edit, unless that would create a cycle (returned as the path). */
export function addDependency(
  dag: PlanDag,
  from: string,
  to: string,
): { ok: true; dag: PlanDag } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: `${to} can't depend on itself.` };
  const target = dag.nodes.find((n) => n.id === to);
  if (!target || !dag.nodes.some((n) => n.id === from)) return { ok: false, reason: 'Unknown task.' };
  if (target.dependsOn.includes(from)) return { ok: false, reason: `${to} already depends on ${from}.` };
  if (ancestorsOf(dag.nodes, from).has(to))
    return { ok: false, reason: `${from} already waits on ${to}: ${to} → ${from} → ${to} would be a cycle.` };
  return {
    ok: true,
    dag: { ...dag, nodes: dag.nodes.map((n) => (n.id === to ? { ...n, dependsOn: [...n.dependsOn, from] } : n)) },
  };
}

/** Remove `to`'s dependency on `from`. Auto-added serializing edges are undone (the overlap is accepted). */
export function removeDependency(dag: PlanDag, from: string, to: string): PlanDag {
  if (isAutoEdge(dag, from, to)) return undoAutoEdge(dag, from, to);
  return {
    ...dag,
    nodes: dag.nodes.map((n) => (n.id === to ? { ...n, dependsOn: n.dependsOn.filter((d) => d !== from) } : n)),
  };
}

/**
 * Resolve an overlap by giving the shared files to `owner` (a common ancestor, or `from` itself): the two
 * nodes keep them as `read`, the owner gets `modify`, and the serializing edge goes away.
 */
export function giveOverlapTo(dag: PlanDag, from: string, to: string, owner: string): PlanDag {
  const a = dag.nodes.find((n) => n.id === from);
  const b = dag.nodes.find((n) => n.id === to);
  if (!a || !b) return dag;
  const overlaps = writeOverlaps(a, b);
  const shared = new Set(overlaps.flatMap((o) => [o.a, o.b]));
  const ownerGlobs = [...new Set(overlaps.map((o) => (o.a.length >= o.b.length ? o.a : o.b)))];
  const demote = (node: TaskNode): TaskNode => ({
    ...node,
    touches: node.touches.map((t) => (shared.has(t.glob) && t.mode !== 'read' ? { ...t, mode: 'read' as const } : t)),
  });
  const nodes = dag.nodes.map((n) => {
    if (n.id === to) return { ...demote(n), dependsOn: n.dependsOn.filter((d) => d !== from) };
    if (n.id === from && owner !== from) return demote(n);
    if (n.id === owner) {
      const have = new Set(n.touches.filter((t) => t.mode !== 'read').map((t) => t.glob));
      const added = ownerGlobs.filter((g) => !have.has(g)).map((glob) => ({ glob, mode: 'modify' as const }));
      return { ...n, touches: [...n.touches.filter((t) => !ownerGlobs.includes(t.glob)), ...added] };
    }
    return n;
  });
  return { nodes, annotations: dag.annotations.filter((x) => !isEdgeAnnotation(x, from, to)) };
}

export function nextNodeId(dag: PlanDag): string {
  const max = Math.max(0, ...dag.nodes.map((n) => Number(n.id.slice(1)) || 0));
  return `T${max + 1}`;
}

export function addNode(dag: PlanDag, partial: Partial<TaskNode> = {}): { dag: PlanDag; id: string } {
  const id = nextNodeId(dag);
  const node: TaskNode = {
    id,
    title: 'New task',
    goal: 'Describe what this task delivers.',
    kind: 'feature',
    dependsOn: [],
    acceptanceCriteria: [],
    touches: [],
    size: 'S',
    verify: { commands: [] },
    contextHints: { files: [], notes: '' },
    agent: { engine: 'claude', model: null, effort: null },
    risk: 'low',
    ...partial,
  };
  return { dag: { ...dag, nodes: [...dag.nodes, node] }, id };
}

export function removeNode(dag: PlanDag, id: string): PlanDag {
  return {
    nodes: dag.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => d !== id) })),
    annotations: dag.annotations.filter((a) => !a.nodeIds.includes(id)),
  };
}

export function updateNode(dag: PlanDag, id: string, patch: (node: TaskNode) => TaskNode): PlanDag {
  return { ...dag, nodes: dag.nodes.map((n) => (n.id === id ? patch(n) : n)) };
}

/** Other nodes whose write globs overlap this node's, with the shared globs. */
export function sharedWrites(dag: PlanDag, id: string): Map<string, string[]> {
  const node = dag.nodes.find((n) => n.id === id);
  const out = new Map<string, string[]>();
  if (!node) return out;
  for (const other of dag.nodes) {
    if (other.id === id) continue;
    for (const o of writeOverlaps(node, other)) out.set(o.a, [...(out.get(o.a) ?? []), other.id]);
  }
  return out;
}
