/** React bindings of the Code view's workspaces (code/state.ts). */
import { useStore } from 'zustand';
import { useData, useUi } from '../app/hooks';
import { isReadOnly } from './actions';
import { codeStore, type ProjectCode, projectCode, type ViewerTab, type Workspace } from './state';

export function useProjectCode(projectId: string): ProjectCode {
  return useStore(codeStore, (s) => s.projects[projectId]) ?? projectCode(projectId);
}

/** The project's workspace on screen (its current one). */
export function useCurrentWorkspace(projectId: string): Workspace | null {
  const project = useProjectCode(projectId);
  return project.workspaces.find((w) => w.id === project.current) ?? project.workspaces[0] ?? null;
}

/**
 * Something about the tab shown in the current workspace's focused (or last used) viewer, for this project
 * (null without one): the files tree marks the open file, the history the open commit. `select` must return a
 * primitive.
 */
export function useShownTab<T extends string | number | null>(
  projectId: string,
  select: (tab: ViewerTab) => T,
): T | null {
  const inView = useUi((s) => s.activeProjectId === projectId);
  return useStore(codeStore, (s) => {
    if (!inView) return null;
    const project = s.projects[projectId];
    const ws = project?.workspaces.find((w) => w.id === project.current);
    if (!ws) return null;
    const viewerId =
      ws.focus && ws.tiles[ws.focus]?.kind === 'viewer'
        ? ws.focus
        : ws.recent.find((id) => ws.tiles[id]?.kind === 'viewer');
    const viewer = viewerId ? ws.tiles[viewerId] : undefined;
    if (viewer?.kind !== 'viewer') return null;
    const tab = viewer.tabs.find((t) => t.id === viewer.active);
    return tab ? select(tab) : null;
  });
}

/** Is the workspace on this checkout read-only (its task's agent working there, not taken over)? */
export function useCheckoutReadOnly(projectId: string, checkout: string | null): boolean {
  const ws = useStore(codeStore, (s) =>
    checkout ? s.projects[projectId]?.workspaces.find((w) => w.checkout === checkout) : undefined,
  );
  return useData((s) => (ws ? isReadOnly(s, ws) : false));
}
