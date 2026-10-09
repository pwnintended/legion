/**
 * Settings → Agents, the project layer of a role's prompt: legion.json `prompts` as `projects.prompts` reads it,
 * the drafts typed over it (per role, kept across role switches) and the explicit save that writes every changed
 * role at once (`projects.setPrompts`). Pure; AgentsSettings.tsx holds the state and runs the requests, and a
 * response applies only while its ticket is current, like gates-model.ts.
 */
import type { ProjectPrompts, Role } from '@shared/domain';

export type ProjectPromptsLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ProjectPrompts };

export type ProjectPromptsSave =
  | { status: 'idle' }
  | { status: 'saving'; ticket: number }
  | { status: 'saved' }
  | { status: 'error'; message: string; conflict: boolean };

export interface ProjectPromptsSession {
  projectId: string | null;
  /** The request whose answer `load` waits for. */
  ticket: number;
  load: ProjectPromptsLoad;
  /** Typed text per role, only for roles edited since the last load or save. */
  drafts: Partial<Record<Role, string>>;
  save: ProjectPromptsSave;
}

export const EMPTY_PROJECT_PROMPTS: ProjectPromptsSession = {
  projectId: null,
  ticket: 0,
  load: { status: 'loading' },
  drafts: {},
  save: { status: 'idle' },
};

export function startLoad(projectId: string, ticket: number): ProjectPromptsSession {
  return { projectId, ticket, load: { status: 'loading' }, drafts: {}, save: { status: 'idle' } };
}

export function loadDone(s: ProjectPromptsSession, ticket: number, data: ProjectPrompts): ProjectPromptsSession {
  return s.ticket === ticket ? { ...s, load: { status: 'ready', data } } : s;
}

export function loadFailed(s: ProjectPromptsSession, ticket: number, message: string): ProjectPromptsSession {
  return s.ticket === ticket ? { ...s, load: { status: 'error', message } } : s;
}

/** The role's text in legion.json as loaded ('' when it has none). */
export function savedText(s: ProjectPromptsSession, role: Role): string {
  return s.load.status === 'ready' ? (s.load.data.prompts[role] ?? '') : '';
}

/** What the editor shows: the draft when there is one, else the file's text. */
export function draftText(s: ProjectPromptsSession, role: Role): string {
  return s.drafts[role] ?? savedText(s, role);
}

export function editDraft(s: ProjectPromptsSession, role: Role, text: string): ProjectPromptsSession {
  const save = s.save.status === 'saving' ? s.save : ({ status: 'idle' } as const);
  return { ...s, drafts: { ...s.drafts, [role]: text }, save };
}

/** Roles whose draft differs from the file (ignoring surrounding whitespace, which the engine trims). */
export function dirtyRoles(s: ProjectPromptsSession): Role[] {
  return (Object.keys(s.drafts) as Role[]).filter(
    (role) => (s.drafts[role] ?? '').trim() !== savedText(s, role).trim(),
  );
}

export function discardDrafts(s: ProjectPromptsSession): ProjectPromptsSession {
  return { ...s, drafts: {}, save: { status: 'idle' } };
}

/** The request for every changed role, or null when nothing can be saved now. */
export function startSave(
  s: ProjectPromptsSession,
  ticket: number,
): {
  session: ProjectPromptsSession;
  request: { projectId: string; revision: string | null; prompts: Partial<Record<Role, string | null>> };
} | null {
  const dirty = dirtyRoles(s);
  if (!s.projectId || s.load.status !== 'ready' || s.load.data.error || s.save.status === 'saving' || !dirty.length)
    return null;
  const prompts: Partial<Record<Role, string | null>> = {};
  for (const role of dirty) prompts[role] = s.drafts[role]?.trim() ? (s.drafts[role] as string) : null;
  return {
    session: { ...s, save: { status: 'saving', ticket } },
    request: { projectId: s.projectId, revision: s.load.data.revision, prompts },
  };
}

/** Saved: the file is the new truth, and the drafts it took are gone (a draft typed since stays). */
export function saveDone(s: ProjectPromptsSession, ticket: number, data: ProjectPrompts): ProjectPromptsSession {
  if (s.save.status !== 'saving' || s.save.ticket !== ticket) return s;
  const drafts: Partial<Record<Role, string>> = {};
  for (const [role, text] of Object.entries(s.drafts) as [Role, string][]) {
    if (text.trim() !== (data.prompts[role] ?? '').trim()) drafts[role] = text;
  }
  return { ...s, load: { status: 'ready', data }, drafts, save: { status: 'saved' } };
}

export function saveFailed(
  s: ProjectPromptsSession,
  ticket: number,
  message: string,
  conflict: boolean,
): ProjectPromptsSession {
  if (s.save.status !== 'saving' || s.save.ticket !== ticket) return s;
  return { ...s, save: { status: 'error', message, conflict } };
}
