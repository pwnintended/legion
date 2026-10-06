/**
 * zod → JSON Schema for agent structured output.
 *
 * Both Claude (`--json-schema`) and Codex (`outputSchema`, OpenAI strict mode) need a conservative,
 * draft-07 compatible subset:
 * - every object has `additionalProperties: false` and lists *all* its properties in `required`
 *   (model optionality with `.nullable()`, never `.optional()`);
 * - unions are `anyOf` (no `oneOf` / `allOf` / `not`);
 * - no validation keywords (min/max/pattern/format...). zod re-validates the output in the engine, so
 *   constraints stay in the zod schema and are simply not shown to the model.
 */
import { z } from 'zod';
import type { JsonSchema } from '../engine';

/** Keywords allowed in a strict schema. Anything else is stripped by `toStrictJsonSchema`. */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'title',
  '$ref',
  'definitions',
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rewrite(node: unknown, path: string): Json {
  if (Array.isArray(node)) return node.map((child, i) => rewrite(child, `${path}/${i}`));
  if (!isObject(node)) return node as Json;

  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'oneOf') {
      out.anyOf = rewrite(value, `${path}/anyOf`);
      continue;
    }
    if (!ALLOWED_KEYWORDS.has(key)) continue;
    if (key === 'properties' || key === 'definitions') {
      const props: Record<string, Json> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        props[name] = rewrite(child, `${path}/${key}/${name}`);
      }
      out[key] = props;
      continue;
    }
    out[key] = rewrite(value, `${path}/${key}`);
  }

  if (out.type === 'object' || out.properties !== undefined) {
    const props = (out.properties ?? {}) as Record<string, Json>;
    const required = new Set((out.required as string[] | undefined) ?? []);
    const missing = Object.keys(props).filter((name) => !required.has(name));
    if (missing.length > 0) {
      throw new Error(
        `toStrictJsonSchema: ${path || '/'} has optional properties [${missing.join(', ')}]; use .nullable() instead of .optional()`,
      );
    }
    if (isObject(node.additionalProperties)) {
      throw new Error(`toStrictJsonSchema: ${path || '/'} is a record/map; strict mode needs fixed properties`);
    }
    out.type = 'object';
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** Convert a zod schema to a strict-mode-friendly, draft-07 compatible JSON Schema. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: 'draft-07', io: 'output', unrepresentable: 'throw' });
  const strict = rewrite(raw, '');
  if (!isObject(strict) || strict.type !== 'object') {
    throw new Error('toStrictJsonSchema: the root must be an object schema');
  }
  return strict as JsonSchema;
}

/**
 * Check a JSON Schema against the strict rules. Returns a list of violations (empty = OK).
 * Used by tests and available to adapters as a cheap runtime guard.
 */
export function strictSchemaViolations(schema: unknown): string[] {
  const problems: string[] = [];
  const visit = (node: unknown, path: string): void => {
    const where = path || '/';
    if (!isObject(node)) {
      problems.push(`${where}: not a schema object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYWORDS.has(key)) problems.push(`${where}: keyword "${key}" not allowed`);
    }
    if (node.type === 'object' || node.properties !== undefined) {
      if (node.additionalProperties !== false) problems.push(`${where}: additionalProperties must be false`);
      const props = isObject(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      for (const name of props) {
        if (!required.includes(name)) problems.push(`${where}: property "${name}" not required`);
      }
    }
    const hasShape = ['type', 'enum', 'const', 'anyOf', '$ref'].some((k) => node[k] !== undefined);
    if (!hasShape) problems.push(`${where}: no type/enum/const/anyOf/$ref (accepts anything)`);

    for (const mapKey of ['properties', 'definitions'] as const) {
      const map = node[mapKey];
      if (isObject(map)) {
        for (const [name, child] of Object.entries(map)) visit(child, `${path}/${mapKey}/${name}`);
      }
    }
    if (node.items !== undefined) visit(node.items, `${path}/items`);
    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((child, i) => {
        visit(child, `${path}/anyOf/${i}`);
      });
    }
  };
  visit(schema, '');
  if (!isObject(schema) || schema.type !== 'object') problems.push('/: root must be type object');
  return problems;
}
