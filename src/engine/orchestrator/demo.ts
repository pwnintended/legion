/**
 * The scripted agent used in fake-engine mode (`LEGION_FAKE_ENGINES=1`): plausible, role-aware behaviour
 * so the whole pipeline (clarify → plan → coders → review → merge → PR) can be demoed without real CLIs.
 * It reads what it needs from the prompts Legion builds (task ids, touches, criteria).
 */
import type { PlanOutput, ReviewOutput, TaskReport } from '@shared/schemas';
import type { FakeScript, FakeStep } from '../adapters/fake';

const schemaProps = (schema: unknown): string[] => {
  const props = (schema as { properties?: Record<string, unknown> } | null | undefined)?.properties;
  return props ? Object.keys(props) : [];
};

export const DEMO_PLAN: PlanOutput = {
  markdown: [
    '# Plan',
    '',
    '## Summary',
    '',
    'A scripted demo plan: a core module, a feature built on it, and documentation.',
    '',
    '1. **T1** Add the core module.',
    '2. **T2** Build the feature on top of the core.',
    '3. **T3** Document the change.',
  ].join('\n'),
  dag: {
    nodes: [
      {
        id: 'T1',
        title: 'Add the core module',
        goal: 'Create the core module the feature builds on.',
        kind: 'contracts',
        dependsOn: [],
        acceptanceCriteria: [{ id: 'AC1', text: 'legion-demo/core.md exists.' }],
        touches: [{ glob: 'legion-demo/core.md', mode: 'create' }],
        size: 'S',
        verify: { commands: ['test -f legion-demo/core.md'] },
        contextHints: { files: [], notes: '' },
        agent: { engine: 'claude', model: null, effort: null },
        risk: 'low',
      },
      {
        id: 'T2',
        title: 'Build the feature',
        goal: 'Implement the feature using the core module.',
        kind: 'feature',
        dependsOn: ['T1'],
        acceptanceCriteria: [{ id: 'AC1', text: 'legion-demo/feature.md exists.' }],
        touches: [{ glob: 'legion-demo/feature.md', mode: 'create' }],
        size: 'M',
        verify: { commands: ['test -f legion-demo/feature.md'] },
        contextHints: { files: ['legion-demo/core.md'], notes: '' },
        agent: { engine: 'codex', model: null, effort: null },
        risk: 'low',
      },
      {
        id: 'T3',
        title: 'Document the change',
        goal: 'Write the documentation.',
        kind: 'docs',
        dependsOn: [],
        acceptanceCriteria: [{ id: 'AC1', text: 'legion-demo/docs.md exists.' }],
        touches: [{ glob: 'legion-demo/docs.md', mode: 'create' }],
        size: 'S',
        verify: { commands: ['test -f legion-demo/docs.md'] },
        contextHints: { files: [], notes: '' },
        agent: { engine: 'claude', model: null, effort: null },
        risk: 'low',
      },
    ],
  },
};

/** First `` `path` (create|modify) `` touch in a coder prompt. */
export function firstWriteTouch(prompt: string): string | null {
  const match = /`([^`*?[\]{}]+)` \((?:create|modify)\)/.exec(prompt);
  return match?.[1] ?? null;
}

/** Acceptance criterion ids mentioned in a prompt (`**AC1**`). */
export function criterionIds(prompt: string): string[] {
  const ids = new Set<string>();
  for (const m of prompt.matchAll(/\*\*(AC\d+|R\d+)\*\*/g)) if (m[1]) ids.add(m[1]);
  return ids.size > 0 ? [...ids] : ['AC1'];
}

export function taskIdIn(prompt: string): string {
  return /\btask (T\d+)/.exec(prompt)?.[1] ?? 'T?';
}

const usage = (cost: number): FakeStep => ({
  kind: 'usage',
  inputTokens: Math.round(cost * 400_000),
  outputTokens: Math.round(cost * 40_000),
  costUsd: cost,
});

export const demoScript: FakeScript = (ctx) => {
  const props = schemaProps(ctx.opts.outputSchema);
  const role = ctx.opts.role;
  if (role === 'planner' && props.includes('questions')) {
    return [
      { kind: 'reasoning', text: 'Skimming the repository layout.' },
      { kind: 'tool', name: 'Glob', toolKind: 'read', input: { pattern: '**/*' }, output: 'README.md' },
      usage(0.02),
      {
        kind: 'output',
        value: {
          questions: [
            {
              id: 'q1',
              question: 'Should the change also be documented?',
              options: ['Yes, add docs', 'No docs needed'],
            },
          ],
        },
      },
    ];
  }
  if (role === 'planner') {
    return [
      { kind: 'text', text: 'Exploring the code base and drafting the task graph.' },
      { kind: 'tool', name: 'Read', toolKind: 'read', input: { path: 'README.md' }, output: '# readme' },
      usage(0.05),
      { kind: 'output', value: DEMO_PLAN },
    ];
  }
  if (role === 'coder' || role === 'resolver') {
    const id = taskIdIn(ctx.message);
    const path = firstWriteTouch(ctx.message) ?? `legion-demo/${id}.md`;
    const report: TaskReport = {
      status: 'done',
      summary: `Implemented ${id} by writing \`${path}\`.`,
      commitMessage: `Implement ${id}`,
      criteria: criterionIds(ctx.message).map((cid) => ({ id: cid, status: 'met', evidence: `${path} written` })),
      notes: null,
    };
    return [
      { kind: 'text', text: `Working on ${id}.` },
      {
        kind: 'emit',
        event: { type: 'todo', items: [{ text: `Write ${path}`, status: 'in_progress' }] },
      },
      { kind: 'tool', name: 'Read', toolKind: 'read', input: { path: 'README.md' }, output: '# readme' },
      ...(role === 'coder'
        ? ([{ kind: 'write_file', path, content: `# ${id}\n\nWritten by the scripted demo coder.\n` }] as FakeStep[])
        : []),
      { kind: 'tool', name: 'Bash', toolKind: 'command', input: { command: 'test -f' }, output: '' },
      usage(0.08),
      { kind: 'output', value: report },
    ];
  }
  const review: ReviewOutput = {
    verdict: 'approve',
    criteria: criterionIds(ctx.message).map((cid) => ({ id: cid, status: 'met', evidence: 'Checked the diff.' })),
    findings: [
      {
        severity: 'nit',
        file: null,
        line: null,
        title: 'Consider a short example',
        body: 'An example would make the change easier to follow.',
        suggestedFix: null,
      },
    ],
    summary: 'The change does what the task asks. Scripted demo review.',
  };
  return [
    { kind: 'text', text: 'Reviewing the diff.' },
    { kind: 'tool', name: 'Bash', toolKind: 'command', input: { command: 'git diff' }, output: '' },
    usage(0.03),
    { kind: 'output', value: review },
  ];
};
