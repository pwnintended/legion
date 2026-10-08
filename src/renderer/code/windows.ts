/**
 * Every window in a project's workspaces, by name, for the palette: the viewers' tabs and the terminals of every
 * workspace. Picking one shows its workspace and focuses it.
 */
import type { DataState } from '../app/data';
import type { IconName } from '../chrome/icons';
import { showWorkspace } from './actions';
import { tabLabel } from './labels';
import { focusTile, type ProjectCode, selectTab, updateWorkspace } from './state';
import { terminalLabels } from './TerminalFrame';
import { leaves } from './tree';
import { workspaceName } from './WorkspaceBar';

export interface WindowEntry {
  id: string;
  title: string;
  /** Where it is: the workspace's name. */
  where: string;
  icon: IconName;
  open: () => void;
}

export function listWindows(state: DataState, projectId: string, project: ProjectCode): WindowEntry[] {
  const out: WindowEntry[] = [];
  for (const ws of project.workspaces) {
    const where = workspaceName(state, ws, projectId);
    const terminals = terminalLabels(state, ws);
    for (const id of leaves(ws.root)) {
      const tile = ws.tiles[id];
      if (tile?.kind === 'terminal') {
        const label = terminals[id];
        out.push({
          id: `window:${ws.id}:${id}`,
          title: label?.note ? `${label.title} · ${label.note}` : (label?.title ?? 'Terminal'),
          where,
          icon: 'terminal',
          open: () => {
            showWorkspace(projectId, ws.id);
            updateWorkspace(projectId, ws.id, (w) => focusTile(w, id), true);
          },
        });
      } else if (tile?.kind === 'viewer') {
        for (const tab of tile.tabs) {
          const label = tabLabel(state, tab);
          out.push({
            id: `window:${ws.id}:${tab.id}`,
            title: label.full,
            where,
            icon: tab.kind === 'code' ? 'fileCode' : tab.params.target.kind === 'commit' ? 'commit' : 'diff',
            open: () => {
              showWorkspace(projectId, ws.id);
              updateWorkspace(projectId, ws.id, (w) => selectTab(w, id, tab.id), true);
            },
          });
        }
      }
    }
  }
  return out;
}
