import type { DiffFile } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { parseHunks } from '../../app/demo/diffs';
import type { TrackedFinding } from '../review/evidence';
import { anchorLine, buildRows, defaultCollapsed, hunkSides, languageOf, offsetsOf, rowAt } from './model';

const file = (path: string, text: string, extra: Partial<DiffFile> = {}): DiffFile => {
  const hunks = parseHunks(text);
  const lines = hunks.flatMap((h) => h.lines);
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: lines.filter((l) => l.kind === 'add').length,
    deletions: lines.filter((l) => l.kind === 'del').length,
    hunks,
    truncated: false,
    ...extra,
  };
};

const tracked = (path: string, line: number | null, state: 'open' | 'resolved' = 'open'): TrackedFinding =>
  ({
    key: `${path}|${line}`,
    state,
    round: 1,
    finding: { severity: 'minor', file: path, line, title: 't', body: 'b', suggestedFix: null },
    review: {},
  }) as TrackedFinding;

const a = file('src/a.ts', '@@ -10,3 +10,4 @@ fn\n ctx\n-old\n+new\n+added\n ctx2');

describe('diff rows', () => {
  it('anchors findings at their line, else the nearest following line', () => {
    expect(anchorLine(a, 11)).toEqual({ hunk: 0, line: 2 });
    expect(anchorLine(a, 1)).toEqual({ hunk: 0, line: 0 });
    expect(anchorLine(a, null)).toBeNull();
  });

  it('builds file, hunk, line and finding rows with navigation indices', () => {
    const built = buildRows([a], new Set(), [tracked('src/a.ts', 11), tracked('elsewhere.ts', 1)], () => 80);
    expect(built.rows.map((r) => r.kind)).toEqual([
      'file',
      'hunk',
      'line',
      'line',
      'line',
      'finding',
      'line',
      'line',
      'gap',
    ]);
    expect(built.hunkRows).toEqual([1]);
    expect(built.findingRows).toEqual([5]);
    expect(built.rows[4]).toMatchObject({ kind: 'line', anchor: 'open' });
    expect(built.elsewhere).toHaveLength(1);
  });

  it('collapses large files by default and summarizes them', () => {
    const big = { ...a, path: 'pnpm-lock.yaml', additions: 900 };
    expect(defaultCollapsed([a, big])).toEqual(new Set(['pnpm-lock.yaml']));
    const built = buildRows([big], new Set(['pnpm-lock.yaml']), [], () => 80);
    expect(built.rows.map((r) => r.kind)).toEqual(['file', 'note']);
  });

  it('computes offsets and finds rows by y', () => {
    const built = buildRows([a], new Set(), [], () => 80);
    const offsets = offsetsOf(built.rows);
    expect(offsets[1]).toBe(36);
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 37)).toBe(1);
    expect(rowAt(offsets, 1e6)).toBe(built.rows.length - 1);
  });

  it('splits hunks into old/new code for highlighting', () => {
    const sides = hunkSides(a.hunks[0] as DiffFile['hunks'][number]);
    expect(sides.oldCode).toBe('ctx\nold\nctx2');
    expect(sides.newCode).toBe('ctx\nnew\nadded\nctx2');
    expect(sides.index.map((i) => `${i.side}${i.at}`)).toEqual(['new0', 'old1', 'new1', 'new2', 'new3']);
    expect(languageOf('x/y.tsx')).toBe('tsx');
    expect(languageOf('README')).toBeNull();
  });
});
