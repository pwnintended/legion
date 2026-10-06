/**
 * Demo-mode fixtures (renderer only): three runs resembling the design mockup.
 * 1. "Add passkey (WebAuthn) login" — executing, 6 tasks in different states, an approval pending on T3,
 *    a review with a major finding on T4.
 * 2. "Invoice PDF export" — all tasks merged, draft PR ready for the human gate.
 * 3. "Extract UI strings for i18n" — plan v1 waiting for sign-off.
 * Timestamps are relative to `now` so durations read naturally.
 */
import {
  type Attempt,
  DEFAULT_SETTINGS,
  type InboxItem,
  type Merge,
  type Plan,
  type Review,
  type Run,
  type Settings,
  type Task,
  type TaskNode,
  type Verification,
} from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import type { AgentEvent } from '@shared/events';
import type { RunSnapshot } from '@shared/rpc';
import { withSessionDemo } from './sessions';

const MIN = 60_000;

export interface DemoWorld {
  runs: Run[];
  plans: Plan[];
  tasks: Task[];
  attempts: Attempt[];
  reviews: Review[];
  inbox: InboxItem[];
  verifications: Verification[];
  merges: Merge[];
  /** Transcript history per attempt (seq assigned at load). */
  transcripts: Record<string, AgentEvent[]>;
  engines: EngineInfo[];
  settings: Settings;
}

type NodeSpec = Pick<TaskNode, 'id' | 'title' | 'goal' | 'kind' | 'dependsOn' | 'size' | 'risk'> & {
  engine: 'claude' | 'codex';
  effort?: TaskNode['agent']['effort'];
  touches?: string[];
  verify?: string[];
  criteria?: string[];
};

function node(spec: NodeSpec): TaskNode {
  return {
    id: spec.id,
    title: spec.title,
    goal: spec.goal,
    kind: spec.kind,
    dependsOn: spec.dependsOn,
    acceptanceCriteria: (spec.criteria ?? [`${spec.title} works end to end`]).map((text, i) => ({
      id: `AC${i + 1}`,
      text,
    })),
    touches: (spec.touches ?? []).map((glob) => ({ glob, mode: 'modify' as const })),
    size: spec.size,
    verify: { commands: spec.verify ?? ['pnpm test'] },
    contextHints: { files: [], notes: '' },
    agent: { engine: spec.engine, model: null, effort: spec.effort ?? 'high' },
    risk: spec.risk,
  };
}

function task(runId: string, nodeId: string, patch: Partial<Task>, now: number): Task {
  const slug = nodeId.toLowerCase();
  return {
    id: `task_${runId.slice(4)}${slug}`,
    runId,
    nodeId,
    status: 'blocked',
    branch: null,
    worktreePath: null,
    startSha: null,
    attemptCount: 0,
    fixRounds: 0,
    mergedSha: null,
    engineOverride: null,
    modelOverride: null,
    effortOverride: null,
    progress: null,
    error: null,
    createdAt: now - 40 * MIN,
    updatedAt: now - 40 * MIN,
    ...patch,
  };
}

function attempt(id: string, runId: string, taskId: string | null, patch: Partial<Attempt>, now: number): Attempt {
  return {
    id,
    runId,
    taskId,
    role: 'coder',
    engine: 'claude',
    model: null,
    effort: 'high',
    sessionId: `sess_${id}`,
    status: 'succeeded',
    startedAt: now - 30 * MIN,
    endedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    error: null,
    ...patch,
  };
}

const run = (patch: Partial<Run> & Pick<Run, 'id' | 'title' | 'status' | 'createdAt'>): Run => ({
  repoPath: '/Users/dev/src/erudiet/app',
  baseRef: 'main',
  issueText: '',
  issueUrl: null,
  paused: false,
  plannerEngine: 'claude',
  plannerModel: null,
  integrationBranch: null,
  prUrl: null,
  error: null,
  updatedAt: patch.createdAt,
  ...patch,
});

// ---------------------------------------------------------------------------------------------

export function createDemoWorld(now = Date.now()): DemoWorld {
  const A = 'run_authv2demo01';
  const B = 'run_pdfexport001';
  const C = 'run_i18nextract1';

  // --- Run A: passkeys ---------------------------------------------------------------------------
  const nodesA: TaskNode[] = [
    node({
      id: 'T1',
      title: 'Auth contracts & types',
      goal: 'Shared WebAuthn types and API contracts.',
      kind: 'contracts',
      dependsOn: [],
      size: 'S',
      risk: 'low',
      engine: 'claude',
      touches: ['auth/contracts.ts'],
    }),
    node({
      id: 'T2',
      title: 'Registration API',
      goal: 'POST /auth/passkeys/register (options + verify).',
      kind: 'feature',
      dependsOn: ['T1'],
      size: 'M',
      risk: 'med',
      engine: 'claude',
      touches: ['server/auth/webauthn.ts', 'server/routes/auth.ts'],
      verify: ['pnpm vitest run server/auth'],
    }),
    node({
      id: 'T3',
      title: 'Enrollment UI',
      goal: 'Settings page to register and list passkeys.',
      kind: 'feature',
      dependsOn: ['T1'],
      size: 'M',
      risk: 'low',
      engine: 'codex',
      touches: ['web/src/settings/**'],
    }),
    node({
      id: 'T4',
      title: 'Credential table migration',
      goal: 'passkeys table with credential id, public key and sign counter.',
      kind: 'feature',
      dependsOn: ['T1'],
      size: 'S',
      risk: 'high',
      engine: 'claude',
      touches: ['migrations/**', 'db/schema.ts'],
      criteria: ['Migration is reversible', 'Unique index on credential_id', 'Sign counter survives large values'],
    }),
    node({
      id: 'T5',
      title: 'Sign in with passkey',
      goal: 'Login flow with passkey assertion.',
      kind: 'feature',
      dependsOn: ['T2', 'T3'],
      size: 'M',
      risk: 'med',
      engine: 'codex',
      touches: ['web/src/auth/**', 'server/auth/login.ts'],
    }),
    node({
      id: 'T6',
      title: 'Wire routes + e2e',
      goal: 'Route wiring, lockfile, e2e coverage.',
      kind: 'integration',
      dependsOn: ['T4', 'T5'],
      size: 'M',
      risk: 'med',
      engine: 'claude',
      touches: ['pnpm-lock.yaml', 'server/routes/index.ts'],
      verify: ['pnpm e2e auth'],
    }),
  ];
  const planA: Plan = {
    id: 'plan_authv2demo02',
    runId: A,
    version: 2,
    markdown:
      '# Add passkey (WebAuthn) login\n\nUsers can register a passkey from Settings and sign in with it. Password login stays as the fallback.\n\n## Assumptions\n- Challenge store reuses the existing Redis session client.\n- No account-recovery changes in this run.\n- Lockfile is owned by T6; other tasks request deps through it.\n',
    dag: {
      nodes: nodesA,
      annotations: [
        { kind: 'serializing_edge', nodeIds: ['T4', 'T6'], message: 'T4 and T6 both touch db/schema.ts' },
        { kind: 'cost_estimate', nodeIds: [], message: 'est. $4.10 · ~32 min' },
      ],
    },
    source: 'agent',
    feedback: 'Split the migration out of the registration task.',
    createdAt: now - 46 * MIN,
    approvedAt: now - 42 * MIN,
  };
  const tA = (nodeId: string, patch: Partial<Task>) =>
    task(
      A,
      nodeId,
      {
        branch: `legion/authv2dem/${nodeId.toLowerCase()}`,
        worktreePath: `/Users/dev/Library/Application Support/Legion/worktrees/9f2c/${A}/${nodeId}`,
        startSha: 'a1f3c9e',
        ...patch,
      },
      now,
    );
  const tasksA = [
    tA('T1', { status: 'merged', attemptCount: 1, mergedSha: 'b7e01d2', updatedAt: now - 24 * MIN }),
    tA('T2', {
      status: 'running',
      attemptCount: 1,
      progress: 'Mapping verifyRegistrationResponse failures to the error envelope',
      updatedAt: now - 6 * MIN,
    }),
    tA('T3', {
      status: 'running',
      attemptCount: 1,
      progress: 'Waiting for approval: pnpm add @simplewebauthn/browser@13',
      updatedAt: now - 9 * MIN,
    }),
    tA('T4', { status: 'fixing', attemptCount: 1, fixRounds: 1, updatedAt: now - 2 * MIN }),
    tA('T5', { status: 'blocked', branch: null, worktreePath: null, startSha: null }),
    tA('T6', { status: 'blocked', branch: null, worktreePath: null, startSha: null }),
  ];
  const [t1, t2, t3, t4] = tasksA as [Task, Task, Task, Task];
  const attemptsA: Attempt[] = [
    attempt(
      'att_authplanner1',
      A,
      null,
      { role: 'planner', costUsd: 0.38, startedAt: now - 52 * MIN, endedAt: now - 46 * MIN },
      now,
    ),
    attempt('att_authv2t1code', A, t1.id, { costUsd: 0.61, startedAt: now - 40 * MIN, endedAt: now - 30 * MIN }, now),
    attempt(
      'att_authv2t1revw',
      A,
      t1.id,
      {
        role: 'reviewer',
        engine: 'codex',
        costUsd: null,
        inputTokens: 18_000,
        startedAt: now - 30 * MIN,
        endedAt: now - 27 * MIN,
      },
      now,
    ),
    attempt('att_authv2t2code', A, t2.id, { status: 'running', costUsd: 0.84, startedAt: now - 6 * MIN - 20_000 }, now),
    attempt(
      'att_authv2t3code',
      A,
      t3.id,
      {
        status: 'running',
        engine: 'codex',
        costUsd: null,
        inputTokens: 41_000,
        outputTokens: 3_900,
        startedAt: now - 9 * MIN,
      },
      now,
    ),
    attempt(
      'att_authv2t4code',
      A,
      t4.id,
      { status: 'succeeded', costUsd: 0.47, startedAt: now - 22 * MIN, endedAt: now - 12 * MIN },
      now,
    ),
    attempt(
      'att_authv2t4revw',
      A,
      t4.id,
      { role: 'reviewer', engine: 'codex', inputTokens: 22_000, startedAt: now - 12 * MIN, endedAt: now - 3 * MIN },
      now,
    ),
    attempt('att_authv2t4fix1', A, t4.id, { status: 'running', costUsd: 0.12, startedAt: now - 2 * MIN }, now),
  ];
  const reviewsA: Review[] = [
    {
      id: 'rev_authv2t1rev1',
      runId: A,
      taskId: t1.id,
      attemptId: 'att_authv2t1revw',
      verdict: 'approve',
      criteria: [{ id: 'AC1', status: 'met', evidence: 'auth/contracts.ts exports the WebAuthn types' }],
      findings: [],
      summary: 'Types are minimal and match the plan.',
      createdAt: now - 27 * MIN,
    },
    {
      id: 'rev_authv2t4rev1',
      runId: A,
      taskId: t4.id,
      attemptId: 'att_authv2t4revw',
      verdict: 'request_changes',
      criteria: [
        { id: 'AC1', status: 'met', evidence: 'down() drops table and index' },
        { id: 'AC2', status: 'met', evidence: '0042_passkeys.sql:21' },
        { id: 'AC3', status: 'unmet', evidence: 'see finding below' },
      ],
      findings: [
        {
          severity: 'major',
          file: 'migrations/0042_passkeys.sql',
          line: 14,
          title: 'Sign counter overflows',
          body: 'sign_count is INTEGER; authenticators can report counters above 2³¹. Use BIGINT.',
          suggestedFix: '- sign_count INTEGER NOT NULL\n+ sign_count BIGINT NOT NULL',
        },
        {
          severity: 'nit',
          file: 'db/schema.ts',
          line: 88,
          title: 'Column comment',
          body: 'Document that credential_id is base64url.',
          suggestedFix: null,
        },
      ],
      summary: 'Reversible and indexed, but the sign counter type is too small.',
      createdAt: now - 3 * MIN,
    },
  ];
  const inboxA: InboxItem[] = [
    {
      id: 'inb_authv2appr01',
      runId: A,
      taskId: t3.id,
      attemptId: 'att_authv2t3code',
      kind: 'approval',
      payload: {
        requestId: 'req_1',
        tool: 'shell',
        input: { command: 'pnpm add @simplewebauthn/browser@13' },
        reason: "Not in T3's pre-approved commands. Touches pnpm-lock.yaml, which T6 owns.",
      },
      createdAt: now - 72_000,
      resolvedAt: null,
      resolution: null,
    },
  ];
  const mergesA: Merge[] = [
    {
      id: 'mrg_authv2t1mrg1',
      runId: A,
      taskId: t1.id,
      preSha: 'a1f3c9e',
      postSha: 'b7e01d2',
      status: 'merged',
      error: null,
      createdAt: now - 25 * MIN,
      endedAt: now - 24 * MIN,
    },
  ];
  const verificationsA: Verification[] = [
    {
      id: 'ver_authv2t1pm01',
      runId: A,
      taskId: t1.id,
      attemptId: null,
      phase: 'post_merge',
      command: 'pnpm typecheck && pnpm test',
      exitCode: 0,
      outputTail: '✓ 212 passed',
      durationMs: 41_000,
      createdAt: now - 24 * MIN,
    },
    {
      id: 'ver_authv2t4vf01',
      runId: A,
      taskId: t4.id,
      attemptId: 'att_authv2t4code',
      phase: 'task',
      command: 'pnpm vitest run db',
      exitCode: 0,
      outputTail: '✓ 9 passed',
      durationMs: 6_100,
      createdAt: now - 12 * MIN,
    },
  ];

  // --- Run B: PDF export (PR ready) ----------------------------------------------------------------
  const nodesB: TaskNode[] = [
    node({
      id: 'T1',
      title: 'Invoice view model',
      goal: 'Shape invoice data for rendering.',
      kind: 'contracts',
      dependsOn: [],
      size: 'S',
      risk: 'low',
      engine: 'claude',
    }),
    node({
      id: 'T2',
      title: 'PDF renderer',
      goal: 'Render invoices to PDF.',
      kind: 'feature',
      dependsOn: ['T1'],
      size: 'M',
      risk: 'med',
      engine: 'codex',
    }),
    node({
      id: 'T3',
      title: 'Download endpoint',
      goal: 'GET /invoices/:id.pdf',
      kind: 'feature',
      dependsOn: ['T1'],
      size: 'S',
      risk: 'low',
      engine: 'claude',
    }),
    node({
      id: 'T4',
      title: 'Export button',
      goal: 'Button on the invoice page.',
      kind: 'feature',
      dependsOn: ['T3'],
      size: 'S',
      risk: 'low',
      engine: 'codex',
    }),
    node({
      id: 'T5',
      title: 'Snapshot tests',
      goal: 'Golden PDFs.',
      kind: 'test',
      dependsOn: ['T2', 'T4'],
      size: 'S',
      risk: 'low',
      engine: 'claude',
    }),
  ];
  const planB: Plan = {
    id: 'plan_pdfexport01',
    runId: B,
    version: 1,
    markdown: '# Invoice PDF export\n\nExport any invoice as a PDF from the invoice page.\n',
    dag: { nodes: nodesB, annotations: [] },
    source: 'agent',
    feedback: null,
    createdAt: now - 180 * MIN,
    approvedAt: now - 176 * MIN,
  };
  const tasksB = nodesB.map((n, i) =>
    task(
      B,
      n.id,
      { status: 'merged', attemptCount: 1, mergedSha: `c0ffee${i}`, updatedAt: now - (90 - i * 8) * MIN },
      now,
    ),
  );
  const attemptsB = tasksB.map((t, i) =>
    attempt(
      `att_pdfexport${i}c`,
      B,
      t.id,
      {
        engine: i % 2 ? 'codex' : 'claude',
        costUsd: i % 2 ? null : 0.4 + i * 0.1,
        startedAt: now - (150 - i * 10) * MIN,
        endedAt: now - (140 - i * 10) * MIN,
      },
      now,
    ),
  );
  const inboxB: InboxItem[] = [
    {
      id: 'inb_pdfexportpr1',
      runId: B,
      taskId: null,
      attemptId: null,
      kind: 'pr_ready',
      payload: {
        integrationBranch: 'legion/pdfexpor/integration',
        title: 'Invoice PDF export',
        body: '5/5 tasks merged.',
      },
      createdAt: now - 31 * MIN,
      resolvedAt: null,
      resolution: null,
    },
  ];

  // --- Run C: i18n (plan sign-off) ------------------------------------------------------------------
  const nodesC: TaskNode[] = [
    node({
      id: 'T1',
      title: 'Message catalog format',
      goal: 'ICU catalogs and loader.',
      kind: 'contracts',
      dependsOn: [],
      size: 'S',
      risk: 'low',
      engine: 'claude',
    }),
    node({
      id: 'T2',
      title: 'Extract settings strings',
      goal: 'Move settings copy into the catalog.',
      kind: 'refactor',
      dependsOn: ['T1'],
      size: 'M',
      risk: 'low',
      engine: 'codex',
    }),
    node({
      id: 'T3',
      title: 'Extract auth strings',
      goal: 'Move auth copy into the catalog.',
      kind: 'refactor',
      dependsOn: ['T1'],
      size: 'M',
      risk: 'low',
      engine: 'codex',
    }),
    node({
      id: 'T4',
      title: 'Extract billing strings',
      goal: 'Move billing copy into the catalog.',
      kind: 'refactor',
      dependsOn: ['T1'],
      size: 'M',
      risk: 'low',
      engine: 'claude',
    }),
    node({
      id: 'T5',
      title: 'Locale switcher',
      goal: 'Header locale menu.',
      kind: 'feature',
      dependsOn: ['T1'],
      size: 'S',
      risk: 'low',
      engine: 'codex',
    }),
    node({
      id: 'T6',
      title: 'Lint rule for raw strings',
      goal: 'Forbid hard-coded UI strings.',
      kind: 'test',
      dependsOn: ['T2', 'T3', 'T4'],
      size: 'S',
      risk: 'low',
      engine: 'claude',
    }),
    node({
      id: 'T7',
      title: 'Docs',
      goal: 'Translator guide.',
      kind: 'docs',
      dependsOn: ['T6'],
      size: 'S',
      risk: 'low',
      engine: 'claude',
    }),
  ];
  const planC: Plan = {
    id: 'plan_i18nextrac1',
    runId: C,
    version: 1,
    markdown: '# Extract UI strings for i18n\n\nMove user-facing copy into ICU message catalogs.\n',
    dag: {
      nodes: nodesC,
      annotations: [
        { kind: 'serializing_edge', nodeIds: ['T2', 'T3'], message: 'T2 and T3 both touch web/src/i18n/en.json' },
        { kind: 'cost_estimate', nodeIds: [], message: 'est. $4–6 · ~25 min' },
      ],
    },
    source: 'agent',
    feedback: null,
    createdAt: now - 4 * MIN,
    approvedAt: null,
  };
  const inboxC: InboxItem[] = [
    {
      id: 'inb_i18nsignoff1',
      runId: C,
      taskId: null,
      attemptId: null,
      kind: 'plan_signoff',
      payload: { planId: planC.id, version: 1 },
      createdAt: now - 4 * MIN,
      resolvedAt: null,
      resolution: null,
    },
  ];

  const runs: Run[] = [
    run({
      id: A,
      title: 'Add passkey (WebAuthn) login',
      status: 'executing',
      createdAt: now - 210 * MIN,
      updatedAt: now - 2 * MIN,
      integrationBranch: 'legion/authv2de/integration',
      issueText: 'Users want to sign in with passkeys.',
      issueUrl: 'https://github.com/erudiet/app/issues/412',
    }),
    run({
      id: B,
      title: 'Invoice PDF export',
      status: 'pr_ready',
      createdAt: now - 190 * MIN,
      updatedAt: now - 31 * MIN,
      integrationBranch: 'legion/pdfexpor/integration',
      plannerEngine: 'codex',
    }),
    run({
      id: C,
      title: 'Extract UI strings for i18n',
      status: 'awaiting_approval',
      createdAt: now - 9 * MIN,
      updatedAt: now - 4 * MIN,
      repoPath: '/Users/dev/src/erudiet/web',
    }),
  ];

  const transcripts: Record<string, AgentEvent[]> = {
    att_authv2t2code: [
      { type: 'session_started', sessionId: 'sess_t2', model: 'claude-opus', version: '2.1.289' },
      { type: 'tool_call', id: 'c1', name: 'Read', input: { file_path: 'auth/contracts.ts' }, kind: 'read' },
      { type: 'tool_result', id: 'c1', ok: true, output: null },
      {
        type: 'message',
        text: "Registration needs a short-lived challenge store. I'll reuse the session Redis client instead of adding a table; T4 owns migrations.",
      },
      { type: 'tool_call', id: 'c2', name: 'Edit', input: { file_path: 'server/auth/webauthn.ts' }, kind: 'edit' },
      { type: 'file_change', path: 'server/auth/webauthn.ts', added: 142, removed: 0 },
      { type: 'tool_call', id: 'c3', name: 'Edit', input: { file_path: 'server/routes/auth.ts' }, kind: 'edit' },
      { type: 'file_change', path: 'server/routes/auth.ts', added: 38, removed: 4 },
      { type: 'tool_call', id: 'c4', name: 'Bash', input: { command: 'pnpm vitest run server/auth' }, kind: 'command' },
      { type: 'tool_result', id: 'c4', ok: true, output: '✓ 14 passed (1.8s)' },
      { type: 'usage', inputTokens: 52_000, outputTokens: 6_100, costUsd: 0.84 },
      { type: 'rate_limit', engine: 'claude', window: '5h', usedPct: 38, resetsAt: now + 140 * MIN },
      {
        type: 'message',
        text: "Tests pass. Now mapping verifyRegistrationResponse failures to the API's error envelope so the client gets stable codes.",
      },
    ],
    att_authv2t3code: [
      { type: 'session_started', sessionId: 'thr_t3', model: 'gpt-5-codex', version: '0.160.0' },
      {
        type: 'todo',
        items: [
          { text: 'Scaffold PasskeyList in Settings', status: 'completed' },
          { text: 'Hook into useSettings', status: 'completed' },
          { text: 'Browser WebAuthn wrapper', status: 'in_progress' },
          { text: 'Component tests', status: 'pending' },
        ],
      },
      {
        type: 'tool_call',
        id: 'x1',
        name: 'shell',
        input: { command: 'rg -n "useSettings" web/src' },
        kind: 'command',
      },
      { type: 'tool_result', id: 'x1', ok: true, output: '12 matches' },
      { type: 'file_change', path: 'web/src/settings/Passkeys.tsx', added: 64, removed: 0 },
      { type: 'rate_limit', engine: 'codex', window: 'weekly', usedPct: 61, resetsAt: now + 3 * 24 * 60 * MIN },
      {
        type: 'approval_request',
        requestId: 'req_1',
        tool: 'shell',
        input: { command: 'pnpm add @simplewebauthn/browser@13' },
        reason: 'Adds a dependency',
      },
    ],
    att_authv2t4revw: [
      { type: 'session_started', sessionId: 'thr_t4r', model: 'gpt-5-codex', version: '0.160.0' },
      { type: 'tool_call', id: 'r1', name: 'shell', input: { command: 'git diff a1f3c9e..HEAD' }, kind: 'command' },
      { type: 'message', text: 'sign_count is INTEGER; authenticators can report counters above 2³¹.' },
      { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
    ],
    att_authv2t4fix1: [
      { type: 'session_started', sessionId: 'sess_t4', model: 'claude-opus', version: '2.1.289' },
      {
        type: 'message',
        text: 'Addressing review finding: switching sign_count to BIGINT and adding a migration test.',
      },
      { type: 'file_change', path: 'migrations/0042_passkeys.sql', added: 1, removed: 1 },
    ],
    att_authv2t1code: [
      { type: 'message', text: 'Added WebAuthn types and the passkey API contracts.' },
      { type: 'file_change', path: 'auth/contracts.ts', added: 212, removed: 8 },
      { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
    ],
  };

  const engines: EngineInfo[] = [
    {
      kind: 'claude',
      installed: true,
      path: '/opt/homebrew/bin/claude',
      version: '2.1.289',
      loggedIn: true,
      account: 'dev@erudiet.com · Max',
      models: ['opus', 'sonnet', 'haiku'],
      error: null,
      probedAt: now,
    },
    {
      kind: 'codex',
      installed: true,
      path: '/opt/homebrew/bin/codex',
      version: '0.160.0',
      loggedIn: true,
      account: 'ChatGPT Pro',
      models: ['gpt-5-codex'],
      error: null,
      probedAt: now,
    },
  ];

  const world: DemoWorld = {
    runs,
    plans: [planA, planB, planC],
    tasks: [...tasksA, ...tasksB],
    attempts: [
      ...attemptsA,
      ...attemptsB,
      attempt(
        'att_i18nplanner1',
        C,
        null,
        { role: 'planner', costUsd: 0.38, startedAt: now - 8 * MIN, endedAt: now - 4 * MIN },
        now,
      ),
    ],
    reviews: reviewsA,
    inbox: [...inboxA, ...inboxB, ...inboxC],
    verifications: verificationsA,
    merges: mergesA,
    transcripts,
    engines,
    settings: { ...DEFAULT_SETTINGS, concurrency: { ...DEFAULT_SETTINGS.concurrency, global: 4 } },
  };
  return withSessionDemo(world, now);
}

export function snapshotOf(world: DemoWorld, runId: string, seq: number): RunSnapshot | null {
  const run = world.runs.find((r) => r.id === runId);
  if (!run) return null;
  const of = <T extends { runId: string }>(rows: T[]) => structuredClone(rows.filter((r) => r.runId === runId));
  return {
    seq,
    run: structuredClone(run),
    plans: of(world.plans),
    tasks: of(world.tasks),
    attempts: of(world.attempts),
    reviews: of(world.reviews),
    inbox: of(world.inbox),
    verifications: of(world.verifications),
    merges: of(world.merges),
  };
}

/** Live script: what the running agents "do" while the demo is open. */
export const LIVE_SCRIPT: { attemptId: string; event: AgentEvent }[] = [
  {
    attemptId: 'att_authv2t2code',
    event: { type: 'tool_call', id: 'l1', name: 'Edit', input: { file_path: 'server/auth/errors.ts' }, kind: 'edit' },
  },
  {
    attemptId: 'att_authv2t2code',
    event: { type: 'file_change', path: 'server/auth/errors.ts', added: 27, removed: 3 },
  },
  {
    attemptId: 'att_authv2t4fix1',
    event: { type: 'tool_call', id: 'l2', name: 'Bash', input: { command: 'pnpm vitest run db' }, kind: 'command' },
  },
  {
    attemptId: 'att_authv2t2code',
    event: {
      type: 'tool_call',
      id: 'l3',
      name: 'Bash',
      input: { command: 'pnpm vitest run server/auth' },
      kind: 'command',
    },
  },
  { attemptId: 'att_authv2t4fix1', event: { type: 'message', text: 'Migration test covers counters above 2³¹ now.' } },
  {
    attemptId: 'att_authv2t2code',
    event: {
      type: 'message',
      text: 'Error envelope mapped: INVALID_ATTESTATION, CHALLENGE_EXPIRED, UNKNOWN_CREDENTIAL.',
    },
  },
];
