import { z } from 'zod';
import { ClarifyQuestionSchema } from '../domain';
import { toStrictJsonSchema } from './json-schema';

/**
 * Planner clarify step (§8.2): 0–5 questions for the human. An empty list means "no questions,
 * go straight to planning".
 */
export const ClarifyOutputSchema = z.object({
  questions: z.array(ClarifyQuestionSchema).max(5),
});
export type ClarifyOutput = z.infer<typeof ClarifyOutputSchema>;

export const clarifyOutputJsonSchema = toStrictJsonSchema(ClarifyOutputSchema);
