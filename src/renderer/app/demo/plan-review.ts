/**
 * Demo-mode data and behaviour for the plan, DAG, review, diff, integration and PR tiles:
 * - i18n run: a richer plan v1 awaiting sign-off, with an auto-serialized overlap (T3 → T4) and answered
 *   clarify questions;
 * - passkeys run: T4's review pack (round-1 findings, a fix round, and with `stage=gate` an approving round 2
 *   that waits for the human gate because migrations are high-risk), verify evidence and diff data;
 * - PDF run: merges, post-merge/final verification, a final review and a generated PR body;
 * - RPCs: runs.updatePlan / requestPlanRevision / createPr, tasks.approveMerge / requestChanges, diff.get.
 *
 * `?stage=gate` (or `localStorage['legion.demo.stage'] = 'gate'`) starts T4 at the human merge gate.
 */
import { validatePlan } from '@engine/orchestrator/core/dag';
import type { Attempt, InboxItem, Merge, Plan, Review, Run, Task, TaskNode, Verification } from '@shared/domain';
import type { AgentEvent, ServerEventBody } from '@shared/events';
import type { DiffTarget, ProcedureName } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { demoDiffs } from './diffs';
import type { DemoWorld } from './fixtures';

const MIN = 60_000;
const A = 'run_authv2demo01';
const B = 'run_pdfexport001';
const C = 'run_i18nextract1';

export type DemoStage = 'fixing' | 'gate';

export function demoStage(): DemoStage {
  try {
    const param = new URLSearchParams(location.search).get('stage');
    const stored = localStorage.getItem('legion.demo.stage');
    return (param ?? stored) === 'gate' ? 'gate' : 'fixing';
  } catch {
    return 'fixing';
  }
}

function node(spec: {
  id: string;
  title: string;
  goal: string;
  kind: TaskNode['kind'];
  dependsOn: string[];
  size: TaskNode['size'];
  engine: 'claude' | 'codex';
  touches: [TaskNode['touches'][number]['mode'], string][];
  criteria: string[];
  verify: string[];
  risk?: TaskNode['risk'];
}): TaskNode {
  return {
    id: spec.id,
    title: spec.title,
    goal: spec.goal,
    kind: spec.kind,
    dependsOn: spec.dependsOn,
    acceptanceCriteria: spec.criteria.map((text, i) => ({ id: `AC${i + 1}`, text })),
    touches: spec.touches.map(([mode, glob]) => ({ glob, mode })),
    size: spec.size,
    verify: { commands: spec.verify },
    contextHints: { files: [], notes: '' },
    agent: { engine: spec.engine, model: null, effort: spec.engine === 'codex' ? 'high' : 'high' },
    risk: spec.risk ?? 'low',
  };
}

// ---------------------------------------------------------------------------------------------
// i18n plan (run C)
// ---------------------------------------------------------------------------------------------

const I18N_MARKDOWN = `# Extract UI strings to locale files

Every user-facing string in \`web/src\` goes through \`t()\`. Ship English, Dutch and German.

## Approach
- ICU MessageFormat through the existing \`@formatjs/intl\` dependency.
- T1 adds the extraction codemod and \`i18n:check\`; area tasks run it per folder.
- Translations are generated per locale, then reviewed by the other engine.

## Out of scope
- Server-side emails
- Right-to-left layout

## Assumptions
- English stays the source locale; keys are namespaced by area (\`auth.*\`, \`settings.*\`).
- Missing translations fall back to English at runtime instead of failing the build.
- \`web/src/i18n/index.ts\` is the only registry of message catalogs.

## Verification
\`\`\`
pnpm typecheck
pnpm test
pnpm i18n:check
\`\`\`
`;

function i18nNodes(): TaskNode[] {
  return [
    node({
      id: 'T1',
      title: 'Codemod + i18n:check',
      goal: 'A codemod that wraps string literals in t() and a check that fails on raw UI strings.',
      kind: 'contracts',
      dependsOn: [],
      size: 'M',
      engine: 'claude',
      touches: [
        ['create', 'tools/i18n/**'],
        ['modify', 'package.json'],
      ],
      criteria: ['Codemod is idempotent', 'i18n:check exits non-zero on a raw string', 'Runs per folder'],
      verify: ['pnpm vitest run tools/i18n'],
    }),
    node({
      id: 'T2',
      title: 'Settings strings',
      goal: 'Move every string in the settings pages into settings.* keys.',
      kind: 'refactor',
      dependsOn: ['T1'],
      size: 'M',
      engine: 'codex',
      touches: [
        ['modify', 'web/src/pages/settings/**'],
        ['create', 'web/src/i18n/en/settings.json'],
        ['read', 'web/src/components/**'],
      ],
      criteria: ['No string literals left in pages/settings', 'Keys are namespaced settings.*'],
      verify: ['pnpm i18n:check --scope settings && pnpm test pages/settings'],
    }),
    node({
      id: 'T3',
      title: 'Dashboard strings',
      goal: 'Move the dashboard copy into dashboard.* keys and register the catalog.',
      kind: 'refactor',
      dependsOn: ['T1'],
      size: 'M',
      engine: 'claude',
      touches: [
        ['modify', 'web/src/pages/dashboard/**'],
        ['modify', 'web/src/i18n/index.ts'],
        ['create', 'web/src/i18n/en/dashboard.json'],
      ],
      criteria: ['No string literals left in pages/dashboard', 'Plurals use ICU syntax'],
      verify: ['pnpm i18n:check --scope dashboard && pnpm test pages/dashboard'],
    }),
    node({
      id: 'T4',
      title: 'Auth page strings',
      goal: 'Move sign-in, sign-up and recovery copy into auth.* keys.',
      kind: 'refactor',
      dependsOn: ['T1'],
      size: 'S',
      engine: 'codex',
      touches: [
        ['modify', 'web/src/pages/auth/**'],
        ['modify', 'web/src/i18n/index.ts'],
        ['read', 'web/src/components/**'],
      ],
      criteria: [
        'No string literals left in pages/auth',
        'Keys are namespaced auth.*',
        'Snapshot tests updated, no visual diffs',
      ],
      verify: ['pnpm i18n:check --scope auth && pnpm test pages/auth'],
    }),
    node({
      id: 'T5',
      title: 'Dutch translations',
      goal: 'nl catalogs for every namespace.',
      kind: 'feature',
      dependsOn: ['T2', 'T3', 'T4'],
      size: 'S',
      engine: 'claude',
      touches: [['create', 'web/src/i18n/nl/**']],
      criteria: ['Every en key has an nl translation', 'Plurals keep their ICU branches'],
      verify: ['pnpm i18n:check --locale nl'],
    }),
    node({
      id: 'T6',
      title: 'German translations',
      goal: 'de catalogs for every namespace.',
      kind: 'feature',
      dependsOn: ['T2', 'T3', 'T4'],
      size: 'S',
      engine: 'codex',
      touches: [['create', 'web/src/i18n/de/**']],
      criteria: ['Every en key has a de translation', 'Plurals keep their ICU branches'],
      verify: ['pnpm i18n:check --locale de'],
    }),
    node({
      id: 'T7',
      title: 'Lint rule + CI check',
      goal: 'Forbid raw UI strings in CI.',
      kind: 'integration',
      dependsOn: ['T5', 'T6'],
      size: 'S',
      engine: 'claude',
      touches: [
        ['modify', '.github/workflows/ci.yml'],
        ['modify', 'biome.json'],
      ],
      criteria: ['CI fails on a raw UI string', 'Existing code passes'],
      verify: ['pnpm lint && pnpm i18n:check'],
    }),
  ];
}

function extendI18n(world: DemoWorld, now: number): void {
  const plan = world.plans.find((p) => p.runId === C);
  if (!plan) return;
  const result = validatePlan({ nodes: i18nNodes(), annotations: [] }, { estimate: false });
  plan.markdown = I18N_MARKDOWN;
  plan.dag = result.dag;
  const run = world.runs.find((r) => r.id === C);
  if (run) {
    run.title = 'Extract UI strings for i18n';
    run.issueText = 'All UI copy should be translatable; start with Dutch and German.';
  }
  world.inbox.push({
    id: 'inb_i18nclarify1',
    runId: C,
    taskId: null,
    attemptId: null,
    kind: 'question',
    payload: {
      source: 'clarify',
      questions: [
        { id: 'q1', question: 'Which locales first?', options: ['Dutch', 'German', 'French'] },
        { id: 'q2', question: 'Keep ICU plurals?', options: ['Yes, keep them', 'Flatten to simple keys'] },
      ],
    },
    createdAt: now - 8 * MIN,
    resolvedAt: now - 6 * MIN,
    resolution: {
      answers: [
        { questionId: 'q1', answer: 'English, Dutch, German' },
        { questionId: 'q2', answer: 'Yes, keep them' },
      ],
    },
  } as InboxItem);
}

// ---------------------------------------------------------------------------------------------
// Passkeys run (A): T4's review pack
// ---------------------------------------------------------------------------------------------

function verification(
  id: string,
  runId: string,
  taskId: string | null,
  attemptId: string | null,
  phase: Verification['phase'],
  command: string,
  outputTail: string,
  durationMs: number,
  createdAt: number,
  exitCode: number | null = 0,
): Verification {
  return { id, runId, taskId, attemptId, phase, command, exitCode, outputTail, durationMs, createdAt };
}

function extendPasskeys(world: DemoWorld, now: number, stage: DemoStage): void {
  const plan = world.plans.find((p) => p.runId === A);
  const t4 = world.tasks.find((t) => t.runId === A && t.nodeId === 'T4');
  if (!plan || !t4) return;
  const n4 = plan.dag.nodes.find((n) => n.id === 'T4');
  if (n4) {
    n4.goal =
      'A reversible migration for passkey credentials, unique per credential id, plus a typed repository the API tasks build on.';
    n4.touches = [
      { glob: 'migrations/**', mode: 'create' },
      { glob: 'db/schema.ts', mode: 'modify' },
      { glob: 'server/db/passkeys.repo*.ts', mode: 'create' },
    ];
    n4.verify = { commands: ['pnpm vitest run db', 'pnpm db:migrate:check'] };
  }
  plan.dag.annotations.push({
    kind: 'note',
    nodeIds: ['T4'],
    message: '[high_risk_glob] T4 writes migrations/**, which legion.json lists in highRiskGlobs.',
  });
  plan.markdown += '\n## Verification\n```\npnpm typecheck\npnpm lint\npnpm test\n```\n';

  // Coder report (round 0) and the fix round's report.
  world.transcripts.att_authv2t4code = [
    { type: 'session_started', sessionId: 'sess_t4c', model: 'claude-opus', version: '2.1.289' },
    { type: 'file_change', path: 'migrations/0042_passkeys.sql', added: 25, removed: 0 },
    { type: 'file_change', path: 'db/schema.ts', added: 18, removed: 1 },
    { type: 'file_change', path: 'server/db/passkeys.repo.ts', added: 38, removed: 0 },
    { type: 'file_change', path: 'server/db/passkeys.repo.test.ts', added: 1, removed: 1 },
    {
      type: 'message',
      text: 'Added the passkey_credentials table with a unique index on credential_id, and a repository with create / findByCredentialId / bumpCounter. down() drops both.',
    },
    { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
  ];
  const fix = world.transcripts.att_authv2t4fix1 ?? [];
  const reviewer1 = world.attempts.find((a) => a.id === 'att_authv2t4revw');
  const coder = world.attempts.find((a) => a.id === 'att_authv2t4code');
  const fixer = world.attempts.find((a) => a.id === 'att_authv2t4fix1');
  const review1 = world.reviews.find((r) => r.id === 'rev_authv2t4rev1');
  if (review1) {
    review1.criteria = [
      { id: 'AC1', status: 'met', evidence: 'down() at lines 24–25 drops the index and the table' },
      { id: 'AC2', status: 'met', evidence: 'unique index at lines 20–21' },
      { id: 'AC3', status: 'unmet', evidence: 'sign_count is INTEGER (line 14); see the major finding' },
    ];
  }

  const verifyRound = (attemptId: string, at: number, round: 1 | 2) => [
    verification(
      `ver_t4r${round}test`,
      A,
      t4.id,
      attemptId,
      'task',
      'pnpm vitest run db',
      round === 1 ? '✓ 9 passed (2.1s)' : '✓ 10 passed (2.3s)',
      2_300,
      at,
    ),
    verification(
      `ver_t4r${round}mig`,
      A,
      t4.id,
      attemptId,
      'task',
      'pnpm db:migrate:check',
      'up ✓ · down ✓ · up ✓ (0042_passkeys)',
      4_800,
      at + 1,
    ),
    verification(
      `ver_t4r${round}tsc`,
      A,
      t4.id,
      attemptId,
      'task',
      'pnpm typecheck',
      'tsc --noEmit · 0 errors',
      9_100,
      at + 2,
    ),
    verification(
      `ver_t4r${round}lint`,
      A,
      t4.id,
      attemptId,
      'task',
      'pnpm lint',
      'Checked 412 files · 0 problems',
      1_200,
      at + 3,
    ),
    verification(
      `ver_t4r${round}sec`,
      A,
      t4.id,
      attemptId,
      'task',
      'gitleaks detect --no-git --redact',
      'no leaks found',
      900,
      at + 4,
    ),
  ];
  world.verifications = world.verifications.filter((v) => v.id !== 'ver_authv2t4vf01');
  world.verifications.push(...verifyRound('att_authv2t4code', now - 12 * MIN, 1));

  if (stage === 'fixing') {
    world.transcripts.att_authv2t4fix1 = fix;
    return;
  }

  // Gate: the fix round finished, round 2 approved, migrations are high-risk → waits for the human.
  if (coder) Object.assign(coder, { startedAt: now - 44 * MIN, endedAt: now - 31 * MIN });
  if (reviewer1) Object.assign(reviewer1, { startedAt: now - 31 * MIN, endedAt: now - 24 * MIN });
  if (review1) review1.createdAt = now - 24 * MIN;
  if (fixer)
    Object.assign(fixer, { status: 'succeeded', startedAt: now - 23 * MIN, endedAt: now - 14 * MIN, costUsd: 0.19 });
  world.verifications = world.verifications.filter((v) => v.attemptId !== 'att_authv2t4code');
  world.verifications.push(
    ...verifyRound('att_authv2t4code', now - 31 * MIN, 1),
    ...verifyRound('att_authv2t4fix1', now - 14 * MIN, 2),
  );
  world.transcripts.att_authv2t4fix1 = [
    ...fix,
    { type: 'file_change', path: 'server/db/passkeys.repo.test.ts', added: 7, removed: 1 },
    {
      type: 'message',
      text: 'Switched sign_count to BIGINT (the repository already used bigint) and added a test that bumps the counter to 2³² + 1. Documented credential_id encoding on the schema.',
    },
    { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
  ];
  const reviewer2: Attempt = {
    id: 'att_authv2t4rev2',
    runId: A,
    taskId: t4.id,
    role: 'reviewer',
    engine: 'codex',
    model: 'gpt-5-codex',
    effort: 'high',
    sessionId: 'thr_t4r2',
    status: 'succeeded',
    startedAt: now - 13 * MIN,
    endedAt: now - 4 * MIN,
    costUsd: null,
    inputTokens: 24_000,
    outputTokens: 2_100,
    error: null,
  };
  world.attempts.push(reviewer2);
  world.reviews.push({
    id: 'rev_authv2t4rev2',
    runId: A,
    taskId: t4.id,
    attemptId: reviewer2.id,
    verdict: 'approve',
    criteria: [
      { id: 'AC1', status: 'met', evidence: 'down() at lines 24–25; the up → down → up gate passed' },
      { id: 'AC2', status: 'met', evidence: 'unique index at lines 20–21' },
      { id: 'AC3', status: 'met', evidence: 'BIGINT at line 14 + repository test at 2³² + 1' },
    ],
    findings: [
      {
        severity: 'minor',
        file: 'migrations/0042_passkeys.sql',
        line: 21,
        title: 'Index on user_id',
        body: 'Sign-in lists credentials by user. Consider an index on user_id once the table grows.',
        suggestedFix: 'CREATE INDEX passkey_credentials_user_id_idx\n  ON passkey_credentials (user_id);',
      },
    ],
    summary: 'Reversible, indexed and the counter is 64-bit now. One minor note for the PR.',
    createdAt: now - 4 * MIN,
  });
  Object.assign(t4, { status: 'awaiting_human', fixRounds: 1, progress: null, updatedAt: now - 4 * MIN });
}

// ---------------------------------------------------------------------------------------------
// PDF run (B): merges, verification, final review, PR body
// ---------------------------------------------------------------------------------------------

const PR_BODY = `Closes #388

## Summary

Invoices can be exported as PDF from the invoice page. The renderer works on a small view model, the
download endpoint streams the file with \`Cache-Control: private, no-store\`, and golden-file tests pin
the output.

## Tasks

| Task | Title | Coder | Reviewer | Verdict | Fix rounds |
|---|---|---|---|---|---|
| T1 | Invoice view model | claude | codex | approve | 0 |
| T2 | PDF renderer | codex | claude | approve | 1 |
| T3 | Download endpoint | claude | codex | approve | 0 |
| T4 | Export button | codex | claude | approve | 0 |
| T5 | Snapshot tests | claude | codex | approve | 0 |

## Verification

| Command | Result | Duration |
|---|---|---|
| \`pnpm typecheck\` | ✓ | 9.4s |
| \`pnpm lint\` | ✓ | 1.3s |
| \`pnpm test\` | ✓ 248 passed | 21.7s |

## Notes for reviewers

- *minor* \`src/invoices/pdf/render.ts:4\`: the font path is resolved per process; fine for now, consider caching the font buffer.
- *nit* \`web/src/invoices/ExportButton.tsx:21\`: add \`aria-busy\` while exporting.

<sub>Opened by Legion · run run_pdfexport001</sub>`;

function extendPdf(world: DemoWorld, now: number): void {
  const tasks = world.tasks.filter((t) => t.runId === B).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const order = ['T1', 'T3', 'T2', 'T4', 'T5'];
  const sha = 0x3e1a0c0;
  const merges: Merge[] = [];
  const verifications: Verification[] = [];
  order.forEach((nodeId, i) => {
    const task = tasks.find((t) => t.nodeId === nodeId);
    if (!task) return;
    const at = now - (96 - i * 11) * MIN;
    const pre = (sha + i * 0x1111).toString(16);
    const post = (sha + (i + 1) * 0x1111).toString(16);
    Object.assign(task, { mergedSha: post, updatedAt: at, fixRounds: nodeId === 'T2' ? 1 : 0 });
    merges.push({
      id: `mrg_pdf${nodeId.toLowerCase()}00000`,
      runId: B,
      taskId: task.id,
      preSha: pre,
      postSha: post,
      status: 'merged',
      error: null,
      createdAt: at - 40_000,
      endedAt: at,
    });
    verifications.push(
      verification(
        `ver_pdfpm${i}`,
        B,
        task.id,
        null,
        'post_merge',
        'pnpm typecheck && pnpm test',
        `✓ ${212 + i * 9} passed`,
        38_000 + i * 2_100,
        at + 1,
      ),
    );
  });
  verifications.push(
    verification(
      'ver_pdffinal1',
      B,
      null,
      null,
      'final',
      'pnpm typecheck',
      'tsc --noEmit · 0 errors',
      9_400,
      now - 40 * MIN,
    ),
    verification(
      'ver_pdffinal2',
      B,
      null,
      null,
      'final',
      'pnpm lint',
      'Checked 398 files · 0 problems',
      1_300,
      now - 40 * MIN + 1,
    ),
    verification(
      'ver_pdffinal3',
      B,
      null,
      null,
      'final',
      'pnpm test',
      '✓ 248 passed (21.7s)',
      21_700,
      now - 40 * MIN + 2,
    ),
  );
  world.merges.push(...merges);
  world.verifications.push(...verifications);
  const finalizer: Attempt = {
    id: 'att_pdffinalize1',
    runId: B,
    taskId: null,
    role: 'finalizer',
    engine: 'codex',
    model: 'gpt-5-codex',
    effort: 'high',
    sessionId: 'thr_final',
    status: 'succeeded',
    startedAt: now - 39 * MIN,
    endedAt: now - 32 * MIN,
    costUsd: null,
    inputTokens: 61_000,
    outputTokens: 3_400,
    error: null,
  };
  world.attempts.push(finalizer);
  const review: Review = {
    id: 'rev_pdffinalrev1',
    runId: B,
    taskId: null,
    attemptId: finalizer.id,
    verdict: 'approve',
    criteria: [
      { id: 'issue', status: 'met', evidence: 'Export button on the invoice page downloads invoice-<number>.pdf' },
      { id: 'T3.AC1', status: 'met', evidence: 'GET /invoices/:id.pdf checks ownership (requireUser + findForUser)' },
      { id: 'T5.AC1', status: 'met', evidence: 'golden file tests/invoices/__golden__/invoice-1042.pdf.txt' },
    ],
    findings: [
      {
        severity: 'minor',
        file: 'src/invoices/pdf/render.ts',
        line: 4,
        title: 'Font resolved per process',
        body: 'The font path is resolved once per process, which is fine; consider caching the font buffer if exports get hot.',
        suggestedFix: null,
      },
      {
        severity: 'nit',
        file: 'web/src/invoices/ExportButton.tsx',
        line: 21,
        title: 'aria-busy while exporting',
        body: 'Screen readers get no signal while the PDF downloads.',
        suggestedFix: '<Button variant="secondary" onClick={download} disabled={busy} aria-busy={busy}>',
      },
    ],
    summary: 'The pieces fit: one view model, one renderer, an owned endpoint and a button. Ready for a draft PR.',
    createdAt: now - 32 * MIN,
  };
  world.reviews.push(review);
  const pr = world.inbox.find((i) => i.runId === B && i.kind === 'pr_ready');
  if (pr && pr.kind === 'pr_ready') pr.payload = { ...pr.payload, title: 'Export invoices as PDF', body: PR_BODY };
  const run = world.runs.find((r) => r.id === B);
  if (run) Object.assign(run, { issueUrl: 'https://github.com/erudiet/app/issues/388', baseRef: 'main' });
}

export function extendDemoWorld(world: DemoWorld, now: number, stage: DemoStage = demoStage()): void {
  extendI18n(world, now);
  extendPasskeys(world, now, stage);
  extendPdf(world, now);
}

// ---------------------------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------------------------

export interface DemoRpcContext {
  world: DemoWorld;
  emit: (bodies: ServerEventBody[]) => void;
  later: (ms: number, fn: () => void) => void;
}

const clone = <T>(value: T): T => structuredClone(value);
const NOT_HANDLED = Symbol('not handled');

function runOf(ctx: DemoRpcContext, runId: string): Run {
  const run = ctx.world.runs.find((r) => r.id === runId);
  if (!run) throw new RpcError('not_found', 'run not found');
  return run;
}

function setRun(ctx: DemoRpcContext, run: Run, patch: Partial<Run>): Run {
  const from = run.status;
  Object.assign(run, patch, { updatedAt: Date.now() });
  ctx.emit([{ type: 'run.updated', run: clone(run), from }]);
  return clone(run);
}

function setTask(ctx: DemoRpcContext, task: Task, patch: Partial<Task>): Task {
  const from = task.status;
  Object.assign(task, patch, { updatedAt: Date.now() });
  ctx.emit([{ type: 'task.updated', task: clone(task), from }]);
  return clone(task);
}

function latestPlanOf(ctx: DemoRpcContext, runId: string): Plan | undefined {
  return ctx.world.plans
    .filter((p) => p.runId === runId)
    .sort((a, b) => a.version - b.version)
    .at(-1);
}

function newPlan(ctx: DemoRpcContext, base: Plan, patch: Partial<Plan>): Plan {
  const version = base.version + 1;
  const plan: Plan = {
    ...clone(base),
    id: `plan_${base.runId.slice(4, 12)}v${version}`,
    version,
    createdAt: Date.now(),
    approvedAt: null,
    feedback: null,
    ...patch,
  };
  ctx.world.plans.push(plan);
  const bodies: ServerEventBody[] = [{ type: 'plan.updated', plan: clone(plan) }];
  for (const item of ctx.world.inbox) {
    if (item.runId === plan.runId && item.kind === 'plan_signoff' && item.resolvedAt === null) {
      item.payload = { planId: plan.id, version };
      bodies.push({ type: 'inbox.updated', item: clone(item) });
    }
  }
  ctx.emit(bodies);
  return plan;
}

/** Handle the procedures these tiles need; returns NOT_HANDLED for everything else. */
export function handlePlanReviewRpc(ctx: DemoRpcContext, method: ProcedureName, raw: unknown): unknown {
  const input = raw as Record<string, unknown>;
  const w = ctx.world;
  switch (method) {
    case 'diff.get': {
      const target = input.target as DiffTarget;
      const diffs = demoDiffs({
        t4: w.tasks.find((t) => t.runId === A && t.nodeId === 'T4')?.id ?? '',
        runA: A,
        runB: B,
      });
      const key = target.kind === 'task' ? `task:${target.taskId}` : target.kind === 'run' ? `run:${target.runId}` : '';
      return clone(diffs[key] ?? { from: 'HEAD~1', to: 'HEAD', files: [] });
    }
    case 'runs.updatePlan': {
      const runId = input.runId as string;
      const base = latestPlanOf(ctx, runId);
      if (!base) throw new RpcError('not_found', 'no plan');
      if (base.id !== input.basePlanId)
        throw new RpcError('conflict', `plan v${base.version} is newer than the version you edited`);
      const nodes = input.nodes as TaskNode[];
      const annotations = (input.annotations as Plan['dag']['annotations'] | undefined) ?? base.dag.annotations;
      const result = validatePlan({ nodes, annotations }, { estimate: false });
      if (!result.ok) throw new RpcError('bad_request', result.errors.map((e) => e.message).join('\n'));
      return clone(newPlan(ctx, base, { markdown: input.markdown as string, dag: result.dag, source: 'user' }));
    }
    case 'runs.requestPlanRevision': {
      const run = runOf(ctx, input.runId as string);
      const base = latestPlanOf(ctx, run.id);
      if (!base) throw new RpcError('not_found', 'no plan');
      const feedback = input.feedback as string;
      const bodies: ServerEventBody[] = [];
      for (const item of w.inbox) {
        if (item.runId === run.id && item.kind === 'plan_signoff' && item.resolvedAt === null) {
          Object.assign(item, { resolvedAt: Date.now(), resolution: { approved: false, feedback } });
          bodies.push({ type: 'inbox.updated', item: clone(item) });
        }
      }
      ctx.emit(bodies);
      const updated = setRun(ctx, run, { status: 'planning' });
      ctx.later(2600, () => {
        const plan = newPlan(ctx, base, {
          source: 'agent',
          feedback,
          markdown: `${base.markdown.trimEnd()}\n\n## Revision\n- ${feedback}\n`,
        });
        const item: InboxItem = {
          id: `inb_${run.id.slice(4, 10)}so${plan.version}`,
          runId: run.id,
          taskId: null,
          attemptId: null,
          kind: 'plan_signoff',
          payload: { planId: plan.id, version: plan.version },
          createdAt: Date.now(),
          resolvedAt: null,
          resolution: null,
        };
        w.inbox.push(item);
        ctx.emit([{ type: 'inbox.updated', item: clone(item) }]);
        setRun(ctx, run, { status: 'awaiting_approval' });
      });
      return updated;
    }
    case 'tasks.approveMerge': {
      const task = w.tasks.find((t) => t.id === input.taskId);
      if (!task) throw new RpcError('not_found', 'task not found');
      if (task.status !== 'awaiting_human') throw new RpcError('conflict', `task is ${task.status}`);
      const out = setTask(ctx, task, { status: 'merging' });
      const integration = w.merges.filter((m) => m.runId === task.runId).at(-1)?.postSha ?? 'b7e01d2';
      const merge: Merge = {
        id: `mrg_${task.id.slice(-10)}`,
        runId: task.runId,
        taskId: task.id,
        preSha: integration,
        postSha: null,
        status: 'pending',
        error: null,
        createdAt: Date.now(),
        endedAt: null,
      };
      w.merges.push(merge);
      ctx.emit([{ type: 'merge.updated', merge: clone(merge) }]);
      ctx.later(1400, () => {
        Object.assign(merge, { status: 'merged', postSha: 'd41c9a0', endedAt: Date.now() });
        const v = verification(
          `ver_${task.id.slice(-8)}pm`,
          task.runId,
          task.id,
          null,
          'post_merge',
          'pnpm typecheck && pnpm test',
          '✓ 224 passed',
          43_000,
          Date.now(),
        );
        w.verifications.push(v);
        ctx.emit([
          { type: 'merge.updated', merge: clone(merge) },
          { type: 'verification.created', verification: clone(v) },
        ]);
        setTask(ctx, task, { status: 'merged', mergedSha: 'd41c9a0' });
      });
      return out;
    }
    case 'tasks.requestChanges': {
      const task = w.tasks.find((t) => t.id === input.taskId);
      if (!task) throw new RpcError('not_found', 'task not found');
      const coder = w.attempts.filter((a) => a.taskId === task.id && a.role === 'coder').at(-1);
      const attempt: Attempt = {
        ...(coder as Attempt),
        id: `att_${task.id.slice(-8)}fx${task.fixRounds + 1}`,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        costUsd: 0,
      };
      w.attempts.push(attempt);
      ctx.emit([
        { type: 'attempt.updated', attempt: clone(attempt), from: null },
        {
          type: 'agent.event',
          runId: task.runId,
          taskId: task.id,
          attemptId: attempt.id,
          event: { type: 'message', text: `Addressing your feedback: ${String(input.feedback)}` } satisfies AgentEvent,
        },
      ]);
      return setTask(ctx, task, { status: 'fixing', fixRounds: task.fixRounds + 1 });
    }
    case 'runs.createPr': {
      const run = runOf(ctx, input.runId as string);
      if (run.status !== 'pr_ready') throw new RpcError('failed_precondition', `run is ${run.status}`);
      const url = 'https://github.com/erudiet/app/pull/412';
      const bodies: ServerEventBody[] = [];
      for (const item of w.inbox) {
        if (item.runId === run.id && item.kind === 'pr_ready' && item.resolvedAt === null) {
          Object.assign(item, {
            resolvedAt: Date.now(),
            resolution: { approved: true, title: input.title ?? null, body: input.body ?? null },
          });
          bodies.push({ type: 'inbox.updated', item: clone(item) });
        }
      }
      ctx.emit(bodies);
      return { run: setRun(ctx, run, { status: 'done', prUrl: url }), url };
    }
    default:
      return NOT_HANDLED;
  }
}

export function isHandled(value: unknown): boolean {
  return value !== NOT_HANDLED;
}
