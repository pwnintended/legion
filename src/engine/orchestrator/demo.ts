/**
 * The scripted agent used in fake-engine mode (`LEGION_FAKE_ENGINES=1`): plausible, role-aware behaviour
 * so the whole pipeline (clarify → plan → coders → review → merge → PR) can be demoed without real CLIs.
 * It reads what it needs from the prompts Legion builds (task ids, touches, criteria).
 *
 * One run exercises every human touch point once: one clarify question, a 3-task plan (T2 depends on T1),
 * one tool approval (T3's coder asks to run a linter), one review with a major finding (T2's first review)
 * that the fix round resolves (the re-review approves), then the PR gate.
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

/** The task whose first review asks for changes (major finding), and the one whose coder asks for approval. */
export const DEMO_FIX_TASK = 'T2';
export const DEMO_APPROVAL_TASK = 'T3';
const DEMO_FINDING_TITLE = 'The feature doc has no usage example';

/** First file named by a finding in a fixer prompt (`— \`path:line\``). */
function findingFile(prompt: string): string | null {
  return /— `([^`:]+)(?::\d+)?`/.exec(prompt)?.[1] ?? null;
}

const usage = (cost: number): FakeStep => ({
  kind: 'usage',
  inputTokens: Math.round(cost * 400_000),
  outputTokens: Math.round(cost * 40_000),
  costUsd: cost,
});

/** The demo agent says which attachments it received (the E2E test reads it in the planner's session). */
function attachmentSteps(ctx: Parameters<FakeScript>[0]): FakeStep[] {
  if (ctx.attachments.length === 0) return [];
  const names = ctx.attachments.map((a) => `${a.name} (${a.kind})`).join(', ');
  return [
    {
      kind: 'text',
      text: `Received ${ctx.attachments.length} attachment${ctx.attachments.length === 1 ? '' : 's'}: ${names}.`,
    },
  ];
}

export const demoScript: FakeScript = (ctx) => {
  const props = schemaProps(ctx.opts.outputSchema);
  const role = ctx.opts.role;
  if (role === 'planner' && props.includes('questions')) {
    return [
      ...attachmentSteps(ctx),
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
  if (role === 'lead') {
    return [{ kind: 'text', text: ctx.turn === 0 ? 'Plan read; standing by for my coders.' : 'Noted.' }, usage(0.004)];
  }
  if (role === 'planner') {
    return [
      ...attachmentSteps(ctx),
      { kind: 'text', text: 'Exploring the code base and drafting the task graph.' },
      { kind: 'tool', name: 'Read', toolKind: 'read', input: { path: 'README.md' }, output: '# readme' },
      usage(0.05),
      { kind: 'output', value: DEMO_PLAN },
    ];
  }
  if (role === 'coder' && ctx.message.startsWith('Fix round')) {
    const id = taskIdIn(ctx.message);
    const path = findingFile(ctx.message) ?? firstWriteTouch(ctx.message) ?? `legion-demo/${id}.md`;
    const report: TaskReport = {
      status: 'done',
      summary: `Addressed the review of ${id}: added a usage example to \`${path}\`.`,
      commitMessage: `Implement ${id}`,
      criteria: criterionIds(ctx.message).map((cid) => ({ id: cid, status: 'met', evidence: `${path} updated` })),
      notes: null,
    };
    return [
      { kind: 'text', text: `Fixing the review findings of ${id}.` },
      {
        kind: 'write_file',
        path,
        content: `# ${id}\n\nWritten by the scripted demo coder.\n\n## Usage\n\n    legion-demo --example\n`,
      },
      usage(0.04),
      { kind: 'output', value: report },
    ];
  }
  if (role === 'coder' || role === 'resolver') {
    const id = taskIdIn(ctx.message);
    const path = firstWriteTouch(ctx.message) ?? `legion-demo/${id}.md`;
    const lint = `npx markdownlint-cli2 ${path}`;
    const approval: FakeStep[] =
      role === 'coder' && id === DEMO_APPROVAL_TASK && !ctx.resumed
        ? [
            {
              kind: 'approval',
              tool: 'Bash',
              input: { command: lint, description: 'Lint the new documentation' },
              reason: `Run ${lint} (not one of the task's verify commands)`,
              requestId: `demo-approval-${id}`,
              onAllow: [
                { kind: 'tool', name: 'Bash', toolKind: 'command', input: { command: lint }, output: '0 error(s)' },
              ],
            },
          ]
        : [];
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
      ...approval,
      { kind: 'tool', name: 'Bash', toolKind: 'command', input: { command: 'test -f' }, output: '' },
      usage(0.08),
      { kind: 'output', value: report },
    ];
  }
  const reviewed = taskIdIn(ctx.message);
  if (role === 'reviewer' && reviewed === DEMO_FIX_TASK && !ctx.message.includes('Re-review after fix round')) {
    const changes: ReviewOutput = {
      verdict: 'request_changes',
      criteria: criterionIds(ctx.message).map((cid) => ({ id: cid, status: 'met', evidence: 'The file exists.' })),
      findings: [
        {
          severity: 'major',
          file: 'legion-demo/feature.md',
          line: 1,
          title: DEMO_FINDING_TITLE,
          body: 'Callers have nothing to copy from; the feature is unusable without reading the code.',
          suggestedFix: 'Add a short "Usage" section with one example invocation.',
        },
      ],
      summary: 'The feature is in place but undocumented for callers. One major finding; a fix round should do.',
    };
    return [
      { kind: 'text', text: 'Reviewing the diff.' },
      { kind: 'tool', name: 'Bash', toolKind: 'command', input: { command: 'git diff' }, output: '' },
      usage(0.03),
      { kind: 'output', value: changes },
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
