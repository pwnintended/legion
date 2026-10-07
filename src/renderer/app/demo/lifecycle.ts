/**
 * Demo fixtures for the ends of a run's life (additive to fixtures.ts / sessions.ts / plan-review.ts):
 * - "Move cron jobs onto the queue": executing, T2 failed all its attempts and escalated to the inbox (retry /
 *   skip / edit / abort), T3 is blocked behind it;
 * - "Dark mode tokens": done, its PR merged on GitHub, ready to archive;
 * - "Upgrade to Node 24": already archived (only listed with "Show archived").
 * `Run.pr`, `Run.archived` and `Task.report` are engine fields that may not exist in this build's types yet,
 * hence the loose `extra()` writes.
 */
import type { Attempt, InboxItem, Merge, Plan, Run, Task, TaskNode, Verification } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import type { DemoWorld } from './fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const FAILING_RUN_ID = 'run_cronqueue001';
export const DONE_RUN_ID = 'run_darkmode0001';
export const ARCHIVED_RUN_ID = 'run_node24upgr01';

/** Attach fields the shared types don't know yet. */
export function extra<T extends object>(row: T, fields: Record<string, unknown>): T {
  return Object.assign(row, fields);
}

function node(
  id: string,
  title: string,
  goal: string,
  dependsOn: string[],
  engine: 'claude' | 'codex',
  touches: string[],
) {
  return {
    id,
    title,
    goal,
    kind: 'feature',
    dependsOn,
    acceptanceCriteria: [{ id: 'AC1', text: `${title} works end to end` }],
    touches: touches.map((glob) => ({ glob, mode: 'modify' as const })),
    size: 'M',
    verify: { commands: ['pnpm test jobs'] },
    contextHints: { files: [], notes: '' },
    agent: { engine, model: null, effort: 'high' },
    risk: 'low',
  } satisfies TaskNode;
}

function run(spec: Pick<Run, 'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'> & Partial<Run>): Run {
  return {
    repoPath: '/Users/dev/src/erudiet/api',
    baseRef: 'main',
    issueText: '',
    issueUrl: null,
    paused: false,
    plannerEngine: 'claude',
    plannerModel: null,
    integrationBranch: `legion/${spec.id.slice(4, 12)}/integration`,
    prUrl: null,
    error: null,
    ...spec,
  };
}

function task(runId: string, nodeId: string, patch: Partial<Task>, at: number): Task {
  return {
    id: `task_${runId.slice(4)}${nodeId.toLowerCase()}`,
    runId,
    nodeId,
    status: 'merged',
    branch: `legion/${runId.slice(4, 12)}/${nodeId.toLowerCase()}`,
    worktreePath: `/Users/dev/Library/Application Support/Legion/worktrees/7a1e/${runId}/${nodeId}`,
    startSha: '9c0e4a1',
    attemptCount: 1,
    fixRounds: 0,
    mergedSha: null,
    engineOverride: null,
    modelOverride: null,
    effortOverride: null,
    progress: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    ...patch,
  };
}

function attempt(id: string, runId: string, taskId: string | null, patch: Partial<Attempt>): Attempt {
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
    startedAt: 0,
    endedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    error: null,
    ...patch,
  };
}

function plan(runId: string, nodes: TaskNode[], markdown: string, at: number): Plan {
  return {
    id: `plan_${runId.slice(4, 14)}`,
    runId,
    version: 1,
    markdown,
    dag: { nodes, annotations: [] },
    source: 'agent',
    feedback: null,
    createdAt: at,
    approvedAt: at + 2 * MIN,
  };
}

const TIMEOUT = [
  ' RUN  v3.2.4 /repo',
  '',
  ' ❯ jobs/queue.test.ts (9 tests | 2 failed) 30.2s',
  '   × drains the nightly digest queue',
  '     → Test timed out in 15000ms.',
  '   × retries a failed job with backoff',
  '     → Test timed out in 15000ms.',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  2 failed | 7 passed (9)',
].join('\n');

function failedAttempt(n: number): AgentEvent[] {
  return [
    { type: 'session_started', sessionId: `sess_cron_t2_${n}`, model: 'claude-opus-4', version: '2.1.289' },
    ...(n > 1
      ? [
          {
            type: 'message',
            text: `Attempt ${n}: last time \`drains the nightly digest queue\` timed out. Trying ${n === 2 ? 'a shorter poll interval' : 'fake timers around the backoff'}.`,
          } satisfies AgentEvent,
        ]
      : []),
    { type: 'tool_call', id: `e${n}`, name: 'Edit', input: { file_path: 'jobs/queue.ts' }, kind: 'edit' },
    { type: 'file_change', path: 'jobs/queue.ts', added: 40 + n * 6, removed: 12 },
    { type: 'tool_call', id: `t${n}`, name: 'Bash', input: { command: 'pnpm test jobs' }, kind: 'command' },
    { type: 'tool_result', id: `t${n}`, ok: false, output: TIMEOUT },
    { type: 'error', message: 'Verify failed: pnpm test jobs exited with code 1 (2 tests timed out)', retryable: true },
    { type: 'turn_complete', structuredOutput: null, isError: true, reason: 'verify_failed' },
  ];
}

export function withLifecycleDemo(world: DemoWorld, now: number): DemoWorld {
  // --- E: failing task + escalation ------------------------------------------------------------------
  const E = FAILING_RUN_ID;
  const nodesE = [
    node('T1', 'Queue adapter', 'A BullMQ-backed queue with the same API as the cron runner.', [], 'claude', [
      'jobs/adapter.ts',
    ]),
    node('T2', 'Move nightly jobs', 'Run the nightly digest and cleanup jobs from the queue.', ['T1'], 'claude', [
      'jobs/**',
    ]),
    node('T3', 'Remove the cron runner', 'Delete the old cron runner and its config.', ['T2'], 'codex', ['cron/**']),
    node('T4', 'Queue dashboard route', 'Admin route listing queued and failed jobs.', ['T1'], 'codex', [
      'server/admin/**',
    ]),
  ];
  const createdE = now - 70 * MIN;
  const tE = (id: string, patch: Partial<Task>) => task(E, id, patch, createdE + 6 * MIN);
  const tasksE = [
    tE('T1', { status: 'merged', mergedSha: '5b1d9e0', updatedAt: now - 40 * MIN }),
    tE('T2', {
      status: 'failed',
      attemptCount: 3,
      error: 'pnpm test jobs timed out after 3 attempts',
      updatedAt: now - 3 * MIN,
    }),
    tE('T3', { status: 'blocked', branch: null, worktreePath: null, startSha: null }),
    tE('T4', { status: 'running', progress: 'Listing failed jobs with their last error' }),
  ];
  const [, t2, , t4] = tasksE as [Task, Task, Task, Task];
  const attemptsE: Attempt[] = [
    attempt('att_cronplanner1', E, null, {
      role: 'planner',
      costUsd: 0.31,
      startedAt: createdE,
      endedAt: createdE + 4 * MIN,
    }),
    attempt('att_cront1code01', E, tasksE[0]?.id ?? null, {
      costUsd: 0.42,
      startedAt: now - 60 * MIN,
      endedAt: now - 46 * MIN,
    }),
    ...[1, 2, 3].map((n) =>
      attempt(`att_cront2code0${n}`, E, t2.id, {
        status: 'failed',
        costUsd: 0.3 + n * 0.08,
        startedAt: now - (40 - n * 11) * MIN,
        endedAt: now - (31 - n * 9.5) * MIN,
        error: 'Verify failed: pnpm test jobs (2 tests timed out)',
      }),
    ),
    attempt('att_cront4code01', E, t4.id, {
      engine: 'codex',
      status: 'running',
      startedAt: now - 9 * MIN,
      inputTokens: 21_000,
      outputTokens: 1_800,
    }),
  ];
  const escalation: InboxItem = {
    id: 'inb_cronescal001',
    runId: E,
    taskId: t2.id,
    attemptId: 'att_cront2code03',
    kind: 'escalation',
    payload: {
      reason: 'attempts_exhausted',
      summary:
        'T2 failed 3 attempts: pnpm test jobs times out in "drains the nightly digest queue". The queue waits on a real Redis connection the test environment does not have.',
      actions: ['retry', 'skip', 'edit', 'abort'],
    },
    createdAt: now - 40_000,
    resolvedAt: null,
    resolution: null,
  };
  const runE = run({
    id: E,
    title: 'Move cron jobs onto the queue',
    status: 'executing',
    createdAt: createdE,
    updatedAt: now - 3 * MIN,
    issueUrl: 'https://github.com/erudiet/api/issues/455',
    issueText: 'Cron jobs overlap when a deploy restarts the box. Run them from the job queue instead.',
  });

  // --- F: done, PR merged ----------------------------------------------------------------------------
  const F = DONE_RUN_ID;
  const createdF = now - 27 * HOUR;
  const nodesF = [
    node('T1', 'Color tokens', 'Semantic color tokens for light and dark.', [], 'claude', ['web/src/theme/**']),
    node('T2', 'Theme switcher', 'Settings toggle that follows the OS by default.', ['T1'], 'codex', [
      'web/src/settings/**',
    ]),
    node('T3', 'Migrate components', 'Replace hard-coded colors with tokens.', ['T1'], 'claude', [
      'web/src/components/**',
    ]),
  ];
  const tasksF = nodesF.map((n, i) =>
    task(F, n.id, { mergedSha: `d4e${i}a7c`, updatedAt: createdF + (3 + i) * HOUR }, createdF + HOUR),
  );
  const attemptsF = tasksF.map((t, i) =>
    attempt(`att_dark${t.nodeId.toLowerCase()}code1`, F, t.id, {
      engine: i === 1 ? 'codex' : 'claude',
      costUsd: i === 1 ? null : 0.5 + i * 0.2,
      startedAt: createdF + (1 + i) * HOUR,
      endedAt: createdF + (2 + i) * HOUR,
    }),
  );
  const prUrlF = 'https://github.com/erudiet/web/pull/398';
  const runF = extra(
    run({
      id: F,
      title: 'Dark mode tokens',
      status: 'done',
      repoPath: '/Users/dev/src/erudiet/web',
      createdAt: createdF,
      updatedAt: now - 2 * HOUR,
      prUrl: prUrlF,
    }),
    { pr: { url: prUrlF, number: 398, state: 'merged', isDraft: false }, archived: false },
  );

  // --- G: archived ------------------------------------------------------------------------------------
  const G = ARCHIVED_RUN_ID;
  const prUrlG = 'https://github.com/erudiet/api/pull/371';
  const runG = extra(
    run({
      id: G,
      title: 'Upgrade to Node 24',
      status: 'done',
      createdAt: now - 6 * 24 * HOUR,
      updatedAt: now - 5 * 24 * HOUR,
      prUrl: prUrlG,
    }),
    { pr: { url: prUrlG, number: 371, state: 'merged', isDraft: false }, archived: true },
  );
  const nodesG = [node('T1', 'Bump engines and CI images', 'Node 24 everywhere.', [], 'codex', ['**'])];
  const tasksG = [task(G, 'T1', { updatedAt: now - 5 * 24 * HOUR }, now - 6 * 24 * HOUR)];

  // Merges (in order) with post-merge verification, plus the final verify, for the finished runs.
  const merges: Merge[] = [];
  const verifications: Verification[] = [];
  for (const t of [...tasksE, ...tasksF].filter((t) => t.status === 'merged')) {
    const i = merges.filter((m) => m.runId === t.runId).length;
    const pre = i === 0 ? '9c0e4a1' : (merges.at(-1)?.postSha ?? '9c0e4a1');
    merges.push({
      id: `mrg_${t.id.slice(-10)}`,
      runId: t.runId,
      taskId: t.id,
      preSha: pre,
      postSha: t.mergedSha,
      status: 'merged',
      error: null,
      createdAt: t.updatedAt - 50_000,
      endedAt: t.updatedAt,
    });
    verifications.push({
      id: `ver_${t.id.slice(-10)}pm`,
      runId: t.runId,
      taskId: t.id,
      attemptId: null,
      phase: 'post_merge',
      command: t.runId === F ? 'pnpm typecheck && pnpm test' : 'pnpm test jobs',
      exitCode: 0,
      outputTail: `✓ ${180 + i * 7} passed`,
      durationMs: 31_000 + i * 1_800,
      createdAt: t.updatedAt + 1,
    });
  }
  for (const [i, command] of ['pnpm typecheck', 'pnpm lint', 'pnpm test'].entries())
    verifications.push({
      id: `ver_darkfinal${i}`,
      runId: F,
      taskId: null,
      attemptId: null,
      phase: 'final',
      command,
      exitCode: 0,
      outputTail: ['tsc --noEmit · 0 errors', 'Checked 311 files · 0 problems', '✓ 201 passed'][i] ?? '',
      durationMs: [8_200, 1_100, 19_400][i] ?? 0,
      createdAt: createdF + 6 * HOUR + i,
    });

  // Every finished task carries the coder's structured report (the review pack's "Agent reports").
  for (const t of [...tasksE.filter((t) => t.status === 'merged'), ...tasksF, ...tasksG])
    extra(t, {
      report: { summary: `${t.nodeId} done: changes merged with green verify.`, commitMessage: `${t.nodeId}` },
    });

  return {
    ...world,
    runs: [...world.runs, runE, runF, runG],
    plans: [
      ...world.plans,
      plan(
        E,
        nodesE,
        '# Move cron jobs onto the queue\n\nRun scheduled jobs from BullMQ so restarts never double-run them.\n',
        createdE,
      ),
      plan(F, nodesF, '# Dark mode tokens\n\nSemantic color tokens and a theme switcher.\n', createdF),
      plan(G, nodesG, '# Upgrade to Node 24\n', now - 6 * 24 * HOUR),
    ],
    tasks: [...world.tasks, ...tasksE, ...tasksF, ...tasksG],
    attempts: [...world.attempts, ...attemptsE, ...attemptsF],
    inbox: [...world.inbox, escalation],
    merges: [...world.merges, ...merges],
    verifications: [...world.verifications, ...verifications],
    transcripts: {
      ...world.transcripts,
      att_cront2code01: failedAttempt(1),
      att_cront2code02: failedAttempt(2),
      att_cront2code03: failedAttempt(3),
      att_cront4code01: [
        { type: 'session_started', sessionId: 'thr_cron_t4', model: 'gpt-5-codex', version: '0.160.0' },
        { type: 'tool_call', id: 'd1', name: 'read', input: { path: 'server/admin/index.ts' }, kind: 'read' },
        { type: 'file_change', path: 'server/admin/jobs.ts', added: 58, removed: 0 },
        { type: 'message', text: 'The jobs route lists queued and failed jobs; adding the last error per failed job.' },
      ],
    },
  };
}
