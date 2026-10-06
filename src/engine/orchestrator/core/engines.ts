/** Engine choice per role (architecture §1 "Engine per role"). */
import type { EngineKind, Settings, Task, TaskNode } from '@shared/domain';

export type EnabledEngines = { readonly claude: boolean; readonly codex: boolean };

export function enabledEngines(settings: Pick<Settings, 'engines'>): EnabledEngines {
  return { claude: settings.engines.claude.enabled, codex: settings.engines.codex.enabled };
}

/** The coder engine of a task: the user's override, else the plan's assignment. */
export function coderEngineFor(
  node: Pick<TaskNode, 'agent'>,
  task?: { readonly engineOverride?: Task['engineOverride'] | undefined } | null,
): EngineKind {
  return task?.engineOverride ?? node.agent.engine;
}

/**
 * Reviewers use the other engine than the coder; when that one is unavailable, the same engine (the
 * lifecycle then picks a different model, `fallbackReviewModel`, and always uses a fresh session).
 */
export function reviewerEngineFor(
  coder: EngineKind,
  enabled: EnabledEngines = { claude: true, codex: true },
): EngineKind {
  if (coder === 'fake') return 'fake';
  const other = coder === 'claude' ? 'codex' : 'claude';
  return enabled[other] ? other : coder;
}

/** Final holistic review: the engine other than the majority of coders (ties → codex reviews claude). */
export function finalizerEngineFor(
  coderEngines: readonly EngineKind[],
  enabled: EnabledEngines = { claude: true, codex: true },
): EngineKind {
  const real = coderEngines.filter((e) => e !== 'fake');
  if (real.length === 0 && coderEngines.length > 0) return 'fake';
  const claude = real.filter((e) => e === 'claude').length;
  const majority: EngineKind = claude >= real.length - claude ? 'claude' : 'codex';
  return reviewerEngineFor(majority, enabled);
}

const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
/** Same-engine review: the stronger sibling, or the other one of opus/sonnet. */
const CLAUDE_SWAP: Readonly<Record<string, string>> = {
  opus: 'sonnet',
  sonnet: 'opus',
  haiku: 'sonnet',
  fable: 'opus',
};

/** Comparable model identity: Claude aliases and full ids collapse to their family (`claude-opus-5-5` → opus). */
export function modelFamily(engine: EngineKind, model: string | null): string | null {
  if (!model) return null;
  const lower = model.trim().toLowerCase();
  if (engine === 'claude') return CLAUDE_FAMILIES.find((f) => lower.includes(f)) ?? lower;
  return lower;
}

/**
 * Model for a reviewer/finalizer that has to run on the coder's own engine (the other engine is
 * unavailable, §1 "fallback: same engine, different model"): the configured `fallbackReviewModel` unless
 * the coder already used it; then the Claude sibling (opus ↔ sonnet), or another model the engine's probe
 * lists. null = the CLI default (nothing better is known).
 */
export function fallbackReviewModel(
  engine: EngineKind,
  coderModel: string | null,
  configured: string | null,
  knownModels: readonly string[] = [],
): string | null {
  const coder = modelFamily(engine, coderModel);
  if (configured && (coder === null || modelFamily(engine, configured) !== coder)) return configured;
  if (engine === 'claude') {
    const swap = coder ? CLAUDE_SWAP[coder] : undefined;
    if (swap) return swap;
  }
  return knownModels.find((m) => modelFamily(engine, m) !== coder) ?? configured;
}
