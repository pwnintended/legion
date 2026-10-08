import type { Attempt, Task } from '@shared/domain';
import type { DiffFile, DiffHunk } from '@shared/rpc';
import { describe, expect, it } from 'vitest';
import { initialData } from '../../app/data';
import { buildRows } from './model';
import { changedRange, type ReviewComment, reviewChannel, reviewText } from './review';

const hunk = (newStart: number): DiffHunk => ({
  oldStart: newStart,
  oldLines: 2,
  newStart,
  newLines: 2,
  header: '',
  lines: [
    { kind: 'context', oldLine: newStart, newLine: newStart, text: 'keep' },
    { kind: 'del', oldLine: newStart + 1, newLine: null, text: 'old' },
    { kind: 'add', oldLine: null, newLine: newStart + 1, text: 'new' },
  ],
});

const file: DiffFile = {
  path: 'src/a.ts',
  oldPath: null,
  status: 'modified',
  binary: false,
  additions: 2,
  deletions: 2,
  hunks: [hunk(1), hunk(20)],
  truncated: false,
};

const comment = (newStart: number, text: string, id = text): ReviewComment => ({
  id,
  taskId: 't1',
  path: 'src/a.ts',
  newStart,
  start: newStart + 1,
  end: newStart + 1,
  quote: ['- old', '+ new'],
  text,
});

const task = (status: Task['status']) =>
  ({ id: 't1', runId: 'r1', nodeId: 'T1', status, worktreePath: '/wt/T1' }) as Task;
const coder = (status: Attempt['status']) =>
  ({ id: 'a1', runId: 'r1', taskId: 't1', role: 'coder', engine: 'claude', status }) as Attempt;

describe('review of a task diff', () => {
  it('names the lines a hunk changes', () => {
    expect(changedRange(hunk(20))).toEqual({ start: 21, end: 21 });
  });

  it('writes one message with every comment, its place and the change it is about', () => {
    const text = reviewText([comment(1, 'Keep the old name'), comment(20, 'Why?\nExplain')]);
    expect(text).toContain('2 comments');
    expect(text).toContain('1. src/a.ts:2\n   > - old\n   > + new\n   Keep the old name');
    expect(text).toContain('2. src/a.ts:21');
    expect(text).toContain('   Why?\n   Explain');
  });

  it('sends into the live coder session, else as a request for changes, else not at all', () => {
    const base = initialData();
    const live = { ...base, tasks: { t1: task('fixing') }, attempts: { a1: coder('running') } };
    expect(reviewChannel(live, 't1')).toEqual({ kind: 'session', attemptId: 'a1' });
    const waiting = { ...base, tasks: { t1: task('awaiting_human') }, attempts: { a1: coder('succeeded') } };
    expect(reviewChannel(waiting, 't1')).toEqual({ kind: 'requestChanges' });
    const merged = { ...base, tasks: { t1: task('merged') }, attempts: {} };
    expect(reviewChannel(merged, 't1')).toMatchObject({ kind: 'none' });
    const reviewing = { ...base, tasks: { t1: task('reviewing') }, attempts: {} };
    expect(reviewChannel(reviewing, 't1')).toMatchObject({ kind: 'none' });
  });

  it('places comments and the comment box under their hunk; a comment on a hunk that went leads its file', () => {
    const built = buildRows([file], new Set(), [], () => 0, {
      comments: [comment(20, 'second'), comment(1, 'first'), comment(99, 'moved')],
      composing: { path: 'src/a.ts', newStart: 1 },
      height: (_key, fallback) => fallback,
    });
    const kinds = built.rows.map((r) =>
      r.kind === 'comment' ? `comment:${r.comment.text}` : r.kind === 'line' ? 'line' : r.kind,
    );
    expect(kinds).toEqual([
      'file',
      'comment:moved',
      'hunk',
      'line',
      'line',
      'line',
      'comment:first',
      'compose',
      'hunk',
      'line',
      'line',
      'line',
      'comment:second',
      'gap',
    ]);
    expect(built.strayComments).toEqual([]);
  });
});
