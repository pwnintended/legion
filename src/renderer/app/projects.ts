/**
 * Projects in the renderer: selectors over the data store (the rail's project groups, the workspace order that
 * ⌘1–9 follows) and the keys of project workspaces. A project's home is an ordinary layout tree stored under
 * `project:<id>` next to the run workspaces (keyed by run id).
 */
import type { Project, Run } from '@shared/domain';
import { isArchived } from './compat';
import { type DataState, selectRunList, TERMINAL_RUN_STATUSES } from './data';

export const PROJECT_KEY_PREFIX = 'project:';

export function projectWorkspaceKey(projectId: string): string {
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}

export function isProjectKey(key: string | null | undefined): key is string {
  return !!key?.startsWith(PROJECT_KEY_PREFIX);
}

export function projectIdOfKey(key: string | null | undefined): string | null {
  return isProjectKey(key) ? key.slice(PROJECT_KEY_PREFIX.length) : null;
}

const projectListCache = new WeakMap<Record<string, Project>, Project[]>();

/** Pinned first, then in the order they were added (stable: the rail never reshuffles under you). */
export function selectProjects(state: DataState): Project[] {
  const cached = projectListCache.get(state.projects);
  if (cached) return cached;
  const list = Object.values(state.projects).sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.addedAt - b.addedAt || a.id.localeCompare(b.id),
  );
  projectListCache.set(state.projects, list);
  return list;
}

/** The project a run belongs to: its `projectId`, else the project at its repository path. */
export function projectOfRun(state: DataState, run: Run | null | undefined): Project | null {
  if (!run) return null;
  if (run.projectId) {
    const byId = state.projects[run.projectId];
    if (byId) return byId;
  }
  return Object.values(state.projects).find((p) => p.path === run.repoPath) ?? null;
}

export interface RailGroup {
  /** Project id, or `repo:<path>` for runs whose project was removed. */
  key: string;
  project: Project | null;
  name: string;
  path: string;
  /** Non-archived runs, in workspace order (active oldest first, then finished newest first). */
  runs: Run[];
}

const groupCache = new WeakMap<Record<string, Run>, { projects: Record<string, Project>; groups: RailGroup[] }>();

function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** The rail: every project with its runs, then groups for runs that have no project (any more). */
export function selectRailGroups(state: DataState): RailGroup[] {
  const cached = groupCache.get(state.runs);
  if (cached && cached.projects === state.projects) return cached.groups;
  const groups: RailGroup[] = selectProjects(state).map((project) => ({
    key: project.id,
    project,
    name: project.name,
    path: project.path,
    runs: [],
  }));
  const byId = new Map(groups.map((g) => [g.key, g]));
  const byPath = new Map(groups.map((g) => [g.path, g]));
  for (const run of selectRunList(state)) {
    let group = (run.projectId ? byId.get(run.projectId) : undefined) ?? byPath.get(run.repoPath);
    if (!group) {
      group = {
        key: `repo:${run.repoPath}`,
        project: null,
        name: baseName(run.repoPath),
        path: run.repoPath,
        runs: [],
      };
      groups.push(group);
      byId.set(group.key, group);
      byPath.set(group.path, group);
    }
    group.runs.push(run);
  }
  groupCache.set(state.runs, { projects: state.projects, groups });
  return groups;
}

const workspaceCache = new WeakMap<RailGroup[], Run[]>();

/** Runs in rail order: what the workspace numbers (⌘1–9) refer to. */
export function selectWorkspaceRuns(state: DataState): Run[] {
  const groups = selectRailGroups(state);
  const cached = workspaceCache.get(groups);
  if (cached) return cached;
  const list = groups.flatMap((g) => g.runs);
  workspaceCache.set(groups, list);
  return list;
}

/** Runs of a project that are still going (not finished, not archived). */
export function activeRunsOf(runs: readonly Run[]): Run[] {
  return runs.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status) && !isArchived(r));
}
