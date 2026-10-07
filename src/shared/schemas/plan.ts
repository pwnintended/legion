import { z } from 'zod';
import { TaskNodeSchema } from '../domain';
import { toStrictJsonSchema } from './json-schema';

/** A DAG node as produced by the planner. Its `agent` holds the effort only: the user's settings pick the engine and model. */
export const PlanOutputNodeSchema = TaskNodeSchema;
export type PlanOutputNode = z.infer<typeof PlanOutputNodeSchema>;

/**
 * Planner plan step (§8.3): human-readable markdown plus the task DAG. Annotations are not part of the
 * agent output; `orchestrator/dag.ts` validates the nodes and produces a `PlanDag`.
 */
export const PlanOutputSchema = z.object({
  markdown: z.string().min(1),
  dag: z.object({ nodes: z.array(PlanOutputNodeSchema).min(1) }),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export const planOutputJsonSchema = toStrictJsonSchema(PlanOutputSchema);
