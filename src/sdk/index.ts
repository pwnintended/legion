/**
 * The workflow SDK: what a workflow file imports as `legion`.
 *
 * ```ts
 * import { workflow, agent, gate, z } from 'legion';
 *
 * export default workflow(
 *   { name: 'explain', description: 'Explain a part of the code', input: z.object({ topic: z.string() }) },
 *   async ({ topic }) => {
 *     const answer = await agent('explain', { mode: 'read', prompt: `Explain ${topic} in this repository.` });
 *     await gate('ok', { title: 'Happy with the explanation?', show: answer });
 *     return answer;
 *   },
 * );
 * ```
 *
 * Every primitive takes a step key first: the name the run journal records it under, so an interrupted run can
 * resume where it stopped. Keys must be unique within a run (inside `loop` rounds and `group`s they are scoped).
 * Code between steps re-runs on resume and must be deterministic.
 */
import { z } from 'zod';

export type { MergeResult, ShellResult, StepTier, Worktree } from '../workflow/host.ts';
export type { AgentOptions, AgentResult, GateOptions, GateResult, LoopResult, ShOptions } from '../workflow/runtime.ts';
export {
  agent,
  ask,
  box,
  gate,
  git,
  group,
  log,
  loop,
  parallel,
  runInfo,
  sh,
  step,
  WorkflowCancelled,
} from '../workflow/runtime.ts';
export { z };

export const WORKFLOW_BRAND = 'legion.workflow/v1';

export interface WorkflowMeta<I extends z.ZodType> {
  /** Short identifier; matches the file name by convention. */
  name: string;
  /** One line: what the workflow does and when to use it. */
  description: string;
  /** Input schema; `legion run <name> --input '<json>'` and the assistant validate against it. */
  input: I;
  /** A valid input, used by dry runs and shown as an example. */
  example?: z.infer<I>;
}

export interface WorkflowDefinition<I extends z.ZodType = z.ZodType, O = unknown> extends WorkflowMeta<I> {
  readonly brand: typeof WORKFLOW_BRAND;
  run(input: z.infer<I>): Promise<O>;
}

export function workflow<I extends z.ZodType, O>(
  meta: WorkflowMeta<I>,
  run: (input: z.infer<I>) => Promise<O>,
): WorkflowDefinition<I, O> {
  return { ...meta, brand: WORKFLOW_BRAND, run };
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { brand?: unknown }).brand === WORKFLOW_BRAND &&
    typeof (value as { run?: unknown }).run === 'function'
  );
}
