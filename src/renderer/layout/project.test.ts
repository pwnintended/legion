import type { Project, Run } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { initialData } from '../app/data';
import { projectIdOfKey, projectWorkspaceKey, selectRailGroups, selectWorkspaceRuns } from '../app/projects';
import { defaultProjectLayout, isUsableProjectLayout, openPreview, previewTile } from './project';
import { focusedTile } from './tree';

const project = (id: string, path: string, addedAt: number, pinned = false): Project => ({
  id,
  path,
  name: path.split('/').at(-1) ?? path,
  addedAt,
  lastOpenedAt: null,
  pinned,
});

const run = (id: string, repoPath: string, createdAt: number, extra: Partial<Run> = {}): Run => ({
  id,
  repoPath,
  baseRef: 'main',
  title: id,
  issueText: '',
  issueUrl: null,
  status: 'executing',
  paused: false,
  plannerEngine: 'claude',
  plannerModel: null,
  integrationBranch: null,
  prUrl: null,
  error: null,
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

describe('project home layout', () => {
  it('starts with overview, activity and files at a third each', () => {
    const ws = defaultProjectLayout('project:p1', 'p1');
    expect(ws.strip.columns.map((c) => [c.key, c.width])).toEqual([
      ['project', '1/3'],
      ['activity', '1/3'],
      ['files', '1/3'],
    ]);
    expect(focusedTile(ws)?.kind).toBe('project');
    expect(isUsableProjectLayout(ws, 'p1')).toBe(true);
    expect(isUsableProjectLayout(ws, 'p2')).toBe(false);
  });

  it('reuses one preview column per kind, right of the tile it came from', () => {
    let ws = defaultProjectLayout('project:p1', 'p1');
    ws = openPreview(ws, 'code', { projectId: 'p1', path: 'a.ts', line: null, endLine: null }, 'files');
    expect(ws.strip.columns.map((c) => c.key)).toEqual(['project', 'activity', 'files', 'preview:code']);
    ws = openPreview(ws, 'code', { projectId: 'p1', path: 'b.ts', line: 3, endLine: null }, 'files');
    expect(ws.strip.columns).toHaveLength(4);
    expect(previewTile(ws, 'code')?.params).toMatchObject({ path: 'b.ts', line: 3 });
    expect(focusedTile(ws)?.kind).toBe('code');
    ws = openPreview(ws, 'diff', { target: { kind: 'commit', projectId: 'p1', sha: 'abc' } }, 'activity');
    expect(ws.strip.columns.map((c) => c.key)).toEqual([
      'project',
      'activity',
      'preview:diff',
      'files',
      'preview:code',
    ]);
    // ⌘⏎: a permanent column instead.
    ws = openPreview(ws, 'code', { projectId: 'p1', path: 'c.ts', line: null, endLine: null }, 'files', true);
    expect(ws.strip.columns.filter((c) => c.tiles[0]?.kind === 'code')).toHaveLength(2);
  });
});

describe('rail groups', () => {
  it('groups runs under projects (pinned first, then added order) and numbers runs in that order', () => {
    const state = {
      ...initialData(),
      projects: {
        p1: project('p1', '/src/app', 1),
        p2: project('p2', '/src/web', 2, true),
      },
      runs: {
        a: run('a', '/src/app', 10, { projectId: 'p1' }),
        b: run('b', '/src/web', 20),
        c: run('c', '/src/gone', 30),
        d: run('d', '/src/app', 40, { projectId: 'p1', status: 'done' }),
      },
    };
    const groups = selectRailGroups(state);
    expect(groups.map((g) => [g.key, g.runs.map((r) => r.id)])).toEqual([
      ['p2', ['b']],
      ['p1', ['a', 'd']],
      ['repo:/src/gone', ['c']],
    ]);
    expect(selectWorkspaceRuns(state).map((r) => r.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(selectRailGroups(state)).toBe(groups);
    expect(projectIdOfKey(projectWorkspaceKey('p1'))).toBe('p1');
    expect(projectIdOfKey('run_x')).toBeNull();
  });
});
