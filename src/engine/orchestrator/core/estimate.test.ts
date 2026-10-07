import { describe, expect, it } from 'vitest';
import { finalizerEngineFor, reviewerEngineFor } from './engines';
import { ESTIMATE_CONSTANTS, estimateNode, estimatePlan } from './estimate';
import { makeNode } from './testing';

describe('engines', () => {
  it('reviews with the other engine unless it is disabled', () => {
    expect(reviewerEngineFor('claude')).toBe('codex');
    expect(reviewerEngineFor('codex')).toBe('claude');
    expect(reviewerEngineFor('claude', { claude: true, codex: false })).toBe('claude');
    expect(reviewerEngineFor('fake')).toBe('fake');
  });

  it('finalizes with the engine other than the majority of coders', () => {
    expect(finalizerEngineFor(['claude', 'claude', 'codex'])).toBe('codex');
    expect(finalizerEngineFor(['codex', 'codex', 'claude'])).toBe('claude');
    expect(finalizerEngineFor(['claude', 'codex'])).toBe('codex');
    expect(finalizerEngineFor(['fake'])).toBe('fake');
  });
});

describe('estimateNode', () => {
  it('computes cost and duration from size, engines and expected fix rounds', () => {
    const estimate = estimateNode(makeNode('T1', [], { size: 'S' }));
    const k = ESTIMATE_CONSTANTS;
    const coder = k.coderMinutes.S;
    const review = k.reviewerMinutes.S * k.engineTimeFactor.codex;
    const fix = k.expectedFixRounds.low;
    const minutes =
      coder * (1 + k.retryRate) +
      k.verifyMinutes.S +
      review +
      fix * (coder * k.fixRoundCoderFraction + k.verifyMinutes.S + review);
    expect(estimate.coderEngine).toBe('claude');
    expect(estimate.reviewerEngine).toBe('codex');
    expect(estimate.expectedFixRounds).toBe(0.3);
    expect(estimate.minutes).toBeCloseTo(minutes, 1);
    expect(estimate.costUsd).toBeCloseTo(
      estimate.breakdown.coderUsd + estimate.breakdown.reviewerUsd + estimate.breakdown.fixUsd,
      1,
    );
  });

  it('grows with size and risk, honours overrides and caps fix rounds', () => {
    const s = estimateNode(makeNode('T1', [], { size: 'S' }));
    const m = estimateNode(makeNode('T1', [], { size: 'M' }));
    const l = estimateNode(makeNode('T1', [], { size: 'L', risk: 'high' }));
    expect(s.minutes).toBeLessThan(m.minutes);
    expect(m.minutes).toBeLessThan(l.minutes);
    expect(s.costUsd).toBeLessThan(m.costUsd);
    expect(l.expectedFixRounds).toBe(1.4);
    expect(estimateNode(makeNode('T1', [], { size: 'L', risk: 'high' }), { maxFixRounds: 1 }).expectedFixRounds).toBe(
      1,
    );
    const onCodex = estimateNode(makeNode('T1'), { coderEngine: 'codex' });
    expect([onCodex.coderEngine, onCodex.reviewerEngine]).toEqual(['codex', 'claude']);
  });
});

describe('estimatePlan', () => {
  const chain = [makeNode('T1'), makeNode('T2', ['T1']), makeNode('T3', ['T2'])];
  const wide = [makeNode('T1'), makeNode('T2'), makeNode('T3'), makeNode('T4')];

  it('runs a chain serially: wall clock equals the critical path', () => {
    const plan = estimatePlan(chain);
    expect(plan.criticalPath).toEqual(['T1', 'T2', 'T3']);
    expect(plan.executionMinutes).toBeCloseTo(plan.criticalPathMinutes, 0);
    expect(plan.executionMinutes).toBeCloseTo(plan.serialMinutes, 0);
    expect(plan.wallClockMinutes).toBeCloseTo(plan.executionMinutes + ESTIMATE_CONSTANTS.finalize.minutes, 1);
  });

  it('parallelizes independent nodes up to the concurrency cap', () => {
    const unlimited = estimatePlan(wide, { concurrency: { global: 4, perEngine: {} } });
    const three = estimatePlan(wide, { concurrency: { global: 3, perEngine: {} } });
    const one = estimatePlan(wide, { concurrency: { global: 1, perEngine: {} } });
    const nodeMinutes = unlimited.nodes[0]?.minutes ?? 0;
    // All four start at 0; merges are serialized.
    expect(unlimited.schedule.every((s) => s.start === 0)).toBe(true);
    expect(unlimited.executionMinutes).toBeCloseTo(nodeMinutes + 4 * ESTIMATE_CONSTANTS.mergeMinutes, 1);
    expect(three.executionMinutes).toBeGreaterThan(unlimited.executionMinutes);
    // One slot: work is serial, merges overlap the next task (the slot is released before merging).
    expect(one.executionMinutes).toBeCloseTo(4 * nodeMinutes + ESTIMATE_CONSTANTS.mergeMinutes, 1);
    expect(three.concurrency).toBe(3);
  });

  it('applies the per-engine cap of the coder engine', () => {
    const three = [makeNode('T1'), makeNode('T2'), makeNode('T3')];
    const caps = { global: 3, perEngine: { claude: 1, codex: 3 } };
    const onClaude = Object.fromEntries(
      estimatePlan(three, { concurrency: caps }).schedule.map((s) => [s.nodeId, s.start]),
    );
    expect(onClaude.T1).toBe(0);
    expect(onClaude.T2).toBeGreaterThan(0);
    expect(onClaude.T3).toBeGreaterThan(0);
    const onCodex = Object.fromEntries(
      estimatePlan(three, { concurrency: caps, coderEngine: 'codex' }).schedule.map((s) => [s.nodeId, s.start]),
    );
    expect([onCodex.T1, onCodex.T2, onCodex.T3]).toEqual([0, 0, 0]);
  });

  it('starts dependents only after their dependencies are merged', () => {
    const nodes = [makeNode('T1', [], { size: 'L' }), makeNode('T2', [], { size: 'S' }), makeNode('T3', ['T1', 'T2'])];
    const plan = estimatePlan(nodes);
    const byId = Object.fromEntries(plan.schedule.map((s) => [s.nodeId, s]));
    expect(byId.T3?.start).toBe(Math.max(byId.T1?.mergedAt ?? 0, byId.T2?.mergedAt ?? 0));
    expect(plan.schedule.map((s) => s.nodeId)).toEqual(['T1', 'T2', 'T3']);
  });

  it('sums costs and adds the finalize step', () => {
    const plan = estimatePlan(wide);
    const sum = plan.nodes.reduce((acc, n) => acc + n.costUsd, 0);
    expect(plan.totalCostUsd).toBeCloseTo(sum + ESTIMATE_CONSTANTS.finalize.costUsd.codex, 1);
    expect(estimatePlan([]).totalCostUsd).toBe(ESTIMATE_CONSTANTS.finalize.costUsd.codex);
  });
});
