import { describe, expect, it } from 'vitest';
import { amendmentNeedsSignoff, boardChanges, boardSnapshot, touchDirectory } from './lead';
import type { BoardRow } from './prompts/types';
import { makeNode } from './testing';

describe('touchDirectory', () => {
  it('finds the directory a touch writes in', () => {
    expect(touchDirectory('README.md')).toBe('.');
    expect(touchDirectory('src/api/users.ts')).toBe('src/api');
    expect(touchDirectory('src/api/**')).toBe('src/api');
    expect(touchDirectory('src/api/*.ts')).toBe('src/api');
    expect(touchDirectory('src/**/*.test.ts')).toBe('src');
    expect(touchDirectory('docs/')).toBe('docs');
  });
});

describe('amendmentNeedsSignoff', () => {
  const approved = [
    makeNode('T1', [], { touches: [{ glob: 'src/api/users.ts', mode: 'create' }] }),
    makeNode('T2', ['T1'], {
      touches: [
        { glob: 'src/api/**', mode: 'modify' },
        { glob: 'docs/api.md', mode: 'read' },
      ],
    }),
  ];

  it('applies in-scope, non-high-risk work at once', () => {
    const node = makeNode('T3', ['T1'], { touches: [{ glob: 'src/api/users.test.ts', mode: 'create' }] });
    expect(amendmentNeedsSignoff(approved, node)).toBeNull();
    const deeper = makeNode('T4', [], { touches: [{ glob: 'src/api/v2/**', mode: 'create' }] });
    expect(amendmentNeedsSignoff(approved, deeper)).toBeNull();
  });

  it('asks the human for writes outside the approved area or high risk', () => {
    const outside = makeNode('T3', [], { touches: [{ glob: 'docs/api.md', mode: 'modify' }] });
    expect(amendmentNeedsSignoff(approved, outside)).toContain('outside the approved plan');
    const parent = makeNode('T3', [], { touches: [{ glob: 'src/index.ts', mode: 'modify' }] });
    expect(amendmentNeedsSignoff(approved, parent)).toContain('`src/index.ts`');
    const risky = makeNode('T3', [], { risk: 'high', touches: [{ glob: 'src/api/x.ts', mode: 'create' }] });
    expect(amendmentNeedsSignoff(approved, risky)).toBe('T3 is high risk');
  });

  it('lets a high-risk task be reworded, but not widened or raised to high risk', () => {
    const plan = [
      ...approved,
      makeNode('T9', [], { risk: 'high', touches: [{ glob: 'package.json', mode: 'modify' }] }),
    ];
    const reworded = makeNode('T9', [], {
      risk: 'high',
      touches: [{ glob: 'package.json', mode: 'modify' }],
      acceptanceCriteria: [{ id: 'AC1', text: 'Scripts run under pnpm 11' }],
    });
    expect(amendmentNeedsSignoff(plan, reworded)).toBeNull();
    const widened = makeNode('T9', [], {
      risk: 'high',
      touches: [
        { glob: 'package.json', mode: 'modify' },
        { glob: 'infra/deploy.sh', mode: 'create' },
      ],
    });
    expect(amendmentNeedsSignoff(plan, widened)).toContain('`infra/deploy.sh`');
    const raised = makeNode('T2', ['T1'], { risk: 'high', touches: [{ glob: 'src/api/**', mode: 'modify' }] });
    expect(amendmentNeedsSignoff(plan, raised)).toBe('T2 becomes high risk');
  });

  it('ignores the amended node itself when computing the approved area', () => {
    const changed = makeNode('T2', ['T1'], { touches: [{ glob: 'src/other/**', mode: 'modify' }] });
    expect(amendmentNeedsSignoff(approved, changed)).toContain('outside');
  });
});

describe('boardChanges', () => {
  const row = (nodeId: string, status: BoardRow['status'], extra: Partial<BoardRow> = {}): BoardRow => ({
    nodeId,
    title: `Task ${nodeId}`,
    status,
    dependsOn: [],
    progress: null,
    error: null,
    summary: null,
    ...extra,
  });

  it('lists status changes and new tasks with the useful detail', () => {
    const before = boardSnapshot([row('T1', 'running'), row('T2', 'blocked')]);
    const after = [
      row('T1', 'merged', { summary: 'Added the module.\nMore.' }),
      row('T2', 'blocked'),
      row('T3', 'failed', { error: 'verify failed' }),
      row('T4', 'queued'),
    ];
    expect(boardChanges(before, after)).toEqual([
      'T1 running → merged: Added the module.',
      'T3 added (failed): verify failed',
      'T4 added (queued)',
    ]);
    expect(boardChanges(boardSnapshot(after), after)).toEqual([]);
  });
});
