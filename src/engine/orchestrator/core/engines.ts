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
 * Reviewers use the other engine than the coder; when that one is disabled, the same engine (the
 * lifecycle should then pick a different model and always uses a fresh session).
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
