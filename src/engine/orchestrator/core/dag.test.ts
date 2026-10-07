import { PlanDagSchema, type TaskNode } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { type DagAnnotation, noteTag, restoreAutoEdge, toPlanAnnotations, undoAutoEdge, validatePlan } from './dag';
import { findCycle } from './graph';
import { makeNode } from './testing';

const codes = (issues: readonly { code: string }[]) => issues.map((i) => i.code);
const kinds = (annotations: readonly DagAnnotation[]) => annotations.map((a) => a.kind);
const depsOf = (nodes: readonly TaskNode[], id: string) => nodes.find((n) => n.id === id)?.dependsOn;

const wellFormed = [
  makeNode('T1', [], { kind: 'contracts', size: 'S', touches: [{ glob: 'src/types.ts', mode: 'create' }] }),
  makeNode('T2', ['T1'], { writes: ['src/a/**'] }),
  makeNode('T3', ['T1'], { writes: ['src/b/**'] }),
  makeNode('T4', ['T2', 'T3'], { kind: 'integration', size: 'S', writes: ['src/main.ts'] }),
];

describe('validatePlan: well-formed plans', () => {
  it('accepts a contracts → fan-out → integration DAG without changes', () => {
    const result = validatePlan({ nodes: wellFormed }, { estimate: false });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.autoEdges).toEqual([]);
    expect(result.dag.nodes.map((n) => n.dependsOn)).toEqual([[], ['T1'], ['T1'], ['T2', 'T3']]);
    expect(result.layers).toEqual([['T1'], ['T2', 'T3'], ['T4']]);
    expect(PlanDagSchema.safeParse(result.dag).success).toBe(true);
  });

  it('adds a cost estimate annotation by default', () => {
    const result = validatePlan({ nodes: wellFormed });
    expect(result.estimate?.nodes).toHaveLength(4);
    const estimate = result.annotations.find((a) => a.kind === 'cost_estimate');
    expect(estimate?.reason).toMatch(/^Estimated ~\$\d+\.\d\d and ~\d+ min wall clock at concurrency 3/);
    expect(result.dag.annotations.filter((a) => a.kind === 'cost_estimate')).toHaveLength(1);
  });
});

describe('validatePlan: structural errors', () => {
  it('reports ids, deps and self-deps, and leaves the DAG untouched', () => {
    const nodes = [
      makeNode('T1', ['T1']),
      makeNode('T1'),
      makeNode('task-3', ['T9']),
      makeNode('T4', ['T1', 'T1'], { writes: ['src/a.ts'] }),
    ];
    const result = validatePlan({ nodes });
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(['duplicate_id', 'invalid_id', 'self_dependency', 'unknown_dependency']);
    expect(codes(result.warnings)).toContain('duplicate_dependency');
    expect(result.dag.nodes).toEqual(nodes);
    expect(result.layers).toBeNull();
    expect(result.estimate).toBeNull();
  });

  it('reports the cycle', () => {
    const nodes = [makeNode('T1', ['T3']), makeNode('T2', ['T1']), makeNode('T3', ['T2'])];
    const result = validatePlan({ nodes });
    expect(codes(result.errors)).toEqual(['cycle']);
    expect(result.errors[0]?.message).toBe('Dependency cycle: T1 → T2 → T3 → T1.');
    expect(result.errors[0]?.nodeIds).toEqual(['T1', 'T2', 'T3']);
  });

  it('rejects empty plans', () => {
    expect(codes(validatePlan({ nodes: [] }).errors)).toEqual(['no_nodes']);
  });
});

describe('validatePlan: per-node checks', () => {
  it('requires acceptance criteria and verify commands', () => {
    const nodes = [
      makeNode('T1', [], { acceptanceCriteria: [] }),
      makeNode('T2', [], {
        acceptanceCriteria: [
          { id: 'AC1', text: 'a' },
          { id: 'AC1', text: ' ' },
        ],
      }),
      makeNode('T3', [], { verify: { commands: ['  '] } }),
    ];
    const result = validatePlan({ nodes }, { estimate: false });
    expect(codes(result.errors)).toEqual([
      'no_acceptance_criteria',
      'invalid_acceptance_criterion',
      'invalid_acceptance_criterion',
      'no_verify_command',
    ]);
    // Per-node errors do not block the graph analysis.
    expect(result.layers).toEqual([['T1', 'T2', 'T3']]);
  });

  it('checks touches', () => {
    const nodes = [
      makeNode('T1', [], { writes: ['../outside.ts', '/abs/path'] }),
      makeNode('T2', [], { touches: [{ glob: 'docs/**', mode: 'read' }] }),
      makeNode('T3', [], { writes: ['**'] }),
    ];
    const result = validatePlan({ nodes }, { estimate: false });
    expect(codes(result.errors)).toEqual(['invalid_touch', 'invalid_touch']);
    expect(codes(result.warnings)).toEqual(['no_write_touches', 'touch_warning']);
  });

  it('warns about a disabled coder engine, redundant deps and integration tasks with dependents', () => {
    const nodes = [makeNode('T1', [], { kind: 'integration' }), makeNode('T2', ['T1']), makeNode('T3', ['T1', 'T2'])];
    const result = validatePlan(
      { nodes },
      { enabled: { claude: true, codex: false }, coderEngine: 'codex', estimate: false },
    );
    expect(codes(result.warnings)).toEqual(['engine_disabled', 'redundant_dependency', 'integration_not_last']);
    expect(result.ok).toBe(true);
  });
});

describe('validatePlan: overlap detection', () => {
  it('serializes unordered nodes with overlapping writes and records why', () => {
    const nodes = [
      makeNode('T1', [], { writes: ['src/types.ts'] }),
      makeNode('T2', ['T1'], { writes: ['src/api/**'] }),
      makeNode('T3', ['T1'], { writes: ['src/api/routes.ts', 'src/ui/**'] }),
    ];
    const result = validatePlan({ nodes }, { estimate: false });
    expect(result.autoEdges).toEqual([{ from: 'T2', to: 'T3' }]);
    expect(depsOf(result.dag.nodes, 'T3')).toEqual(['T1', 'T2']);
    const edge = result.annotations.find((a) => a.kind === 'auto_edge');
    expect(edge).toEqual({
      kind: 'auto_edge',
      from: 'T2',
      to: 'T3',
      reason: 'T3 now runs after T2: both can write `src/api/**` (T2) ∩ `src/api/routes.ts` (T3).',
      paths: ['src/api/**', 'src/api/routes.ts'],
      overlaps: [{ a: 'src/api/**', b: 'src/api/routes.ts' }],
    });
    expect(result.dag.annotations).toContainEqual({
      kind: 'serializing_edge',
      nodeIds: ['T2', 'T3'],
      message: edge?.reason,
    });
    expect(result.layers).toEqual([['T1'], ['T2'], ['T3']]);
  });

  it('does not add edges for pairs already ordered by a path', () => {
    const nodes = [
      makeNode('T1', [], { writes: ['src/x.ts'] }),
      makeNode('T2', ['T1']),
      makeNode('T3', ['T2'], { writes: ['src/x.ts'] }),
    ];
    expect(validatePlan({ nodes }, { estimate: false }).autoEdges).toEqual([]);
  });

  it('chains a group of mutually overlapping nodes without redundant edges', () => {
    const nodes = ['T1', 'T2', 'T3', 'T4'].map((id) => makeNode(id, [], { writes: ['src/shared.ts'] }));
    const result = validatePlan({ nodes }, { estimate: false });
    expect(result.autoEdges).toEqual([
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T3' },
      { from: 'T3', to: 'T4' },
    ]);
    expect(findCycle(result.dag.nodes)).toBeNull();
  });

  it('orients edges by topological rank first, then id', () => {
    const nodes = [
      makeNode('T1'),
      makeNode('T2', ['T1'], { writes: ['src/x.ts'] }),
      makeNode('T3', [], { writes: ['src/x.ts'] }),
    ];
    expect(validatePlan({ nodes }, { estimate: false }).autoEdges).toEqual([{ from: 'T3', to: 'T2' }]);
  });

  it('is idempotent when re-validating its own output', () => {
    const nodes = [makeNode('T1', [], { writes: ['src/a/**'] }), makeNode('T2', [], { writes: ['src/a/b.ts'] })];
    const first = validatePlan({ nodes }, { estimate: false });
    const second = validatePlan(first.dag, { estimate: false });
    expect(second.autoEdges).toEqual([]);
    expect(second.dag).toEqual(first.dag);
    expect(second.annotations).toEqual(first.annotations);
    expect(second.warnings).toEqual([]);
  });

  it('flags carried auto edges whose overlap disappeared', () => {
    const nodes = [makeNode('T1', [], { writes: ['src/a/**'] }), makeNode('T2', [], { writes: ['src/a/b.ts'] })];
    const first = validatePlan({ nodes }, { estimate: false });
    const edited = {
      ...first.dag,
      nodes: first.dag.nodes.map((n) =>
        n.id === 'T2' ? { ...n, touches: [{ glob: 'lib/b.ts', mode: 'modify' as const }] } : n,
      ),
    };
    const second = validatePlan(edited, { estimate: false });
    expect(codes(second.warnings)).toEqual(['stale_auto_edge']);
    expect(depsOf(second.dag.nodes, 'T2')).toEqual(['T1']);
  });

  it('lets the user undo and restore an auto edge', () => {
    const nodes = [makeNode('T1', [], { writes: ['src/a/**'] }), makeNode('T2', [], { writes: ['src/a/b.ts'] })];
    const first = validatePlan({ nodes }, { estimate: false });
    const undone = undoAutoEdge(first.dag, 'T1', 'T2');
    expect(depsOf(undone.nodes, 'T2')).toEqual([]);
    const second = validatePlan(undone, { estimate: false });
    expect(second.autoEdges).toEqual([]);
    expect(kinds(second.annotations)).toEqual(['overlap_accepted']);
    expect(second.dag.annotations.map(noteTag)).toEqual(['overlap_accepted']);
    expect(validatePlan(second.dag, { estimate: false }).autoEdges).toEqual([]);

    const restored = validatePlan(restoreAutoEdge(second.dag, 'T2', 'T1'), { estimate: false });
    expect(restored.autoEdges).toEqual([{ from: 'T1', to: 'T2' }]);
    expect(undoAutoEdge(first.dag, 'T2', 'T1')).toBe(first.dag);
  });

  it('honours accepted overlaps passed as options', () => {
    const nodes = [makeNode('T1', [], { writes: ['src/a/**'] }), makeNode('T2', [], { writes: ['src/a/b.ts'] })];
    const result = validatePlan({ nodes }, { acceptedOverlaps: [['T2', 'T1']], estimate: false });
    expect(result.autoEdges).toEqual([]);
  });
});

describe('validatePlan: flags', () => {
  it('flags hot files written by several nodes, ignoring broad globs', () => {
    const nodes = [
      makeNode('T1', [], { writes: ['package.json', 'src/a/**'] }),
      makeNode('T2', ['T1'], { writes: ['package.json', 'src/index.ts'] }),
      makeNode('T3', ['T1'], { writes: ['src/b/index.ts'] }),
      makeNode('T4', ['T1'], { writes: ['lib/**'] }),
    ];
    const hot = validatePlan({ nodes }, { estimate: false }).annotations.filter((a) => a.kind === 'hot_file');
    expect(hot).toEqual([
      {
        kind: 'hot_file',
        nodeIds: ['T1', 'T2'],
        paths: ['package.json'],
        reason: 'Hot file `package.json` is written by T1, T2; prefer a single owner task.',
      },
    ]);
  });

  it('flags large nodes, high-risk nodes and high-risk globs', () => {
    const nodes = [
      makeNode('T1', [], { size: 'L' }),
      makeNode('T2', [], { risk: 'high', writes: ['src/auth/**'] }),
      makeNode('T3', [], { writes: ['db/migrations/0002_users.sql'] }),
    ];
    const result = validatePlan({ nodes }, { highRiskGlobs: ['db/migrations/**'], estimate: false });
    expect(kinds(result.annotations)).toEqual(['large_node', 'high_risk', 'high_risk_glob']);
    expect(result.annotations[2]).toMatchObject({ nodeId: 'T3', paths: ['db/migrations/0002_users.sql'] });
    expect(result.dag.annotations.map((a) => [a.kind, a.nodeIds, noteTag(a)])).toEqual([
      ['large_node', ['T1'], null],
      ['note', ['T2'], 'high_risk'],
      ['note', ['T3'], 'high_risk_glob'],
    ]);
  });

  it('encodes every annotation kind', () => {
    const encoded = toPlanAnnotations([
      { kind: 'cost_estimate', reason: 'r', totalCostUsd: 1, wallClockMinutes: 2 },
      { kind: 'overlap_accepted', nodeIds: ['T1', 'T2'], reason: 'r', paths: [] },
    ]);
    expect(encoded).toEqual([
      { kind: 'cost_estimate', nodeIds: [], message: 'r' },
      { kind: 'note', nodeIds: ['T1', 'T2'], message: '[overlap_accepted] r' },
    ]);
  });
});
