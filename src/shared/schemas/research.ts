import { z } from 'zod';
import { toStrictJsonSchema } from './json-schema';

/**
 * A research agent's final report (researcher and research lead), returned as structured output at the end of
 * the turn and posted to the agent's parent as a `report` message (`orchestrator/research.ts`).
 */
export const ResearchReportSchema = z.object({
  /** The answer to the brief in a few sentences. */
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      claim: z.string().min(1),
      /** What supports the claim: a file path and what it shows, a quote, a measurement. */
      evidence: z.string(),
      /** Repo-relative paths or URLs. */
      sources: z.array(z.string()),
    }),
  ),
  /** What could not be settled, phrased so the reader can decide whether it matters. */
  openQuestions: z.array(z.string()),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;

export const researchReportJsonSchema = toStrictJsonSchema(ResearchReportSchema);
