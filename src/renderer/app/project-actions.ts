/**
 * Project actions shared by the rail, the palette, overlays and the project home tiles: add / open / forget a
 * project, open a file, a commit or the search in the project home, and start a run about a piece of code.
 */
import type { Project } from '@shared/domain';
import { openPreview, previewTile } from '../layout/project';
import { focusTile, setTileParams } from '../layout/tree';
import { toast } from '../overlays/nav';
import { openComposer } from './composer-seed';
import { applyProjectRow } from './data';
import { rpc } from './hooks';
import { projectWorkspaceKey } from './projects';
import { actions, activeProjectOf, dataStore, syncActiveLayout, uiStore } from './store';
import { getClient } from './sync';

function adoptProject(project: Project): void {
  const atSeq = getClient().seq;
  dataStore.setState((s) => applyProjectRow(s, project, atSeq), true);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The project of whatever is on screen (its home, or the active run's project). */
export function currentProject(): Project | null {
  return activeProjectOf(uiStore.getState(), dataStore.getState());
}

/** Show a project's page (a new conversation, or its repository in the agents view) and record the visit. */
export function openProject(projectId: string): void {
  actions.closeOverlay();
  actions.openProjectHome(projectId);
  rpc('projects.touch', { projectId }).then(adoptProject, () => {});
}

/** Add the checkout at `path` (any folder inside it) and open its home. Throws with a readable message. */
export async function addProject(path: string): Promise<Project> {
  const project = await rpc('projects.add', { path });
  adoptProject(project);
  actions.closeOverlay();
  actions.openProjectHome(project.id);
  return project;
}

/** Forget a project (nothing on disk changes). */
export async function removeProject(project: Project): Promise<void> {
  try {
    await rpc('projects.remove', { projectId: project.id });
    toast(`Removed ${project.name} from Legion. The folder is untouched.`);
  } catch (error) {
    toast(`Couldn't remove ${project.name}: ${errorText(error)}`, 'error');
  }
}

export async function setPinned(project: Project, pinned: boolean): Promise<void> {
  try {
    adoptProject(await rpc('projects.pin', { projectId: project.id, pinned }));
  } catch (error) {
    toast(`Couldn't ${pinned ? 'pin' : 'unpin'} ${project.name}: ${errorText(error)}`, 'error');
  }
}

/** Make sure the project's code is on screen (switching to it from a run when needed); returns its key. */
function showHome(projectId: string): string {
  const ui = uiStore.getState();
  if (ui.activeProjectId !== projectId) actions.openProjectHome(projectId);
  actions.setView('code');
  syncActiveLayout();
  return projectWorkspaceKey(projectId);
}

// ---------------------------------------------------------------------------------------------
// Recently opened files (⌘P's empty state), per project, this session
// ---------------------------------------------------------------------------------------------

const recent = new Map<string, string[]>();

export function recentFiles(projectId: string): readonly string[] {
  return recent.get(projectId) ?? [];
}

function recordOpened(projectId: string, path: string): void {
  const list = (recent.get(projectId) ?? []).filter((p) => p !== path);
  recent.set(projectId, [path, ...list].slice(0, 12));
}

export interface OpenOptions {
  line?: number | null;
  endLine?: number | null;
  /** The tile the file was opened from (the preview column goes right of it). */
  anchorTileId?: string | null;
  /** A new, permanent column instead of the preview column. */
  newColumn?: boolean;
}

/** Open a file of the project in the code viewer. */
export function openFile(projectId: string, path: string, options: OpenOptions = {}): void {
  const key = showHome(projectId);
  recordOpened(projectId, path);
  actions.updateLayout(
    key,
    (ws) =>
      openPreview(
        ws,
        'code',
        { projectId, path, line: options.line ?? null, endLine: options.endLine ?? null },
        options.anchorTileId ?? 'files',
        options.newColumn ?? false,
      ),
    true,
  );
}

/** Open a commit's diff. */
export function openCommit(projectId: string, sha: string, options: OpenOptions = {}): void {
  const key = showHome(projectId);
  actions.updateLayout(
    key,
    (ws) =>
      openPreview(
        ws,
        'diff',
        { target: { kind: 'commit', projectId, sha } },
        options.anchorTileId ?? 'activity',
        options.newColumn ?? false,
      ),
    true,
  );
}

/** Focus the project's search (opening it right of the files when needed), optionally with a query. */
export function openSearch(projectId: string, query: string | null = null): void {
  const key = showHome(projectId);
  actions.updateLayout(
    key,
    (ws) => {
      const existing = previewTile(ws, 'search');
      if (existing) {
        const params = existing.params as { projectId: string; query: string };
        const next =
          query !== null && query !== params.query ? setTileParams(ws, existing.id, { ...params, query }) : ws;
        return focusTile(next, existing.id);
      }
      return openPreview(ws, 'search', { projectId, query: query ?? '' }, 'files');
    },
    true,
  );
}

/** `src/a.ts:12-18` (or `:12`, or just the path). */
export function codeReference(path: string, line: number | null, endLine: number | null): string {
  if (!line) return path;
  return endLine && endLine !== line ? `${path}:${line}-${endLine}` : `${path}:${line}`;
}

/** Open the composer for this project with a reference to a piece of its code. */
export function startRunAbout(projectId: string, path: string, line: number | null, endLine: number | null): void {
  const project = dataStore.getState().projects[projectId];
  const reference = codeReference(path, line, endLine);
  openComposer({ repoPath: project?.path ?? null, text: `About \`${reference}\`:\n` });
}

/** The composer, preselecting the project on screen. */
export function newRunInProject(projectId: string | null = currentProject()?.id ?? null): void {
  const project = projectId ? dataStore.getState().projects[projectId] : null;
  openComposer(project ? { repoPath: project.path, text: null } : null);
}

/** The folder dialog (answered by `LEGION_E2E_PICK_DIR` in tests); null when cancelled or unavailable. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const bridge = (
    window as Window & {
      legion?: { pickDirectory?: (o: { title?: string; defaultPath?: string }) => Promise<string | null> };
    }
  ).legion;
  return (await bridge?.pickDirectory?.({ title: 'Add a project', defaultPath })) ?? null;
}

/** Browse… → add the chosen folder as a project. */
export async function addProjectFromDialog(): Promise<Project | null> {
  const path = await pickFolder();
  if (!path) return null;
  try {
    return await addProject(path);
  } catch (error) {
    toast(`Couldn't add that folder: ${errorText(error)}`, 'error');
    return null;
  }
}
