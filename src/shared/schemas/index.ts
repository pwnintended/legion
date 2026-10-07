export * from './clarify';
export * from './json-schema';
export * from './plan';
export * from './review';
export * from './task-report';

import { clarifyOutputJsonSchema } from './clarify';
import { planOutputJsonSchema } from './plan';
import { reviewOutputJsonSchema } from './review';
import { taskReportJsonSchema } from './task-report';

/** Every JSON Schema handed to an agent, by name. */
export const AGENT_OUTPUT_JSON_SCHEMAS = {
  clarify: clarifyOutputJsonSchema,
  plan: planOutputJsonSchema,
  review: reviewOutputJsonSchema,
  taskReport: taskReportJsonSchema,
} as const;
