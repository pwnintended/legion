import { z } from 'zod';
import { ReviewCriterionSchema, ReviewFindingSchema, ReviewVerdictSchema } from '../domain';
import { toStrictJsonSchema } from './json-schema';

/** Reviewer output (§5 Review shape without ids/timestamps). Also used for the final holistic review. */
export const ReviewOutputSchema = z.object({
  verdict: ReviewVerdictSchema,
  criteria: z.array(ReviewCriterionSchema),
  findings: z.array(ReviewFindingSchema),
  summary: z.string(),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const reviewOutputJsonSchema = toStrictJsonSchema(ReviewOutputSchema);
