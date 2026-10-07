import { z } from 'zod';
import { CriterionStatusSchema } from '../domain';
import { toStrictJsonSchema } from './json-schema';

/**
 * Coder (and resolver) final report, returned as structured output at the end of the turn.
 * Legion commits the work using `commitMessage` (agents never commit).
 * - done: work complete, ready for verify + review.
 * - blocked: cannot proceed (explain in `summary`); escalates to the inbox.
 * - partial: stopped early (e.g. out of budget); Legion may resume or retry.
 */
export const TaskReportSchema = z.object({
  status: z.enum(['done', 'blocked', 'partial']),
  summary: z.string().min(1),
  commitMessage: z.string().min(1),
  criteria: z.array(
    z.object({
      id: z.string(),
      status: CriterionStatusSchema,
      evidence: z.string(),
    }),
  ),
  /** Anything the reviewer or a human should know (follow-ups, risky spots). */
  notes: z.string().nullable(),
});
export type TaskReport = z.infer<typeof TaskReportSchema>;

export const taskReportJsonSchema = toStrictJsonSchema(TaskReportSchema);
