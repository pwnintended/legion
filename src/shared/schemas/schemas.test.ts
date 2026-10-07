import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_OUTPUT_JSON_SCHEMAS,
  ClarifyOutputSchema,
  type PlanOutput,
  PlanOutputSchema,
  strictSchemaViolations,
  toStrictJsonSchema,
} from './index';

const VALID_PLAN: PlanOutput = {
  markdown: '# Plan',
  dag: {
    nodes: [
      {
        id: 'T1',
        title: 'Do it',
        goal: 'Do the thing',
        kind: 'feature',
        dependsOn: [],
        acceptanceCriteria: [{ id: 'AC1', text: 'done' }],
        touches: [{ glob: 'src/**', mode: 'modify' }],
        size: 'S',
        verify: { commands: ['pnpm test'] },
        contextHints: { files: [], notes: '' },
        agent: { effort: 'low' },
        risk: 'low',
      },
    ],
  },
};

describe('agent output JSON schemas', () => {
  for (const [name, schema] of Object.entries(AGENT_OUTPUT_JSON_SCHEMAS)) {
    it(`${name} satisfies the strict-mode rules`, () => {
      expect(strictSchemaViolations(schema)).toEqual([]);
      expect(schema.type).toBe('object');
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      expect(schema).not.toHaveProperty('$schema');
    });
  }

  it('plan schema exposes nullable effort as anyOf with null', () => {
    const json = JSON.stringify(AGENT_OUTPUT_JSON_SCHEMAS.plan);
    expect(json).toContain('"anyOf"');
    expect(json).not.toContain('"oneOf"');
    expect(json).not.toContain('"pattern"');
    expect(json).not.toContain('"maxItems"');
  });

  it('plan schema leaves the engine and the model to the settings', () => {
    const json = JSON.stringify(AGENT_OUTPUT_JSON_SCHEMAS.plan);
    expect(json).not.toContain('"engine"');
    expect(json).not.toContain('"model"');
    // A planner that still sends them is not rejected; they are dropped.
    const sent = structuredClone(VALID_PLAN);
    Object.assign(sent.dag.nodes[0]?.agent ?? {}, { engine: 'codex', model: 'gpt-6.1-sol' });
    expect(PlanOutputSchema.parse(sent).dag.nodes[0]?.agent).toEqual({ effort: 'low' });
  });

  it('zod still enforces constraints that are stripped from the JSON schema', () => {
    const tooMany = { questions: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: 'x?', options: [] })) };
    expect(ClarifyOutputSchema.safeParse(tooMany).success).toBe(false);
    const badId = structuredClone(VALID_PLAN);
    const first = badId.dag.nodes[0];
    if (!first) throw new Error('fixture has nodes');
    first.id = 'task-1';
    expect(PlanOutputSchema.safeParse(badId).success).toBe(false);
    expect(PlanOutputSchema.safeParse(VALID_PLAN).success).toBe(true);
  });
});

describe('toStrictJsonSchema', () => {
  it('rejects optional properties', () => {
    expect(() => toStrictJsonSchema(z.object({ a: z.string().optional() }))).toThrow(/optional/);
  });

  it('rejects records', () => {
    expect(() => toStrictJsonSchema(z.object({ a: z.record(z.string(), z.number()) }))).toThrow(/record/);
  });

  it('rejects non-object roots', () => {
    expect(() => toStrictJsonSchema(z.array(z.string()))).toThrow(/root/);
  });

  it('turns discriminated unions into anyOf and closes every object', () => {
    const schema = toStrictJsonSchema(
      z.object({
        u: z.discriminatedUnion('t', [
          z.object({ t: z.literal('a') }),
          z.object({ t: z.literal('b'), n: z.number().min(1) }),
        ]),
      }),
    );
    expect(strictSchemaViolations(schema)).toEqual([]);
    expect(JSON.stringify(schema)).not.toContain('minimum');
  });

  it('flags violations in hand-written schemas', () => {
    const problems = strictSchemaViolations({
      type: 'object',
      properties: { a: { type: 'string' }, b: {} },
      required: ['a'],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        '/: additionalProperties must be false',
        '/: property "b" not required',
        '/properties/b: no type/enum/const/anyOf/$ref (accepts anything)',
      ]),
    );
  });
});
