import { describe, expect, it } from 'vitest';
import {
  ancestors,
  CycleError,
  compareNodeIds,
  criticalPath,
  depthLayers,
  descendants,
  fanOut,
  findCycle,
  isTransitivelyReduced,
  layeredOrder,
  longestRemainingPath,
  redundantEdges,
  topologicalOrder,
  transitiveReduction,
} from './graph';
import { makeNode } from './testing';

// T1 → T2 (L), T1 → T3 (M), T2,T3 → T4; T5 isolated; T4 also lists T1 (redundant).
const diamond = [
  makeNode('T1', [], { size: 'S' }),
  makeNode('T2', ['T1'], { size: 'L' }),
  makeNode('T3', ['T1'], { size: 'M' }),
  makeNode('T4', ['T2', 'T3', 'T1'], { size: 'S' }),
  makeNode('T5', [], { size: 'M' }),
];

describe('ids', () => {
  it('orders T2 before T10', () => {
    expect(['T10', 'T2', 'T1', 'X'].sort(compareNodeIds)).toEqual(['T1', 'T2', 'T10', 'X']);
  });
});

describe('ordering', () => {
  it('gives a deterministic topological order', () => {
    expect(topologicalOrder(diamond)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('computes depth layers and the layered order', () => {
    expect(depthLayers(diamond)).toEqual([['T1', 'T5'], ['T2', 'T3'], ['T4']]);
    expect(layeredOrder(diamond)).toEqual(['T1', 'T5', 'T2', 'T3', 'T4']);
  });

  it('finds cycles and refuses to order them', () => {
    const cyclic = [makeNode('T1', ['T3']), makeNode('T2', ['T1']), makeNode('T3', ['T2']), makeNode('T4')];
    expect(findCycle(cyclic)).toEqual(['T1', 'T2', 'T3', 'T1']);
    expect(() => topologicalOrder(cyclic)).toThrow(CycleError);
    expect(findCycle([makeNode('T1', ['T1'])])).toEqual(['T1', 'T1']);
    expect(findCycle(diamond)).toBeNull();
  });
});

describe('reachability', () => {
  it('computes ancestors and descendants', () => {
    expect([...ancestors(diamond, 'T4')].sort(compareNodeIds)).toEqual(['T1', 'T2', 'T3']);
    expect([...descendants(diamond, 'T1')].sort(compareNodeIds)).toEqual(['T2', 'T3', 'T4']);
    expect(descendants(diamond, 'T5').size).toBe(0);
  });

  it('finds redundant edges and reduces them', () => {
    expect(redundantEdges(diamond)).toEqual([{ from: 'T1', to: 'T4' }]);
    expect(isTransitivelyReduced(diamond)).toBe(false);
    const reduced = transitiveReduction(diamond);
    expect(reduced.find((n) => n.id === 'T4')?.dependsOn).toEqual(['T2', 'T3']);
    expect(isTransitivelyReduced(reduced)).toBe(true);
  });

  it('counts fan-out', () => {
    expect(Object.fromEntries(fanOut(diamond))).toEqual({ T1: 3, T2: 1, T3: 1, T4: 0, T5: 0 });
  });
});

describe('paths', () => {
  it('computes the longest remaining path with size weights', () => {
    expect(Object.fromEntries(longestRemainingPath(diamond))).toEqual({ T1: 6, T2: 5, T3: 3, T4: 1, T5: 2 });
  });

  it('computes the critical path', () => {
    expect(criticalPath(diamond)).toEqual({ path: ['T1', 'T2', 'T4'], length: 6 });
    expect(criticalPath([])).toEqual({ path: [], length: 0 });
    expect(criticalPath(diamond, () => 1)).toEqual({ path: ['T1', 'T2', 'T4'], length: 3 });
  });
});
