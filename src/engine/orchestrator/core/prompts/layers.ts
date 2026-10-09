/**
 * The human's layers over a role's system prompt (Settings → Agents): Legion's built-in prompt, or the global
 * replacement instead of it, then the global additions, then the repository's (legion.json `prompts`). Shared by
 * the engine (`Orchestrator.openSession`, every session) and Settings ("What the agent receives").
 */
import { join, section } from './format';
import { DEFAULT_TOOL_NAMES } from './types';

export interface PromptLayers {
  /** Settings: used instead of the built-in prompt; null or blank = the built-in. */
  readonly replace: string | null;
  /** Settings: added in every project. */
  readonly append: string;
  /** legion.json `prompts.<role>`: added in this repository only. */
  readonly project: string | null;
}

export const NO_PROMPT_LAYERS: PromptLayers = { replace: null, append: '', project: null };

/** The headings the additions arrive under, as the agent reads them. */
export const PROMPT_LAYER_HEADINGS = {
  append: 'Additional instructions',
  project: 'Additional instructions for this repository',
} as const;

export function composeSystemPrompt(builtin: string, layers: PromptLayers): string {
  const base = layers.replace?.trim() ? layers.replace.trim() : builtin;
  return join(
    base,
    layers.append.trim() ? section(PROMPT_LAYER_HEADINGS.append, layers.append) : null,
    layers.project?.trim() ? section(PROMPT_LAYER_HEADINGS.project, layers.project) : null,
  );
}

/** Whether any layer changes the built-in prompt. */
export function hasPromptLayers(layers: PromptLayers): boolean {
  return Boolean(layers.replace?.trim() || layers.append.trim() || layers.project?.trim());
}

const TOOL_NAMES = [...new Set(Object.values(DEFAULT_TOOL_NAMES)), 'wait_for_reply'];

/**
 * Legion's tool names the built-in prompts mention that `replacement` no longer does: the agent still has the
 * tools, but nothing tells it when to use them (finishing a task without `mark_task_done` never ends it).
 * Matches by the plain name, so `mcp__legion__mark_task_done` counts too.
 */
export function missingToolNames(builtins: readonly string[], replacement: string): string[] {
  const used = TOOL_NAMES.filter((name) => builtins.some((text) => text.includes(`\`${name}\``)));
  return used.filter((name) => !new RegExp(`(^|[^a-z_]|__)${name}($|[^a-z_])`).test(replacement));
}
