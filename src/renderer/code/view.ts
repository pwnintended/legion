/** What the Code view has on screen, for the keyboard (set by the view as it renders, like the board's view). */
import type { Layout } from './tree';

let shown: { projectId: string; workspace: string; layout: Layout } | null = null;

export function setShown(next: typeof shown): void {
  shown = next;
}

/** The geometry of the workspace on screen (tiles and tab bars), or null outside the Code view. */
export function shownLayout(): Layout | null {
  return shown?.layout ?? null;
}
