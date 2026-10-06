import type { JsonSchema } from '@shared/engine';
import type { ClarifyOutput, PlanOutput, ReviewOutput, TaskReport } from '@shared/schemas';

export const FAKE_CLARIFY_OUTPUT: ClarifyOutput = { questions: [] };

export const FAKE_PLAN_OUTPUT: PlanOutput = {
  markdown: '# Plan\n\n1. **T1** Add the change.\n2. **T2** Cover it with a test.\n',
  dag: {
    nodes: [
      {
        id: 'T1',
        title: 'Add the change',
        goal: 'Implement the requested change.',
        kind: 'feature',
        dependsOn: [],
        acceptanceCriteria: [{ id: 'AC1', text: 'The change exists.' }],
        touches: [{ glob: 'FAKE_CHANGE.md', mode: 'create' }],
        size: 'S',
        verify: { commands: ['test -f FAKE_CHANGE.md'] },
        contextHints: { files: [], notes: '' },
        agent: { engine: 'claude', model: null, effort: null },
        risk: 'low',
      },
      {
        id: 'T2',
        title: 'Cover it with a test',
        goal: 'Add a test for the change.',
        kind: 'test',
        dependsOn: ['T1'],
        acceptanceCriteria: [{ id: 'AC1', text: 'A test exists.' }],
        touches: [{ glob: 'FAKE_TEST.md', mode: 'create' }],
        size: 'S',
        verify: { commands: ['test -f FAKE_TEST.md'] },
        contextHints: { files: ['FAKE_CHANGE.md'], notes: '' },
        agent: { engine: 'codex', model: null, effort: null },
        risk: 'low',
      },
    ],
  },
};

export const FAKE_REVIEW_OUTPUT: ReviewOutput = {
  verdict: 'approve',
  criteria: [{ id: 'AC1', status: 'met', evidence: 'Checked by the fake reviewer.' }],
  findings: [],
  summary: 'Looks good.',
};

export const FAKE_TASK_REPORT: TaskReport = {
  status: 'done',
  summary: 'Made the change.',
  commitMessage: 'Make the change',
  criteria: [{ id: 'AC1', status: 'met', evidence: 'File written.' }],
  notes: null,
};

/**
 * Pick a plausible structured output for a strict schema by looking at its top-level properties
 * (clarify / plan / review / task report). Returns null for unknown schemas.
 */
export function fakeOutputFor(schema: JsonSchema | null | undefined): unknown {
  const props =
    schema && typeof schema.properties === 'object' && schema.properties !== null
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  if (props.includes('questions')) return FAKE_CLARIFY_OUTPUT;
  if (props.includes('dag')) return FAKE_PLAN_OUTPUT;
  if (props.includes('verdict')) return FAKE_REVIEW_OUTPUT;
  if (props.includes('commitMessage')) return FAKE_TASK_REPORT;
  return null;
}
