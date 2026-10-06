import { describe, expect, it } from 'vitest';
import { applySnapshot, initialData, openInbox } from '../app/data';
import { createDemoWorld, snapshotOf } from '../app/demo/fixtures';
import { dependentsOf, moveSelection, NO_SELECTION, rankInbox, runLabel, selectAt, selectedIndex } from './inbox-model';

function demoState() {
  const world = createDemoWorld(1_000_000_000);
  let state = initialData();
  for (const run of world.runs) {
    const snapshot = snapshotOf(world, run.id, 1000);
    if (snapshot) state = applySnapshot(state, snapshot);
  }
  return state;
}

describe('rankInbox', () => {
  it('orders by kind, then by what an item unblocks, then by age', () => {
    const state = demoState();
    const ranked = rankInbox(state, openInbox(state.inbox, '*'));
    expect(ranked.map((r) => r.item.kind)).toEqual(['approval', 'question', 'plan_signoff', 'pr_ready', 'budget']);
    // T3's approval holds up T5 and, through it, T6.
    expect(ranked[0]?.blocks).toEqual(['T5', 'T6']);
    expect(ranked[0]?.blocksLabel).toBe('blocks T5, T6');
    expect(ranked[1]?.blocksLabel).toBe('blocks the plan');
    expect(ranked[2]?.blocksLabel).toBe('blocks 7 tasks');
  });

  it('puts the item that unblocks more first within a kind', () => {
    const state = demoState();
    const approval = openInbox(state.inbox, '*').find((i) => i.kind === 'approval');
    if (!approval) throw new Error('fixture approval missing');
    const t2Task = Object.values(state.tasks).find((t) => t.runId === approval.runId && t.nodeId === 'T4');
    const older = { ...approval, id: 'other', taskId: t2Task?.id ?? null, createdAt: approval.createdAt - 1 };
    const ranked = rankInbox(state, [older, approval]);
    // T4 only blocks T6, T3 blocks T5 and T6.
    expect(ranked.map((r) => r.item.id)).toEqual([approval.id, 'other']);
  });
});

describe('helpers', () => {
  it('finds transitive dependents', () => {
    const nodes = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
      { id: 'T3', dependsOn: ['T2'] },
      { id: 'T10', dependsOn: ['T1'] },
    ];
    expect(dependentsOf(nodes, 'T1')).toEqual(['T2', 'T3', 'T10']);
    expect(dependentsOf(nodes, 'T3')).toEqual([]);
  });
  it('shortens run titles', () => {
    expect(runLabel('Add passkey (WebAuthn) login')).toBe('Add passkey login');
    expect(runLabel('Rate-limit the public API')).toBe('Rate-limit the public API');
    expect(runLabel('Extract UI strings for internationalisation')).toBe('Extract UI strings for…');
  });
});

describe('selection', () => {
  it('follows the selected item when another item sorts above it', () => {
    const state = demoState();
    const items = openInbox(state.inbox, '*');
    const approval = items.find((i) => i.kind === 'approval');
    if (!approval) throw new Error('fixture approval missing');
    const before = rankInbox(state, items);
    // The user looks at the question (row 1) and is about to press a key.
    const question = before[1]?.item;
    const selection = selectAt(before, 1);
    expect(selection.id).toBe(question?.id);
    // A new approval arrives and ranks first: the question moves to row 2, the selection with it.
    const fresh = { ...approval, id: 'new-approval', createdAt: approval.createdAt - 10 };
    const after = rankInbox(state, [...items, fresh]);
    expect(after[1]?.item.id).not.toBe(question?.id);
    expect(after[selectedIndex(after, selection)]?.item.id).toBe(question?.id);
  });

  it('stays on the same row when the selected item is resolved, and clamps at the ends', () => {
    const state = demoState();
    const items = openInbox(state.inbox, '*');
    const ranked = rankInbox(state, items);
    const selection = selectAt(ranked, 1);
    const remaining = rankInbox(
      state,
      items.filter((i) => i.id !== selection.id),
    );
    expect(selectedIndex(remaining, selection)).toBe(1);
    expect(selectedIndex(ranked, NO_SELECTION)).toBe(0);
    expect(selectedIndex([], selection)).toBe(0);
    expect(moveSelection(ranked, selectAt(ranked, ranked.length - 1), 1).index).toBe(ranked.length - 1);
    expect(moveSelection(ranked, NO_SELECTION, -1).index).toBe(0);
    expect(moveSelection(ranked, selection, 1).id).toBe(ranked[2]?.item.id);
  });
});
