import type { DiffTarget } from '@shared/rpc';
import type { ComponentType } from 'react';

/** Every kind of tile the workspace can show (architecture §11). One folder per kind under tiles/. */
export const TILE_KINDS = [
  'plan',
  'dag',
  'session',
  'review',
  'diff',
  'terminal',
  'pr',
  'integration',
  'clarify',
] as const;
export type TileKind = (typeof TILE_KINDS)[number];

type None = Record<string, never>;

/** Per-kind parameters stored in the layout tree (must stay JSON-serializable). */
export interface TileParamsByKind {
  /** A plan version (null = latest). */
  plan: { planId: string | null };
  dag: None;
  /** An agent session: a specific attempt, or the latest attempt of a task. */
  session: { attemptId: string | null; taskId: string | null };
  /** Reviews of a task (null = final review of the run). */
  review: { taskId: string | null };
  diff: { target: DiffTarget };
  /** An existing terminal, or one to open in `cwd`. */
  terminal: { terminalId: string | null; cwd: string | null; attemptId: string | null };
  pr: None;
  integration: None;
  /** Clarify questions; an inbox item of kind `question`. */
  clarify: { inboxItemId: string | null };
}

/** A tile as stored in the layout tree. */
export interface TileDescriptor<K extends TileKind = TileKind> {
  id: string;
  kind: K;
  params: TileParamsByKind[K];
}

/** Props every tile component receives. */
export interface TileProps<K extends TileKind = TileKind> {
  tileId: string;
  kind: K;
  runId: string;
  params: TileParamsByKind[K];
  /** Keyboard focus is on this tile. */
  focused: boolean;
  /** On screen (tiles off-viewport should pause expensive rendering, e.g. WebGL terminals). */
  visible: boolean;
}

export interface TileDefinition<K extends TileKind = TileKind> {
  kind: K;
  /** Short label for headers, palette, tooltips. */
  title: string;
  component: ComponentType<TileProps<K>>;
}
