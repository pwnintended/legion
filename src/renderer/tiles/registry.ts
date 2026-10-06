import { lazy } from 'react';
import type { TileDefinition, TileKind } from '../layout/types';

/**
 * Tile kind → lazily loaded component. Each kind lives in `tiles/<kind>/index.tsx` with a default
 * export of type `ComponentType<TileProps<kind>>`; replace the folder's contents, not this file.
 */
export const tileRegistry: { readonly [K in TileKind]: TileDefinition<K> } = {
  plan: { kind: 'plan', title: 'Plan', component: lazy(() => import('./plan')) },
  dag: { kind: 'dag', title: 'DAG', component: lazy(() => import('./dag')) },
  session: { kind: 'session', title: 'Session', component: lazy(() => import('./session')) },
  review: { kind: 'review', title: 'Review', component: lazy(() => import('./review')) },
  diff: { kind: 'diff', title: 'Diff', component: lazy(() => import('./diff')) },
  terminal: { kind: 'terminal', title: 'Terminal', component: lazy(() => import('./terminal')) },
  pr: { kind: 'pr', title: 'Pull request', component: lazy(() => import('./pr')) },
  integration: { kind: 'integration', title: 'Integration', component: lazy(() => import('./integration')) },
  clarify: { kind: 'clarify', title: 'Clarify', component: lazy(() => import('./clarify')) },
};

export function tileDefinition<K extends TileKind>(kind: K): TileDefinition<K> {
  return tileRegistry[kind] as TileDefinition<K>;
}
