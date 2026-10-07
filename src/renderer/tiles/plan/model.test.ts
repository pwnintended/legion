import type { PlanDag, TaskNode } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import {
  addDependency,
  addNode,
  analyzePlan,
  commonOwner,
  costRange,
  findSection,
  formatCostRange,
  giveOverlapTo,
  isAutoEdge,
  listItems,
  removeDependency,
  removeNode,
  splitSections,
  verificationCommands,
  withoutSections,
} from './model';

function node(id: string, dependsOn: string[], writes: string[] = [], extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id,
    goal: `goal ${id}`,
    kind: 'feature',
    dependsOn,
    acceptanceCriteria: [{ id: 'AC1', text: 'works' }],
    touches: writes.map((glob) => ({ glob, mode: 'modify' as const })),
    size: 'S',
    verify: { commands: ['pnpm test'] },
    contextHints: { files: [], notes: '' },
    agent: { effort: null },
    risk: 'low',
    ...extra,
  };
}

const dag = (nodes: TaskNode[]): PlanDag => ({ nodes, annotations: [] });

describe('markdown sections', () => {
  const md =
    '# Title\n\nIntro.\n\n## Approach\n- a\n- b\n\n## Assumptions\n- one\n  continued\n- two\n\n## Verification\n```\npnpm test\npnpm lint\n```\n';

  it('splits the preamble and level-2 sections, ignoring headings in code fences', () => {
    const { preamble, sections } = splitSections(`${md}\n\`\`\`\n## not a heading\n\`\`\`\n`);
    expect(preamble).toBe('# Title\n\nIntro.');
    expect(sections.map((s) => s.heading)).toEqual(['Approach', 'Assumptions', 'Verification']);
  });

  it('finds sections by name and removes them', () => {
    expect(listItems(findSection(md, ['assumptions'])?.body ?? '')).toEqual(['one continued', 'two']);
    expect(verificationCommands(findSection(md, ['Verification'])?.body ?? '')).toEqual(['pnpm test', 'pnpm lint']);
    expect(withoutSections(md, ['Assumptions', 'Verification'])).toBe('# Title\n\nIntro.\n\n## Approach\n\n- a\n- b');
  });

  it('reads inline-code verification lists', () => {
    expect(verificationCommands('- `pnpm typecheck`\n- pnpm test')).toEqual(['pnpm typecheck', 'pnpm test']);
  });
});

describe('analyzePlan', () => {
  const overlapping = dag([
    node('T1', [], ['tools/**']),
    node('T2', ['T1'], ['web/a/**', 'web/i18n/index.ts']),
    node('T3', ['T1'], ['web/b/**', 'web/i18n/index.ts']),
  ]);

  it('adds a serializing edge for overlapping writes and offers the common ancestor as owner', () => {
    const analysis = analyzePlan(overlapping, null);
    expect(analysis.validation.ok).toBe(true);
    expect(analysis.overlaps).toEqual([
      expect.objectContaining({ from: 'T2', to: 'T3', paths: ['web/i18n/index.ts'], giveTo: 'T1' }),
    ]);
    expect(analysis.dag.nodes.find((n) => n.id === 'T3')?.dependsOn).toEqual(['T1', 'T2']);
    expect(analysis.estimate?.tasks).toBe(3);
    expect(analysis.estimate?.maxParallel).toBeGreaterThanOrEqual(1);
  });

  it('undoing the auto edge is remembered, so re-validation does not add it back', () => {
    const validated = analyzePlan(overlapping, null).dag;
    expect(isAutoEdge(validated, 'T2', 'T3')).toBe(true);
    const undone = removeDependency(validated, 'T2', 'T3');
    const again = analyzePlan(undone, null);
    expect(again.overlaps).toEqual([]);
    expect(again.dag.nodes.find((n) => n.id === 'T3')?.dependsOn).toEqual(['T1']);
  });

  it('giving the shared file to the owner removes the overlap', () => {
    const validated = analyzePlan(overlapping, null).dag;
    const given = giveOverlapTo(validated, 'T2', 'T3', 'T1');
    const t1 = given.nodes.find((n) => n.id === 'T1');
    expect(t1?.touches).toContainEqual({ glob: 'web/i18n/index.ts', mode: 'modify' });
    expect(given.nodes.find((n) => n.id === 'T2')?.touches).toContainEqual({ glob: 'web/i18n/index.ts', mode: 'read' });
    const again = analyzePlan(given, null);
    expect(again.overlaps).toEqual([]);
    expect(again.dag.nodes.find((n) => n.id === 'T3')?.dependsOn).toEqual(['T1']);
  });

  it('reports structural errors without normalizing the DAG', () => {
    const broken = dag([node('T1', ['T2']), node('T2', ['T1'])]);
    const analysis = analyzePlan(broken, null);
    expect(analysis.validation.ok).toBe(false);
    expect(analysis.dag).toBe(broken);
  });
});

describe('DAG edits', () => {
  const base = dag([node('T1', []), node('T2', ['T1']), node('T3', ['T2'])]);

  it('rejects cycles, self-edges and duplicates', () => {
    expect(addDependency(base, 'T3', 'T1')).toMatchObject({ ok: false });
    expect(addDependency(base, 'T1', 'T1')).toMatchObject({ ok: false });
    expect(addDependency(base, 'T1', 'T2')).toMatchObject({ ok: false });
    const ok = addDependency(base, 'T1', 'T3');
    expect(ok.ok && ok.dag.nodes[2]?.dependsOn).toEqual(['T2', 'T1']);
  });

  it('adds and removes nodes', () => {
    const { dag: added, id } = addNode(base);
    expect(id).toBe('T4');
    expect(added.nodes).toHaveLength(4);
    const removed = removeNode(base, 'T2');
    expect(removed.nodes.map((n) => n.id)).toEqual(['T1', 'T3']);
    expect(removed.nodes[1]?.dependsOn).toEqual([]);
  });

  it('finds the deepest common ancestor', () => {
    const diamond = [node('T1', []), node('T2', ['T1']), node('T3', ['T2']), node('T4', ['T2'])];
    expect(commonOwner(diamond, 'T3', 'T4')).toBe('T2');
    expect(commonOwner([node('T1', []), node('T2', [])], 'T1', 'T2')).toBeNull();
  });
});

describe('cost ranges', () => {
  it('rounds to friendly numbers', () => {
    expect(formatCostRange(costRange(5))).toBe('$4–7');
    expect(formatCostRange(costRange(1))).toBe('$0.8–1.3');
  });
});
