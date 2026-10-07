/**
 * What the next New run composer should start with: the project it was opened from, and text to add to the
 * issue (e.g. a `path:lines` reference from the code viewer). The composer takes it once when it mounts.
 */
import { actions } from './store';

export interface ComposerSeed {
  /** Preselect this repository (a project's path). */
  repoPath: string | null;
  /** Appended to the draft's issue text. */
  text: string | null;
}

let pending: ComposerSeed | null = null;

/** Open the composer with a seed (replacing any seed not taken yet). */
export function openComposer(seed: ComposerSeed | null = null): void {
  pending = seed;
  actions.openOverlay('composer');
}

/** The seed for the composer that is mounting now (null when it was opened without one). */
export function takeComposerSeed(): ComposerSeed | null {
  const seed = pending;
  pending = null;
  return seed;
}

/** The draft text with the seed's text added on its own paragraph. */
export function seededText(draft: string, seed: ComposerSeed | null): string {
  if (!seed?.text) return draft;
  if (draft.includes(seed.text)) return draft;
  const head = draft.trimEnd();
  return head ? `${head}\n\n${seed.text}` : seed.text;
}

/** The base branch to start with: a seed for another repository resets the draft's. */
export function seededBase(draftBase: string, draftRepo: string | null, seed: ComposerSeed | null): string {
  return seed?.repoPath && seed.repoPath !== draftRepo ? '' : draftBase;
}
