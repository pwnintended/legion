/**
 * Demo fixture for a big run (opt-in: `?scale=1` or `localStorage['legion.demo.scale'] = '1'`, so the default
 * demo and its tests keep their counts): "Migrate billing to Stripe Billing v2", 22 tasks in five waves with 11
 * in parallel in the second. It exercises the route map at scale: a folded finished wave, an open wave with
 * merged rows folded, live, reviewing, fixing, waiting and failed tasks, and later waves still ahead.
 */
import type { Attempt, InboxItem, Plan, Review, Run, Task, TaskNode } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import type { DemoWorld } from './fixtures';

const MIN = 60_000;
export const SCALE_RUN_ID = 'run_stripebill01';

const NODES: [id: string, title: string, goal: string, deps: string[], touches: string[]][] = [
  ['T1', 'Billing domain types', 'Shared types for prices, subscriptions and invoices.', [], ['billing/types.ts']],
  ['T2', 'Stripe client wrapper', 'One typed client for Stripe Billing v2 with retries.', [], ['billing/stripe.ts']],
  [
    'T3',
    'Webhook signature check',
    'Verify Stripe webhook signatures before handling events.',
    [],
    ['server/webhooks/**'],
  ],
  ['T4', 'Price objects', 'Map our plan prices onto Stripe price objects.', ['T1', 'T2'], ['billing/prices.ts']],
  [
    'T5',
    'Product catalog sync',
    'Keep Stripe products in step with the plan catalog.',
    ['T1', 'T2'],
    ['billing/catalog.ts'],
  ],
  [
    'T6',
    'Subscription model',
    'Store subscriptions with their Stripe ids and state.',
    ['T1'],
    ['billing/subscriptions.ts'],
  ],
  [
    'T7',
    'Proration engine',
    'Prorate plan changes mid-cycle the way Stripe does.',
    ['T1', 'T2'],
    ['billing/proration.ts'],
  ],
  [
    'T8',
    'Invoice webhooks',
    'Handle invoice.paid, invoice.payment_failed and invoice.finalized.',
    ['T3'],
    ['server/webhooks/invoices.ts'],
  ],
  [
    'T9',
    'Tax rates sync',
    'Implement tax rates synchronization with Stripe Tax, handling jurisdiction mapping and rounding.',
    ['T1', 'T2'],
    ['billing/tax/**'],
  ],
  [
    'T10',
    'Customer portal links',
    'Create Stripe customer portal sessions from account settings.',
    ['T2'],
    ['server/routes/billing.ts'],
  ],
  [
    'T11',
    'Dunning emails',
    'Send the retry and final-notice emails after a failed payment.',
    ['T3'],
    ['emails/dunning/**'],
  ],
  ['T12', 'Usage meters', 'Report metered usage to Stripe meters every hour.', ['T2'], ['billing/usage.ts']],
  ['T13', 'Coupon migration', 'Move existing coupons and promotion codes to Stripe.', ['T2'], ['billing/coupons.ts']],
  [
    'T14',
    'Plan catalog seed',
    'Seed the plan catalog for local development and tests.',
    ['T1'],
    ['scripts/seed-plans.ts'],
  ],
  [
    'T15',
    'Payment methods',
    'Add, list and remove payment methods through SetupIntents.',
    ['T7'],
    ['billing/payment-methods.ts'],
  ],
  ['T16', 'Subscription sync', 'Reconcile local subscriptions with Stripe nightly.', ['T6', 'T8'], ['billing/sync.ts']],
  [
    'T17',
    'Billing metrics',
    'MRR, churn and failed-payment metrics from Stripe data.',
    ['T9', 'T12'],
    ['billing/metrics.ts'],
  ],
  ['T18', 'Credit notes', 'Issue credit notes for refunds and plan downgrades.', ['T8'], ['billing/credit-notes.ts']],
  ['T19', 'Refund flow', 'Refund a charge from the admin with an audit entry.', ['T7'], ['server/admin/refunds.ts']],
  [
    'T20',
    'Migrate existing customers',
    'Create Stripe customers and subscriptions for current accounts.',
    ['T15', 'T16'],
    ['scripts/migrate-customers.ts'],
  ],
  [
    'T21',
    'Backfill invoices',
    'Import the last 12 months of invoices for reporting.',
    ['T18'],
    ['scripts/backfill-invoices.ts'],
  ],
  [
    'T22',
    'End-to-end billing tests',
    'Cover signup to invoice to refund against Stripe test mode.',
    ['T17', 'T20', 'T21'],
    ['tests/billing/**'],
  ],
];

const STATUS: Record<string, Partial<Task>> = {
  T1: { status: 'merged' },
  T2: { status: 'merged' },
  T3: { status: 'merged' },
  T4: { status: 'merged' },
  T5: { status: 'merged' },
  T6: { status: 'merged' },
  T7: { status: 'running', progress: 'Prorating a mid-cycle upgrade across two price tiers' },
  T8: { status: 'reviewing', progress: 'Handlers done; waiting on review' },
  T9: { status: 'fixing', fixRounds: 1, progress: 'Rounding tax rates to 4 decimals per Stripe' },
  T10: { status: 'running', progress: 'Needs approval to add @stripe/stripe-js' },
  T11: { status: 'running', progress: 'Rendering the final-notice email' },
  T12: { status: 'running', progress: 'Batching hourly usage records' },
  T13: { status: 'failed', attemptCount: 3, error: 'pnpm test billing/coupons failed 3 times' },
  T14: { status: 'queued' },
};

function node([id, title, goal, dependsOn, touches]: (typeof NODES)[number]): TaskNode {
  return {
    id,
    title,
    goal,
    kind: 'feature',
    dependsOn,
    acceptanceCriteria: [
      { id: 'AC1', text: `${title} works against Stripe test mode` },
      { id: 'AC2', text: 'Covered by unit tests' },
    ],
    touches: touches.map((glob) => ({ glob, mode: 'modify' as const })),
    size: 'M',
    verify: { commands: ['pnpm test billing'] },
    contextHints: { files: [], notes: '' },
    agent: { effort: 'high' },
    risk: id === 'T20' ? 'high' : 'low',
  };
}

function attempt(id: string, taskId: string | null, patch: Partial<Attempt>, now: number): Attempt {
  return {
    id,
    runId: SCALE_RUN_ID,
    taskId,
    role: 'coder',
    engine: 'claude',
    model: null,
    effort: 'high',
    sessionId: `sess_${id}`,
    status: 'succeeded',
    startedAt: now - 30 * MIN,
    endedAt: null,
    costUsd: 0.4,
    inputTokens: null,
    outputTokens: null,
    error: null,
    ...patch,
  };
}

const T9_CODER: AgentEvent[] = [
  { type: 'session_started', sessionId: 'sess_bill_t9', model: 'claude-opus-4', version: '2.1.289' },
  {
    type: 'message',
    text: "I've updated the tax rate synchronization to handle jurisdiction mapping and added rounding per currency. Rates are validated against Stripe's API, with errors for unsupported jurisdictions.",
  },
  { type: 'tool_call', id: 'e1', name: 'Edit', input: { file_path: 'src/billing/tax/sync.ts' }, kind: 'edit' },
  { type: 'file_change', path: 'src/billing/tax/sync.ts', added: 48, removed: 12 },
  { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
];

const VITEST_TAX = [
  ' RUN  v1.3.1 /repo',
  '',
  ' ✓ tax-rates.test.ts (12)',
  ' ✓ jurisdiction-mapping.test.ts (8)',
  ' ✓ rounding.test.ts (8)',
  ' ✓ stripe-client.test.ts (28)',
  '',
  ' Test Files  4 passed (4)',
  '      Tests  56 passed (56)',
].join('\n');

const T9_FIX: AgentEvent[] = [
  { type: 'session_started', sessionId: 'sess_bill_t9_fix1', model: 'claude-opus-4', version: '2.1.289' },
  {
    type: 'message',
    text: 'The reviewer found that tax rates are rounded to 2 decimals; Stripe expects 4, which fails validation for jurisdictions like CH (7.7%) and some Canadian provinces.',
  },
  { type: 'tool_call', id: 'r1', name: 'Read', input: { file_path: 'src/billing/tax/sync.ts' }, kind: 'read' },
  { type: 'tool_call', id: 'e2', name: 'Edit', input: { file_path: 'src/billing/tax/sync.ts' }, kind: 'edit' },
  { type: 'file_change', path: 'src/billing/tax/sync.ts', added: 6, removed: 3 },
  {
    type: 'message',
    text: "Good catch. I've updated the rounding logic to use 4 decimal places per Stripe's requirements. Re-running the tests.",
  },
  { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'pnpm vitest run billing/tax' }, kind: 'command' },
  { type: 'tool_result', id: 't1', ok: true, output: VITEST_TAX },
  {
    type: 'message',
    text: 'All 56 tax tests pass, including CH at 7.7% and the Canadian provinces. Running the typecheck before handing it back for re-review.',
  },
  { type: 'tool_call', id: 't2', name: 'Bash', input: { command: 'pnpm typecheck' }, kind: 'command' },
];

/** The codex reviewer's pass over T9's first attempt (its own transcript, one tab away in the pane). */
const T9_REVIEW: AgentEvent[] = [
  { type: 'session_started', sessionId: 'thr_bill_t9_rev1', model: 'gpt-5-codex', version: '0.160.0' },
  { type: 'tool_call', id: 'v1', name: 'read', input: { path: 'src/billing/tax/sync.ts' }, kind: 'read' },
  { type: 'tool_call', id: 'v2', name: 'shell', input: { command: 'pnpm vitest run billing/tax' }, kind: 'command' },
  { type: 'tool_result', id: 'v2', ok: true, output: VITEST_TAX },
  {
    type: 'message',
    text: "There's an issue with rounding tax rates for some jurisdictions. Stripe expects tax rates rounded to 4 decimal places, but we're using 2. This can cause validation errors for jurisdictions like CH (7.7%) and some Canadian provinces. src/billing/tax/sync.ts L124-L128",
  },
  { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
];

/** Add the big run to the demo world. */
export function withScaleDemo(world: DemoWorld, now: number): DemoWorld {
  const R = SCALE_RUN_ID;
  const created = now - 3 * 60 * MIN;
  const nodes = NODES.map(node);
  const tasks: Task[] = nodes.map((n, i) => ({
    id: `task_${R.slice(4)}${n.id.toLowerCase()}`,
    runId: R,
    nodeId: n.id,
    status: 'blocked',
    branch: null,
    worktreePath: null,
    startSha: null,
    attemptCount: 0,
    fixRounds: 0,
    mergedSha: null,
    progress: null,
    error: null,
    createdAt: created + 6 * MIN,
    updatedAt: now - (22 - i) * MIN,
    ...(STATUS[n.id]
      ? {
          attemptCount: 1,
          branch: `legion/stripebi/${n.id.toLowerCase()}`,
          worktreePath: `/Users/dev/Library/Application Support/Legion/worktrees/7a1e/${R}/${n.id}`,
          startSha: '41c0b2e',
        }
      : {}),
    ...STATUS[n.id],
  }));
  const byNode = new Map(tasks.map((t) => [t.nodeId, t]));
  const id = (nodeId: string) => byNode.get(nodeId)?.id ?? null;
  const codex = new Set(['T5', 'T11', 'T13']);
  const attempts: Attempt[] = [
    attempt('att_billplanner1', null, { role: 'planner', startedAt: created, endedAt: created + 5 * MIN }, now),
  ];
  for (const t of tasks) {
    if (t.status === 'blocked' || t.status === 'queued') continue;
    const engine = codex.has(t.nodeId) ? 'codex' : 'claude';
    const live = t.status === 'running';
    attempts.push(
      attempt(
        `att_bill${t.nodeId.toLowerCase()}code1`,
        t.id,
        {
          engine,
          status: t.status === 'failed' ? 'failed' : live ? 'running' : 'succeeded',
          startedAt: now - (live ? 12 : 60) * MIN,
          endedAt: live ? null : now - 20 * MIN,
        },
        now,
      ),
    );
    if (t.status === 'merged' || t.status === 'reviewing' || t.status === 'fixing')
      attempts.push(
        attempt(
          `att_bill${t.nodeId.toLowerCase()}rev1`,
          t.id,
          {
            role: 'reviewer',
            engine: engine === 'claude' ? 'codex' : 'claude',
            status: t.status === 'reviewing' ? 'running' : 'succeeded',
            startedAt: now - 15 * MIN,
            endedAt: t.status === 'reviewing' ? null : now - 9 * MIN,
          },
          now,
        ),
      );
  }
  attempts.push(attempt('att_billt9code2', id('T9'), { status: 'running', startedAt: now - 2 * MIN }, now));
  const review: Review = {
    id: 'rev_billt9r1',
    runId: R,
    taskId: id('T9'),
    attemptId: 'att_billt9rev1',
    verdict: 'request_changes',
    criteria: [
      {
        id: 'AC1',
        status: 'unmet',
        evidence: 'Rates rounded to 2 decimals fail Stripe validation for CH and some Canadian provinces.',
      },
    ],
    findings: [
      {
        severity: 'major',
        file: 'src/billing/tax/sync.ts',
        line: 124,
        title: 'Tax rates rounded to 2 decimals',
        body: 'Stripe expects tax rates rounded to 4 decimal places; 2 causes validation errors for jurisdictions like CH (7.7%) and some Canadian provinces.',
        suggestedFix: 'Round with 4 decimals before calling taxRates.create.',
      },
    ],
    summary: 'One rounding issue blocks the merge.',
    createdAt: now - 8 * MIN,
  };
  const inbox: InboxItem[] = [
    {
      id: 'inb_billt10appr1',
      runId: R,
      taskId: id('T10'),
      attemptId: 'att_billt10code1',
      kind: 'approval',
      payload: {
        requestId: 'req_bill_t10',
        tool: 'Bash',
        input: { command: 'pnpm add @stripe/stripe-js' },
        reason: 'Not in pre-approved commands; changes the lockfile.',
      },
      createdAt: now - 4 * MIN,
      resolvedAt: null,
      resolution: null,
    },
    {
      id: 'inb_billt13esc01',
      runId: R,
      taskId: id('T13'),
      attemptId: 'att_billt13code1',
      kind: 'escalation',
      payload: {
        reason: 'attempts_exhausted',
        summary:
          'T13 failed 3 attempts: promotion codes with a redemption limit cannot be recreated with the same code in Stripe.',
        actions: ['retry', 'skip', 'edit', 'abort'],
      },
      createdAt: now - 6 * MIN,
      resolvedAt: null,
      resolution: null,
    },
  ];
  const run: Run = {
    id: R,
    title: 'Migrate billing to Stripe Billing v2',
    status: 'executing',
    repoPath: '/Users/dev/src/erudiet/app',
    baseRef: 'main',
    issueText: 'Move billing from our homegrown invoicing to Stripe Billing v2.',
    issueUrl: 'https://github.com/erudiet/app/issues/512',
    paused: false,
    plannerEngine: 'claude',
    plannerModel: null,
    integrationBranch: 'legion/stripebi/integration',
    prUrl: null,
    error: null,
    createdAt: created,
    updatedAt: now - MIN,
  };
  const plan: Plan = {
    id: 'plan_stripebill0',
    runId: R,
    version: 3,
    markdown: '# Migrate billing to Stripe Billing v2\n\nTwenty-two tasks in five waves.\n',
    dag: { nodes, annotations: [] },
    source: 'agent',
    feedback: null,
    createdAt: created + 5 * MIN,
    approvedAt: created + 12 * MIN,
  };
  return {
    ...world,
    runs: [...world.runs, run],
    plans: [...world.plans, plan],
    tasks: [...world.tasks, ...tasks],
    attempts: [...world.attempts, ...attempts],
    reviews: [...world.reviews, review],
    inbox: [...world.inbox, ...inbox],
    transcripts: {
      ...world.transcripts,
      att_billt9code1: T9_CODER,
      att_billt9code2: T9_FIX,
      att_billt9rev1: T9_REVIEW,
    },
  };
}
