/**
 * Plan validation & annotation (architecture §8 step 4). Pure: takes the planner's (or the user's) nodes,
 * returns errors, warnings, structured annotations and the DAG with serializing edges added.
 *
 * Re-validating an already validated DAG is idempotent: auto edges are recognised from the
 * `serializing_edge` annotations they left behind, and overlaps the user accepted (by undoing an auto
 * edge with `undoAutoEdge`) are remembered as `note` annotations tagged `[overlap_accepted]`.
 */
import type { EngineKind, PlanAnnotation, PlanDag, TaskNode, Touch } from '@shared/domain';
import { NodeIdSchema } from '@shared/ids';
import type { EnabledEngines } from './engines';
import { type EstimateOptions, estimatePlan, type PlanEstimate } from './estimate';
import { globProblems, globsOverlap, isLiteralGlob, normalizeGlob } from './glob';
import { compareNodeIds, depthLayers, type Edge, findCycle, layeredOrder, reachability, redundantEdges } from './graph';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type IssueCode =
  | 'no_nodes'
  | 'invalid_id'
  | 'duplicate_id'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'duplicate_dependency'
  | 'cycle'
  | 'no_acceptance_criteria'
  | 'invalid_acceptance_criterion'
  | 'no_verify_command'
  | 'invalid_touch'
  | 'touch_warning'
  | 'no_write_touches'
  | 'redundant_dependency'
  | 'integration_not_last'
  | 'engine_disabled'
  | 'stale_auto_edge';

export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly code: IssueCode;
  readonly message: string;
  readonly nodeIds: readonly string[];
}

/** A pair of write globs (one per node) that can match the same path. */
export interface GlobOverlap {
  /** Glob of the `from` node (or the first node of the pair). */
  readonly a: string;
  /** Glob of the `to` node (or the second node of the pair). */
  readonly b: string;
}

export type DagAnnotation =
  | {
      /** Serializing edge added because two unordered nodes can write the same paths: `to` now depends on `from`. */
      readonly kind: 'auto_edge';
      readonly from: string;
      readonly to: string;
      readonly reason: string;
      /** Distinct globs involved, for display. */
      readonly paths: readonly string[];
      readonly overlaps: readonly GlobOverlap[];
    }
  | {
      /** The user undid the auto edge; the two nodes may run in parallel despite overlapping writes. */
      readonly kind: 'overlap_accepted';
      readonly nodeIds: readonly [string, string];
      readonly reason: string;
      readonly paths: readonly string[];
    }
  | {
      /** Several nodes write the same hot file (lockfile, barrel, route registry, schema...). */
      readonly kind: 'hot_file';
      readonly nodeIds: readonly string[];
      readonly paths: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: 'large_node'; readonly nodeId: string; readonly reason: string }
  | { readonly kind: 'high_risk'; readonly nodeId: string; readonly reason: string }
  | {
      /** A write touch matches the repo's `legion.json` `highRiskGlobs`. */
      readonly kind: 'high_risk_glob';
      readonly nodeId: string;
      readonly paths: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'cost_estimate';
      readonly reason: string;
      readonly totalCostUsd: number;
      readonly wallClockMinutes: number;
    };

export interface PlanDagInput {
  readonly nodes: readonly TaskNode[];
  readonly annotations?: readonly PlanAnnotation[] | null;
}

export interface ValidateOptions {
  /** Repo `legion.json` `highRiskGlobs`. */
  readonly highRiskGlobs?: readonly string[] | null;
  /** Extra node pairs whose overlap is accepted (besides `[overlap_accepted]` annotations). */
  readonly acceptedOverlaps?: ReadonlyArray<readonly [string, string]>;
  /** Warn when the coder engine (the coder role in settings) is disabled: every node would run on it. */
  readonly enabled?: EnabledEngines;
  readonly coderEngine?: EngineKind;
  /** Estimate options; `false` skips the estimate. */
  readonly estimate?: EstimateOptions | false;
}

export interface ValidationResult {
  /** No errors: the plan can be approved. */
  readonly ok: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly annotations: readonly DagAnnotation[];
  /**
   * The DAG to persist: deduplicated deps plus auto edges, and `annotations` encoded as `PlanAnnotation`s.
   * When there are structural errors (ids, deps, cycle) the nodes are returned unchanged.
   */
  readonly dag: PlanDag;
  readonly autoEdges: readonly Edge[];
  /** Depth layers for the Pipeline layout; null when the graph is invalid. */
  readonly layers: readonly (readonly string[])[] | null;
  readonly estimate: PlanEstimate | null;
}

/**
 * Hot files: shared registries that parallel tasks love to edit. Matched against write touches whose last
 * segment is literal (so `src/**` does not count, `src/**\/index.ts` and `pnpm-lock.yaml` do).
 */
export const HOT_FILE_GLOBS: readonly string[] = [
  // manifests & lockfiles
  '**/package.json',
  '**/{pnpm-lock.yaml,package-lock.json,yarn.lock,bun.lock,bun.lockb,npm-shrinkwrap.json}',
  '**/{Cargo.toml,Cargo.lock,go.mod,go.sum,Gemfile,Gemfile.lock,composer.json,composer.lock}',
  '**/{pyproject.toml,poetry.lock,uv.lock,Pipfile,Pipfile.lock,requirements*.txt}',
  // barrels & module registries
  '**/{index,mod,main}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  '**/{__init__.py,mod.rs,lib.rs}',
  // routes
  '**/{routes,router,routing,urls}.{ts,tsx,js,jsx,py,rb,go}',
  '**/routes/index.*',
  '**/config/routes.rb',
  // schemas & config
  '**/{schema,schemas}.{ts,js,graphql,gql,sql,json,prisma}',
  '**/*.prisma',
  '**/{tsconfig,tsconfig.*,jsconfig}.json',
  '**/{vite,vitest,webpack,rollup,electron.vite,next,nuxt,tailwind,eslint,jest}.config.*',
  '**/{biome.json,.eslintrc,.eslintrc.*,.prettierrc,.prettierrc.*}',
  '**/{Makefile,Dockerfile,docker-compose.yml,docker-compose.yaml}',
  '**/.github/workflows/*',
];

const WRITE_MODES = new Set<Touch['mode']>(['create', 'modify']);
const TAG_RE = /^\[([a-z_]+)\] ?/;

// ---------------------------------------------------------------------------------------------
// Annotation encoding (PlanAnnotation is the persisted shape in @shared/domain)
// ---------------------------------------------------------------------------------------------

/** Encode structured annotations into the persisted `PlanAnnotation` shape. */
export function toPlanAnnotations(annotations: readonly DagAnnotation[]): PlanAnnotation[] {
  return annotations.map(toPlanAnnotation);
}

function toPlanAnnotation(a: DagAnnotation): PlanAnnotation {
  switch (a.kind) {
    case 'auto_edge':
      return { kind: 'serializing_edge', nodeIds: [a.from, a.to], message: a.reason };
    case 'large_node':
      return { kind: 'large_node', nodeIds: [a.nodeId], message: a.reason };
    case 'cost_estimate':
      return { kind: 'cost_estimate', nodeIds: [], message: a.reason };
    case 'overlap_accepted':
    case 'hot_file':
      return { kind: 'note', nodeIds: [...a.nodeIds], message: `[${a.kind}] ${a.reason}` };
    case 'high_risk':
    case 'high_risk_glob':
      return { kind: 'note', nodeIds: [a.nodeId], message: `[${a.kind}] ${a.reason}` };
  }
}

/** The tag of a `note` annotation produced by `toPlanAnnotations` (`hot_file`, ...), else null. */
export function noteTag(annotation: PlanAnnotation): string | null {
  return annotation.kind === 'note' ? (TAG_RE.exec(annotation.message)?.[1] ?? null) : null;
}

function pairKey(a: string, b: string): string {
  return compareNodeIds(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Undo an auto edge: remove the dependency and its annotation, and record the overlap as accepted so the
 * next validation does not add it again. Re-validate afterwards.
 */
export function undoAutoEdge(dag: PlanDag, from: string, to: string): PlanDag {
  const isEdge = (a: PlanAnnotation) => a.kind === 'serializing_edge' && a.nodeIds[0] === from && a.nodeIds[1] === to;
  const annotation = dag.annotations.find(isEdge);
  if (!annotation) return dag;
  return {
    nodes: dag.nodes.map((n) => (n.id === to ? { ...n, dependsOn: n.dependsOn.filter((d) => d !== from) } : n)),
    annotations: [
      ...dag.annotations.filter((a) => !isEdge(a)),
      {
        kind: 'note',
        nodeIds: [from, to],
        message: `[overlap_accepted] ${from} and ${to} may run in parallel although their writes overlap (auto edge undone).`,
      },
    ],
  };
}

/** Forget an accepted overlap so the next validation serializes the pair again. */
export function restoreAutoEdge(dag: PlanDag, a: string, b: string): PlanDag {
  const key = pairKey(a, b);
  return {
    nodes: dag.nodes,
    annotations: dag.annotations.filter(
      (x) => !(noteTag(x) === 'overlap_accepted' && pairKey(x.nodeIds[0] ?? '', x.nodeIds[1] ?? '') === key),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function writeGlobs(node: Pick<TaskNode, 'touches'>): string[] {
  return [...new Set(node.touches.filter((t) => WRITE_MODES.has(t.mode)).map((t) => normalizeGlob(t.glob)))];
}

/** Pairs of write globs of two nodes that can match the same path. */
export function writeOverlaps(a: Pick<TaskNode, 'touches'>, b: Pick<TaskNode, 'touches'>): GlobOverlap[] {
  const out: GlobOverlap[] = [];
  for (const ga of writeGlobs(a)) for (const gb of writeGlobs(b)) if (globsOverlap(ga, gb)) out.push({ a: ga, b: gb });
  return out;
}

/** Write globs of the node that overlap the repo's high-risk globs. */
export function highRiskGlobHits(node: Pick<TaskNode, 'touches'>, highRiskGlobs: readonly string[]): string[] {
  return writeGlobs(node).filter((g) => highRiskGlobs.some((h) => globsOverlap(g, h)));
}

function isHotTouch(glob: string): boolean {
  const last = glob.split('/').at(-1) ?? '';
  if (!isLiteralGlob(last) || last === '') return false;
  return HOT_FILE_GLOBS.some((hot) => globsOverlap(glob, hot, false));
}

function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function describeOverlaps(overlaps: readonly GlobOverlap[], from: string, to: string): string {
  const shown = overlaps
    .slice(0, 3)
    .map((o) => (o.a === o.b ? `\`${o.a}\`` : `\`${o.a}\` (${from}) ∩ \`${o.b}\` (${to})`));
  const more = overlaps.length > 3 ? ` and ${overlaps.length - 3} more` : '';
  return `${shown.join(', ')}${more}`;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export function validatePlan(input: PlanDagInput, options: ValidateOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const issue = (severity: ValidationIssue['severity'], code: IssueCode, nodeIds: string[], message: string) =>
    issues.push({ severity, code, nodeIds, message });
  const nodes = input.nodes;
  const priorAnnotations = input.annotations ?? [];
  let structural = false;

  if (nodes.length === 0) {
    issue('error', 'no_nodes', [], 'The plan has no tasks.');
    structural = true;
  }

  if (nodes.length > 0 && options.enabled && options.coderEngine && options.coderEngine !== 'fake') {
    if (!options.enabled[options.coderEngine]) {
      const ids = nodes.map((n) => n.id);
      issue(
        'warning',
        'engine_disabled',
        ids,
        `Every task runs on ${options.coderEngine} (the coder setting), which is disabled.`,
      );
    }
  }

  const seen = new Set<string>();
  for (const node of nodes) {
    if (!NodeIdSchema.safeParse(node.id).success) {
      issue('error', 'invalid_id', [node.id], `Task id "${node.id}" must look like T1, T2, ...`);
      structural = true;
    }
    if (seen.has(node.id)) {
      issue('error', 'duplicate_id', [node.id], `Task id ${node.id} is used more than once.`);
      structural = true;
    }
    seen.add(node.id);
  }

  for (const node of nodes) {
    const deps = new Set<string>();
    for (const dep of node.dependsOn) {
      if (dep === node.id) {
        issue('error', 'self_dependency', [node.id], `${node.id} depends on itself.`);
        structural = true;
      } else if (!seen.has(dep)) {
        issue('error', 'unknown_dependency', [node.id], `${node.id} depends on unknown task ${dep}.`);
        structural = true;
      } else if (deps.has(dep)) {
        issue('warning', 'duplicate_dependency', [node.id], `${node.id} lists ${dep} twice.`);
      }
      deps.add(dep);
    }

    if (node.acceptanceCriteria.length === 0) {
      issue('error', 'no_acceptance_criteria', [node.id], `${node.id} has no acceptance criteria.`);
    }
    const criterionIds = new Set<string>();
    for (const c of node.acceptanceCriteria) {
      if (criterionIds.has(c.id)) {
        issue('error', 'invalid_acceptance_criterion', [node.id], `${node.id}: criterion id ${c.id} is duplicated.`);
      }
      if (c.id.trim() === '' || c.text.trim() === '') {
        issue('error', 'invalid_acceptance_criterion', [node.id], `${node.id}: criterion ${c.id || '?'} is empty.`);
      }
      criterionIds.add(c.id);
    }

    if (!node.verify.commands.some((c) => c.trim() !== '')) {
      issue('error', 'no_verify_command', [node.id], `${node.id} has no verify command.`);
    }

    for (const touch of node.touches) {
      for (const p of globProblems(touch.glob)) {
        issue(
          p.severity,
          p.severity === 'error' ? 'invalid_touch' : 'touch_warning',
          [node.id],
          `${node.id}: \`${touch.glob}\` ${p.message}.`,
        );
      }
    }
    if (writeGlobs(node).length === 0) {
      issue(
        'warning',
        'no_write_touches',
        [node.id],
        `${node.id} declares no create/modify touches; scope checks cannot work.`,
      );
    }
  }

  if (!structural) {
    const cycle = findCycle(nodes);
    if (cycle) {
      issue('error', 'cycle', distinct(cycle), `Dependency cycle: ${cycle.join(' → ')}.`);
      structural = true;
    }
  }

  const finish = (dag: PlanDag, annotations: DagAnnotation[], autoEdges: Edge[], estimate: PlanEstimate | null) => {
    const errors = issues.filter((i) => i.severity === 'error');
    return {
      ok: errors.length === 0,
      errors,
      warnings: issues.filter((i) => i.severity === 'warning'),
      annotations,
      dag,
      autoEdges,
      layers: structural ? null : depthLayers(dag.nodes),
      estimate,
    } satisfies ValidationResult;
  };

  if (structural) return finish({ nodes: [...nodes], annotations: [...priorAnnotations] }, [], [], null);

  // ---- graph phase: the graph is a valid DAG from here on ------------------------------------
  const working: TaskNode[] = nodes.map((n) => ({ ...n, dependsOn: distinct(n.dependsOn) }));
  const byId = new Map(working.map((n) => [n.id, n]));
  const annotations: DagAnnotation[] = [];

  for (const edge of redundantEdges(working)) {
    issue(
      'warning',
      'redundant_dependency',
      [edge.to],
      `${edge.to} → ${edge.from} is implied by another dependency path and can be removed.`,
    );
  }
  for (const node of working) {
    if (node.kind !== 'integration') continue;
    const dependents = working.filter((n) => n.dependsOn.includes(node.id)).map((n) => n.id);
    if (dependents.length > 0) {
      issue(
        'warning',
        'integration_not_last',
        [node.id, ...dependents],
        `Integration task ${node.id} has dependents (${dependents.join(', ')}); integration work should come last.`,
      );
    }
  }

  // Previously added auto edges that still exist, and accepted overlaps.
  const accepted = new Set((options.acceptedOverlaps ?? []).map(([a, b]) => pairKey(a, b)));
  const carried: Edge[] = [];
  for (const a of priorAnnotations) {
    const [x, y] = a.nodeIds;
    if (x === undefined || y === undefined) continue;
    if (noteTag(a) === 'overlap_accepted') accepted.add(pairKey(x, y));
    if (a.kind === 'serializing_edge' && byId.get(y)?.dependsOn.includes(x)) carried.push({ from: x, to: y });
  }
  for (const edge of carried) {
    const overlaps = writeOverlaps(byId.get(edge.from) as TaskNode, byId.get(edge.to) as TaskNode);
    if (overlaps.length === 0) {
      issue(
        'warning',
        'stale_auto_edge',
        [edge.from, edge.to],
        `The serializing edge ${edge.from} → ${edge.to} was added for overlapping writes that no longer overlap; it can be undone.`,
      );
    }
    annotations.push(autoEdgeAnnotation(edge.from, edge.to, overlaps));
  }

  // Overlap detection over unordered pairs, in a fixed linear extension (depth, then id). Every added
  // edge goes from an earlier to a later node in that order, so the result stays acyclic.
  const order = layeredOrder(working);
  const reach = reachability(working);
  // For each node, look at earlier nodes nearest-first so a group of mutually overlapping nodes becomes a
  // chain rather than a clique. Edges only point forward in `order`, so an added edge never becomes implied
  // by a later one: the auto edges are always transitively irredundant.
  const autoEdges: Edge[] = [];
  for (let j = 1; j < order.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const from = order[i] as string;
      const to = order[j] as string;
      if (reach.get(from)?.has(to) || reach.get(to)?.has(from)) continue;
      const overlaps = writeOverlaps(byId.get(from) as TaskNode, byId.get(to) as TaskNode);
      if (overlaps.length === 0) continue;
      if (accepted.has(pairKey(from, to))) {
        annotations.push({
          kind: 'overlap_accepted',
          nodeIds: [from, to],
          paths: distinct(overlaps.flatMap((o) => [o.a, o.b])),
          reason: `${from} and ${to} may run in parallel although they can write the same paths: ${describeOverlaps(overlaps, from, to)}.`,
        });
        continue;
      }
      const target = byId.get(to) as TaskNode;
      byId.set(to, { ...target, dependsOn: [...target.dependsOn, from] });
      autoEdges.push({ from, to });
      annotations.push(autoEdgeAnnotation(from, to, overlaps));
      const gained = new Set([to, ...(reach.get(to) ?? [])]);
      for (const [x, reached] of reach) {
        if (x === from || reached.has(from)) for (const g of gained) reached.add(g);
      }
    }
  }
  const finalNodes = working.map((n) => byId.get(n.id) as TaskNode);

  // Hot files written by more than one node (clustered by overlap).
  const hot: { nodeId: string; glob: string }[] = [];
  for (const node of finalNodes) {
    for (const glob of writeGlobs(node)) if (isHotTouch(glob)) hot.push({ nodeId: node.id, glob });
  }
  const parent = hot.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] as number;
    return i;
  };
  for (let i = 0; i < hot.length; i++) {
    for (let j = i + 1; j < hot.length; j++) {
      const a = hot[i] as (typeof hot)[number];
      const b = hot[j] as (typeof hot)[number];
      if (globsOverlap(a.glob, b.glob)) parent[root(j)] = root(i);
    }
  }
  const clusters = new Map<number, typeof hot>();
  hot.forEach((h, i) => {
    const r = root(i);
    clusters.set(r, [...(clusters.get(r) ?? []), h]);
  });
  for (const members of clusters.values()) {
    const ids = distinct(members.map((m) => m.nodeId)).sort(compareNodeIds);
    if (ids.length < 2) continue;
    const paths = distinct(members.map((m) => m.glob)).sort();
    annotations.push({
      kind: 'hot_file',
      nodeIds: ids,
      paths,
      reason: `Hot file ${paths.map((p) => `\`${p}\``).join(', ')} is written by ${ids.join(', ')}; prefer a single owner task.`,
    });
  }

  const highRiskGlobs = options.highRiskGlobs ?? [];
  for (const node of finalNodes) {
    if (node.size === 'L') {
      annotations.push({
        kind: 'large_node',
        nodeId: node.id,
        reason: `${node.id} is size L; consider splitting it into tasks of at most ~400 changed lines.`,
      });
    }
    if (node.risk === 'high') {
      annotations.push({
        kind: 'high_risk',
        nodeId: node.id,
        reason: `${node.id} is high risk; it waits for human approval before merging.`,
      });
    }
    const hits = highRiskGlobHits(node, highRiskGlobs);
    if (hits.length > 0) {
      annotations.push({
        kind: 'high_risk_glob',
        nodeId: node.id,
        paths: hits,
        reason: `${node.id} writes high-risk paths (${hits.map((h) => `\`${h}\``).join(', ')}); it waits for human approval before merging.`,
      });
    }
  }

  let estimate: PlanEstimate | null = null;
  if (options.estimate !== false) {
    estimate = estimatePlan(finalNodes, options.estimate ?? {});
    annotations.push({
      kind: 'cost_estimate',
      totalCostUsd: estimate.totalCostUsd,
      wallClockMinutes: estimate.wallClockMinutes,
      reason: `Estimated ~$${estimate.totalCostUsd.toFixed(2)} and ~${Math.round(estimate.wallClockMinutes)} min wall clock at concurrency ${estimate.concurrency} (critical path ${finalNodes.length > 0 ? estimate.criticalPath.join(' → ') : '-'}).`,
    });
  }

  return finish({ nodes: finalNodes, annotations: toPlanAnnotations(annotations) }, annotations, autoEdges, estimate);
}

function autoEdgeAnnotation(from: string, to: string, overlaps: readonly GlobOverlap[]): DagAnnotation {
  const reason =
    overlaps.length > 0
      ? `${to} now runs after ${from}: both can write ${describeOverlaps(overlaps, from, to)}.`
      : `${to} runs after ${from} (serializing edge; the writes no longer overlap).`;
  return {
    kind: 'auto_edge',
    from,
    to,
    reason,
    paths: distinct(overlaps.flatMap((o) => [o.a, o.b])),
    overlaps,
  };
}
