/**
 * Project actions shared by the rail, the palette, overlays and the Code view: add / open / forget a project,
 * open a file, a commit or the search in the Code view's workspace, and start a run about a piece of code.
 */
import type { Project } from '@shared/domain';
import { openDiff, openInViewer, showPanel } from '../code/actions';
import { toast } from '../overlays/nav';
import { openComposer, openSessionComposer } from './composer-seed';
import { applyProjectRow } from './data';
import { rpc } from './hooks';
import { actions, activeProjectOf, dataStore, uiStore } from './store';
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
  /** Keep it as a pinned tab instead of the viewer's preview. */
  pinned?: boolean;
}

/** Open a file of the project in the Code view's viewer. */
export function openFile(projectId: string, path: string, options: OpenOptions = {}): void {
  recordOpened(projectId, path);
  openInViewer(
    projectId,
    'code',
    { projectId, path, line: options.line ?? null, endLine: options.endLine ?? null },
    { pinned: options.pinned ?? false },
  );
}

/** Open a commit's diff in the viewer. */
export function openCommit(projectId: string, sha: string, options: OpenOptions = {}): void {
  openDiff(projectId, { kind: 'commit', projectId, sha }, { pinned: options.pinned ?? false });
}

/** Show the search in the Code view's side panel, optionally with a query, the caret in its field. */
export function openSearch(projectId: string, query: string | null = null): void {
  const ui = uiStore.getState();
  if (activeProjectOf(ui, dataStore.getState())?.id !== projectId) actions.openProjectHome(projectId);
  showPanel('search', query);
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

/** The run composer (a plan, agents, a PR), preselecting the project on screen. */
export function newRunInProject(projectId: string | null = currentProject()?.id ?? null): void {
  const project = projectId ? dataStore.getState().projects[projectId] : null;
  openComposer(project ? { repoPath: project.path, text: null } : null);
}

/** The session composer (⌘⇧N), preselecting the project on screen. */
export function newSessionInProject(projectId: string | null = currentProject()?.id ?? null): void {
  const project = projectId ? dataStore.getState().projects[projectId] : null;
  openSessionComposer(project ? { repoPath: project.path, text: null } : null);
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
