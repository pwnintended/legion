import type { ReviewFinding } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { checkScope } from '../scope';
import { makeNode } from '../testing';
import {
  type AgentPrompt,
  buildClarifyPrompt,
  buildCoderPrompt,
  buildFinalizerPrompt,
  buildFixerPrompt,
  buildLeadPrompt,
  buildLeadWakePrompt,
  buildPlanPrompt,
  buildPrBody,
  buildPrTitle,
  buildResolverPrompt,
  buildReviewerPrompt,
  clipMiddle,
  DEFAULT_TOOL_NAMES,
  demoteHeadings,
  fence,
  markdownSection,
  PR_BODY_MAX_CHARS,
  PROMPT_LIMITS,
  type PrBodyInput,
} from './index';

const issue = {
  title: 'Add CSV export to the reports page',
  text: 'Users want to download the monthly report as CSV.\n\nThe export must respect the active filters.',
  url: 'https://github.com/acme/app/issues/42',
};
const repo = {
  baseRef: 'main',
  verifyCommands: ['pnpm typecheck', 'pnpm lint'],
  setupCommands: ['pnpm install --frozen-lockfile'],
  installCommand: 'pnpm install',
  conventions: 'TypeScript strict. Tests live next to the code as *.test.ts (vitest).',
};
const contracts = makeNode('T1', [], {
  kind: 'contracts',
  title: 'Define the export contract',
  size: 'S',
  touches: [{ glob: 'src/reports/export.ts', mode: 'create' }],
});
const node = makeNode('T2', ['T1'], {
  title: 'Implement CSV serialization',
  goal: 'Serialize report rows to RFC 4180 CSV so the export endpoint can stream them.',
  acceptanceCriteria: [
    { id: 'AC1', text: '`toCsv` quotes fields containing commas, quotes or newlines.' },
    { id: 'AC2', text: 'Unit tests cover quoting and an empty report.' },
  ],
  touches: [
    { glob: 'src/reports/csv.ts', mode: 'create' },
    { glob: 'src/reports/csv.test.ts', mode: 'create' },
    { glob: 'src/reports/export.ts', mode: 'read' },
  ],
  verify: { commands: ['pnpm vitest run src/reports/csv.test.ts'] },
  contextHints: { files: ['src/reports/export.ts'], notes: 'Use the `ReportRow` type from T1.' },
});
const upstream = [
  {
    nodeId: 'T1',
    title: contracts.title,
    summary: 'Added `ReportRow` and `ExportFormat`.',
    files: ['src/reports/export.ts'],
  },
];
const planSummary = '## Summary\n\nAdd a CSV export: a contract (T1), the serializer (T2) and the endpoint (T3).';
const blocker: ReviewFinding = {
  severity: 'blocker',
  file: 'src/reports/csv.ts',
  line: 12,
  title: 'Newlines are not quoted',
  body: 'A field containing `\\n` is emitted raw, which splits the row.',
  suggestedFix: 'Quote fields matching /[",\\n\\r]/.',
};
const verifyFail = {
  command: 'pnpm vitest run src/reports/csv.test.ts',
  exitCode: 1,
  outputTail: 'FAIL csv.test.ts > quotes newlines',
  durationMs: 2300,
};

const ENGINE_SPECIFIC = [/mcp__/, /\bapply_patch\b/, /\b(Read|Grep|Glob|Bash|Edit|Write)\b tool/, /\bTodoWrite\b/];

function expectEngineNeutral(prompt: AgentPrompt) {
  for (const pattern of ENGINE_SPECIFIC) {
    expect(prompt.systemPrompt).not.toMatch(pattern);
    expect(prompt.prompt).not.toMatch(pattern);
  }
}

describe('planner prompts', () => {
  it('clarify', () => {
    const prompt = buildClarifyPrompt({ issue, repo });
    expect(prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
    expect(buildClarifyPrompt({ issue, repo, maxQuestions: 9 }).prompt).toContain('at most 5 questions');
    expect(buildClarifyPrompt({ issue, repo, maxQuestions: 1 }).prompt).toContain('at most 1 question;');
  });

  it('plan', () => {
    const prompt = buildPlanPrompt({
      issue,
      repo,
      answers: [{ question: 'Include archived reports?', answer: 'No' }],
      engines: { available: ['claude', 'codex'], defaultCoder: 'claude' },
    });
    expect(prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
    expect(prompt.prompt).toContain('`pnpm typecheck`, `pnpm lint` on every task');
  });

  it('plan revision after feedback and validation errors', () => {
    const prompt = buildPlanPrompt({
      issue,
      repo: { baseRef: 'main' },
      answers: [],
      engines: { available: ['codex'], defaultCoder: 'codex' },
      maxTasks: 4,
      revision: { previousMarkdown: '# Old plan', previousNodes: [contracts], feedback: 'Merge T2 and T3.' },
      validationErrors: ['T3 has no verify command.'],
    });
    expect(prompt.prompt).toMatchSnapshot();
    expect(prompt.prompt).toContain('Merge T2 and T3.');
    expect(prompt.prompt).toContain('- T3 has no verify command.');
    expect(prompt.prompt).toContain('Use at most 4 tasks.');
  });
});

describe('coder prompts', () => {
  it('coder', () => {
    const prompt = buildCoderPrompt({ issue, repo, node, planSummary, upstream, attempt: 1 });
    expect(prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
    expect(prompt.systemPrompt).toContain('`mark_task_done`');
    expect(prompt.prompt).not.toContain('This is attempt');
  });

  it('coder retry with custom tool names and a structured report', () => {
    const tools = {
      ...DEFAULT_TOOL_NAMES,
      markTaskDone: 'legion.done',
      requestHumanInput: 'legion.ask',
      reportProgress: 'legion.progress',
    };
    const prompt = buildCoderPrompt({
      issue,
      repo,
      node,
      planSummary,
      upstream: [],
      attempt: 2,
      previousFailure: 'Verify failed: csv.test.ts missing',
      tools,
      structuredReport: true,
    });
    expect(prompt.prompt).toContain('## This is attempt 2');
    expect(prompt.prompt).toContain('Call `legion.done`');
    expect(prompt.systemPrompt).toContain('`legion.ask`');
    expect(prompt.systemPrompt).not.toContain('mark_task_done');
    expect(prompt.prompt).toContain('final task report as structured output');
    expect(prompt.prompt).toContain('No upstream tasks');
  });

  it('fixer', () => {
    const prompt = buildFixerPrompt({
      node,
      findings: [blocker],
      unmetCriteria: [{ id: 'AC1', status: 'unmet', evidence: 'newline case fails' }],
      failedVerify: [verifyFail],
      round: 1,
      maxRounds: 2,
    });
    expect(prompt.prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
  });

  it('fixer after a failed post-merge verification', () => {
    const prompt = buildFixerPrompt({
      node,
      findings: [],
      unmetCriteria: [],
      failedVerify: [verifyFail],
      round: 2,
      maxRounds: 2,
      mergedIntegrationRef: 'legion/abc12345/integration',
      humanNote: 'Keep the old header order.',
    });
    expect(prompt.prompt).toContain('Legion has merged `legion/abc12345/integration` into your branch');
    expect(prompt.prompt).toContain('## Note from the human');
    expect(prompt.prompt).not.toContain('Review findings');
  });

  it('resolver', () => {
    const prompt = buildResolverPrompt({
      node,
      otherNodes: [makeNode('T3', ['T1'], { title: 'Add the export endpoint' })],
      conflictFiles: ['src/reports/index.ts', 'pnpm-lock.yaml'],
      integrationRef: 'legion/abc12345/integration',
      installCommand: 'pnpm install',
      attempt: 1,
    });
    expect(prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
  });
});

describe('review prompts', () => {
  const diff = 'diff --git a/src/reports/csv.ts b/src/reports/csv.ts\n+export function toCsv() {}\n';

  it('reviewer', () => {
    const prompt = buildReviewerPrompt({
      issue,
      node,
      planSummary,
      upstream,
      diff,
      startSha: 'abc1234',
      verify: [{ command: 'pnpm vitest run src/reports/csv.test.ts', exitCode: 0, outputTail: 'ok', durationMs: 1200 }],
      scope: checkScope(node, ['src/reports/csv.ts', 'src/reports/csv.test.ts', 'src/app.ts']),
      coderSummary: 'Added toCsv with RFC 4180 quoting.',
      round: 0,
    });
    expect(prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
    expect(prompt.prompt).toContain('Out of scope: `src/app.ts`');
  });

  it('reviewer re-review clips huge diffs', () => {
    const huge = `${'+x\n'.repeat(PROMPT_LIMITS.diffChars)}`;
    const prompt = buildReviewerPrompt({
      issue,
      node,
      planSummary,
      upstream: [],
      diff: huge,
      startSha: 'abc1234',
      verify: [],
      scope: checkScope(node, []),
      round: 1,
      previousFindings: [blocker],
    });
    expect(prompt.prompt).toContain('## Re-review after fix round 1');
    expect(prompt.prompt).toContain('characters omitted');
    expect(prompt.prompt.length).toBeLessThan(PROMPT_LIMITS.diffChars + 20_000);
  });

  it('finalizer', () => {
    const prompt = buildFinalizerPrompt({
      issue,
      planMarkdown: planSummary,
      baseRef: 'main',
      integrationRef: 'legion/abc12345/integration',
      tasks: [
        { node: contracts, status: 'merged', summary: 'Added the contract.', verdict: 'approve' },
        { node, status: 'merged', summary: 'Added toCsv.', verdict: 'approve' },
        {
          node: makeNode('T3', ['T1'], { title: 'Add the export endpoint' }),
          status: 'skipped',
          summary: null,
          verdict: null,
        },
      ],
      diffStat: ' src/reports/csv.ts | 40 ++++\n 1 file changed',
      diff,
      verify: [{ command: 'pnpm test', exitCode: 0, outputTail: '', durationMs: 9000 }],
    });
    expect(prompt).toMatchSnapshot();
    expectEngineNeutral(prompt);
  });
});

describe('formatting helpers', () => {
  it('fences text containing backticks safely', () => {
    expect(fence('a ``` b', 'md')).toBe('````md\na ``` b\n````');
    expect(fence('plain')).toBe('```\nplain\n```');
  });

  it('nests embedded markdown headings, leaving code blocks alone', () => {
    const md = '# Plan\n## Summary\ntext\n```md\n# not a heading\n```\n###### deep';
    expect(demoteHeadings(md)).toBe('### Plan\n#### Summary\ntext\n```md\n# not a heading\n```\n###### deep');
  });

  it('extracts a markdown section', () => {
    const md = '# Plan\n\n## Summary\n\nDoes X.\n\n### Detail\n\nmore\n\n## Approach\n\nY';
    expect(markdownSection(md, 'summary')).toBe('Does X.\n\n### Detail\n\nmore');
    expect(markdownSection(md, 'Approach')).toBe('Y');
    expect(markdownSection(md, 'Risks')).toBeNull();
  });

  it('clips the middle of long text', () => {
    const clipped = clipMiddle('x'.repeat(10_000), 1_000);
    expect(clipped.length).toBeLessThanOrEqual(1_000);
    expect(clipped).toContain('characters omitted');
    expect(clipMiddle('short', 10)).toBe('short');
  });
});

describe('PR body', () => {
  const base: PrBodyInput = {
    runId: 'run_k3x9a0q2m7bz',
    title: 'Add CSV export to the reports page',
    issueUrl: issue.url,
    closes: '#42',
    baseRef: 'main',
    integrationBranch: 'legion/k3x9a0q2/integration',
    summary: 'Adds a CSV export that respects the active filters.',
    tasks: [
      {
        nodeId: 'T1',
        title: 'Define the export contract',
        status: 'merged',
        coderEngine: 'claude',
        reviewerEngine: 'codex',
        verdict: 'approve',
        fixRounds: 0,
      },
      {
        nodeId: 'T2',
        title: 'Serialize | quote CSV',
        status: 'merged',
        coderEngine: 'codex',
        reviewerEngine: 'claude',
        verdict: 'approve',
        fixRounds: 1,
      },
      {
        nodeId: 'T3',
        title: 'Add the endpoint',
        status: 'skipped',
        coderEngine: 'claude',
        reviewerEngine: null,
        verdict: null,
        fixRounds: 0,
      },
    ],
    verification: [
      { command: 'pnpm test', exitCode: 0, outputTail: '', durationMs: 12_345 },
      { command: 'pnpm lint', exitCode: 1, outputTail: 'src/a.ts:1 unused import', durationMs: 800 },
    ],
    minorFindings: [{ nodeId: 'T2', finding: { ...blocker, severity: 'minor', title: 'Consider streaming' } }],
    notes: ['T3 was skipped by the user.'],
  };

  it('renders title and body', () => {
    const pr = buildPrBody(base);
    expect(pr.truncated).toBe(false);
    expect(pr.title).toBe('Add CSV export to the reports page');
    expect(pr.body).toMatchSnapshot();
    expect(pr.body.startsWith('Closes #42')).toBe(true);
    expect(pr.body).toContain('| T2 | Serialize \\| quote CSV | merged | codex | claude | approve | 1 |');
  });

  it('builds short titles with an optional prefix', () => {
    expect(buildPrTitle('Fix it', 'fix')).toBe('fix: Fix it');
    const long = buildPrTitle('x'.repeat(200));
    expect(long).toHaveLength(70);
    expect(long.endsWith('…')).toBe(true);
    expect(buildPrTitle('  ')).toBe('Legion run');
  });

  it("stays within GitHub's body limit", () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({
      nodeId: 'T2',
      finding: { ...blocker, severity: 'minor' as const, title: `Finding ${i}`, body: 'y'.repeat(400) },
    }));
    const pr = buildPrBody({ ...base, summary: 's'.repeat(50_000), minorFindings: many });
    expect(pr.body.length).toBeLessThanOrEqual(PR_BODY_MAX_CHARS);
    expect(pr.truncated).toBe(true);
    expect(pr.body).toContain('| T1 |');

    const absurd = buildPrBody({ ...base, notes: Array.from({ length: 5_000 }, () => 'n'.repeat(100)) });
    expect(absurd.body.length).toBeLessThanOrEqual(PR_BODY_MAX_CHARS);
    expect(absurd.truncated).toBe(true);
  });
});

describe('lead prompts', () => {
  it('brief the lead with the plan and wake it with changes, messages and the board', () => {
    const first = buildLeadPrompt({
      issue,
      planMarkdown: '# Plan\n\n## Summary\n\nShip CSV export.',
      nodes: [contracts, node],
    });
    expect(first.systemPrompt).toContain('implementation lead');
    expect(first.systemPrompt).toContain('`add_task`');
    expect(first.systemPrompt).toContain('Never call `wait_for_reply`');
    expect(first.prompt).toContain('## Approved plan');
    expect(first.prompt).toContain('**T2** Implement CSV serialization (feature, M, risk low, after T1)');
    const wake = buildLeadWakePrompt({
      messages:
        '## Messages from other agents (1)\n\n### Question from coder of T2 (att_1) · id msg_1\n\nWhich delimiter?',
      changes: ['T1 running → merged: Defined the contract.'],
      board: [
        {
          nodeId: 'T1',
          title: 'Define the export contract',
          status: 'merged',
          dependsOn: [],
          progress: null,
          error: null,
          summary: 'Defined the contract.',
        },
        {
          nodeId: 'T2',
          title: 'Implement CSV serialization',
          status: 'running',
          dependsOn: ['T1'],
          progress: 'writing tests',
          error: null,
          summary: null,
        },
      ],
    });
    expect(wake.prompt).toContain('## Board changes\n\n- T1 running → merged: Defined the contract.');
    expect(wake.prompt).toContain('Which delimiter?');
    expect(wake.prompt).toContain('**T2** Implement CSV serialization (after T1): running — writing tests');
    expect(wake.prompt).toContain('reply_to');
  });

  it('tells coders about ask_lead only when they have a lead', () => {
    const base = { issue, repo, node, planSummary, upstream: [], attempt: 1 };
    expect(buildCoderPrompt({ ...base, lead: true }).systemPrompt).toContain('`ask_lead`');
    expect(buildCoderPrompt(base).systemPrompt).not.toContain('ask_lead');
  });
});
