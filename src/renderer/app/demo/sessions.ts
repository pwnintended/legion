/**
 * Demo fixtures for session tiles, clarify and the inbox (additive to fixtures.ts):
 * - rich, realistic transcripts for the passkeys run (Claude T2 streaming, Codex T3 waiting on an approval,
 *   Codex reviewing T4 and Claude fixing it, a long T1 history to exercise windowing);
 * - a fourth run, "Rate-limit the public API", whose planner is waiting on three clarifying questions;
 * - a budget warning, so the inbox shows every common kind.
 */
import type { Attempt, InboxItem, Run } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import type { DemoWorld } from './fixtures';

const MIN = 60_000;
export const CLARIFY_RUN_ID = 'run_ratelimit001';

/** T2's last message streams in: part of it is history, the rest arrives live. */
const T2_STREAM = [
  'Tests pass. Now mapping ',
  '`verifyRegistrationResponse` failures to the ',
  "API's error envelope so the client gets stable codes:\n\n",
  '- `INVALID_ATTESTATION` when the authenticator response does not verify\n',
  '- `CHALLENGE_EXPIRED` when the Redis challenge is gone (410)\n',
  '- `UNKNOWN_CREDENTIAL` for unregistered credential ids',
];
const T2_STREAMED = 3;

const read = (id: string, path: string): AgentEvent[] => [
  { type: 'tool_call', id, name: 'Read', input: { file_path: path }, kind: 'read' },
  { type: 'tool_result', id, ok: true, output: null },
];

function t2(now: number): AgentEvent[] {
  return [
    { type: 'session_started', sessionId: 'sess_t2', model: 'claude-opus-4', version: '2.1.289' },
    {
      type: 'reasoning',
      text: 'The contracts already define RegistrationOptions and the verify payload. Registration is two calls: options (needs a challenge stored per user, short TTL) and verify. Migrations belong to T4, so the challenge store cannot be a table. The session Redis client is already injected into the auth router.',
    },
    ...read('c1', 'auth/contracts.ts'),
    ...read('c2', 'server/routes/index.ts'),
    ...read('c3', 'server/session/redis.ts'),
    {
      type: 'message',
      text: "Registration needs a short-lived challenge store. I'll reuse the session Redis client instead of adding a table; **T4 owns migrations**.",
    },
    {
      type: 'todo',
      items: [
        { text: 'Options endpoint with Redis challenge (TTL 300s)', status: 'completed' },
        { text: 'Verify endpoint', status: 'completed' },
        { text: 'Map verification failures to the error envelope', status: 'in_progress' },
        { text: 'Route tests', status: 'pending' },
      ],
    },
    { type: 'tool_call', id: 'c4', name: 'Edit', input: { file_path: 'server/auth/webauthn.ts' }, kind: 'edit' },
    { type: 'file_change', path: 'server/auth/webauthn.ts', added: 142, removed: 0 },
    { type: 'tool_call', id: 'c5', name: 'Edit', input: { file_path: 'server/routes/auth.ts' }, kind: 'edit' },
    { type: 'file_change', path: 'server/routes/auth.ts', added: 38, removed: 4 },
    {
      type: 'tool_call',
      id: 'c6',
      name: 'Bash',
      input: { command: 'pnpm vitest run server/auth' },
      kind: 'command',
    },
    {
      type: 'tool_result',
      id: 'c6',
      ok: false,
      output: [
        ' RUN  v3.2.4 /repo',
        '',
        ' ❯ server/auth/webauthn.test.ts (14 tests | 1 failed) 212ms',
        '   × verify rejects an expired challenge',
        '     → expected 400 to be 410',
        '',
        ' Test Files  1 failed | 1 passed (2)',
        '      Tests  1 failed | 13 passed (14)',
      ].join('\n'),
    },
    {
      type: 'message',
      text: 'One failure: an expired challenge returns `400` instead of `410 Gone`. The Redis `GET` returns `null` after the TTL and I treated that as a malformed request.',
    },
    { type: 'tool_call', id: 'c7', name: 'Edit', input: { file_path: 'server/auth/webauthn.ts' }, kind: 'edit' },
    { type: 'file_change', path: 'server/auth/webauthn.ts', added: 6, removed: 2 },
    {
      type: 'tool_call',
      id: 'c8',
      name: 'Bash',
      input: { command: 'pnpm vitest run server/auth' },
      kind: 'command',
    },
    {
      type: 'tool_result',
      id: 'c8',
      ok: true,
      output: [
        ' ✓ server/auth/webauthn.test.ts (14 tests) 198ms',
        ' ✓ server/routes/auth.test.ts (6 tests) 41ms',
        '',
        ' Test Files  2 passed (2)',
        '      Tests  20 passed (1.8s)',
      ].join('\n'),
    },
    {
      type: 'tool_call',
      id: 'c9',
      name: 'mcp__legion__report_progress',
      input: { summary: 'Registration endpoints green; mapping verification failures to the error envelope' },
      kind: 'mcp',
    },
    { type: 'tool_result', id: 'c9', ok: true, output: '{"ok":true}' },
    { type: 'usage', inputTokens: 52_000, outputTokens: 6_100, costUsd: 0.84 },
    { type: 'rate_limit', engine: 'claude', window: '5h', usedPct: 38, resetsAt: now + 140 * MIN },
    ...T2_STREAM.slice(0, T2_STREAMED).map((text): AgentEvent => ({ type: 'text_delta', text })),
  ];
}

function t3(now: number): AgentEvent[] {
  return [
    { type: 'session_started', sessionId: 'thr_t3', model: 'gpt-5-codex', version: '0.160.0' },
    {
      type: 'reasoning',
      text: 'Settings sections are registered in web/src/settings/registry.ts. A Passkeys section can sit next to Sessions and reuse its list styling.',
    },
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
      input: { command: ['bash', '-lc', 'rg -n "useSettings" web/src'] },
      kind: 'command',
    },
    {
      type: 'tool_result',
      id: 'x1',
      ok: true,
      output: [
        'web/src/settings/index.tsx:12:  const settings = useSettings();',
        'web/src/settings/Sessions.tsx:8:import { useSettings } from "./useSettings";',
        'web/src/settings/Profile.tsx:5:import { useSettings } from "./useSettings";',
        '12 matches',
      ].join('\n'),
    },
    { type: 'tool_call', id: 'x2', name: 'read', input: { path: 'web/src/settings/registry.ts' }, kind: 'read' },
    { type: 'tool_call', id: 'x3', name: 'read', input: { path: 'web/src/settings/Sessions.tsx' }, kind: 'read' },
    { type: 'file_change', path: 'web/src/settings/Passkeys.tsx', added: 64, removed: 0 },
    { type: 'file_change', path: 'web/src/settings/registry.ts', added: 3, removed: 0 },
    { type: 'usage', inputTokens: 41_000, outputTokens: 3_900, costUsd: null },
    { type: 'rate_limit', engine: 'codex', window: 'weekly', usedPct: 61, resetsAt: now + 3 * 24 * 60 * MIN },
    {
      type: 'message',
      text: '`PasskeyList` renders registered passkeys with rename and remove. The browser half needs `@simplewebauthn/browser` for `startRegistration()`; asking before touching the lockfile.',
    },
    {
      type: 'approval_request',
      requestId: 'req_1',
      tool: 'shell',
      input: { command: 'pnpm add @simplewebauthn/browser@13' },
      reason: 'Adds a dependency',
    },
  ];
}

function t4Review(): AgentEvent[] {
  return [
    { type: 'session_started', sessionId: 'thr_t4r', model: 'gpt-5-codex', version: '0.160.0' },
    {
      type: 'tool_call',
      id: 'r1',
      name: 'shell',
      input: { command: ['bash', '-lc', 'git diff a1f3c9e..HEAD --stat'] },
      kind: 'command',
    },
    {
      type: 'tool_result',
      id: 'r1',
      ok: true,
      output:
        ' db/schema.ts                 | 18 +++++\n migrations/0042_passkeys.sql | 31 ++++++++\n 2 files changed, 49 insertions(+)',
    },
    { type: 'tool_call', id: 'r2', name: 'read', input: { path: 'migrations/0042_passkeys.sql' }, kind: 'read' },
    { type: 'tool_call', id: 'r3', name: 'read', input: { path: 'db/schema.ts' }, kind: 'read' },
    {
      type: 'message',
      text: 'Checked AC1–AC3 against the diff.\n\n- **AC1** reversible: `down()` drops the table and the index.\n- **AC2** unique index on `credential_id` (line 21).\n- **AC3** not met: `sign_count` is `INTEGER`; authenticators can report counters above 2³¹.\n\n```sql\n- sign_count INTEGER NOT NULL\n+ sign_count BIGINT NOT NULL\n```',
    },
    { type: 'usage', inputTokens: 22_000, outputTokens: 1_400, costUsd: null },
    { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
  ];
}

function t4Fix(): AgentEvent[] {
  return [
    { type: 'session_started', sessionId: 'sess_t4', model: 'claude-opus-4', version: '2.1.289' },
    {
      type: 'message',
      text: 'Addressing the review finding: switching `sign_count` to `BIGINT` and adding a repository test that bumps the counter past 2³².',
    },
    {
      type: 'tool_call',
      id: 'f1',
      name: 'Edit',
      input: { file_path: 'migrations/0042_passkeys.sql' },
      kind: 'edit',
    },
    { type: 'file_change', path: 'migrations/0042_passkeys.sql', added: 1, removed: 1 },
    {
      type: 'tool_call',
      id: 'f2',
      name: 'Edit',
      input: { file_path: 'server/db/passkeys.repo.test.ts' },
      kind: 'edit',
    },
    // Stays inside T4's declared touches (server/db/passkeys.repo*.ts): the review pack's scope gate is green.
    { type: 'file_change', path: 'server/db/passkeys.repo.test.ts', added: 7, removed: 1 },
    { type: 'tool_call', id: 'f3', name: 'Bash', input: { command: 'pnpm vitest run db' }, kind: 'command' },
  ];
}

/** A long, finished history (windowing / content-visibility). */
function t1Long(): AgentEvent[] {
  const events: AgentEvent[] = [
    { type: 'session_started', sessionId: 'sess_t1', model: 'claude-opus-4', version: '2.1.289' },
  ];
  const files = ['auth/contracts.ts', 'auth/types.ts', 'auth/errors.ts', 'auth/index.ts'];
  for (let i = 0; i < 40; i++) {
    const file = files[i % files.length] ?? 'auth/contracts.ts';
    events.push(
      ...read(`t1r${i}`, `server/auth/legacy/${i}.ts`),
      { type: 'tool_call', id: `t1e${i}`, name: 'Edit', input: { file_path: file }, kind: 'edit' },
      { type: 'file_change', path: file, added: 4 + (i % 7), removed: i % 3 },
      { type: 'message', text: `Step ${i + 1}: aligned \`${file}\` with the WebAuthn level 3 types.` },
    );
  }
  events.push(
    { type: 'tool_call', id: 't1v', name: 'Bash', input: { command: 'pnpm typecheck' }, kind: 'command' },
    { type: 'tool_result', id: 't1v', ok: true, output: 'Done in 4.1s' },
    { type: 'message', text: 'Added WebAuthn types and the passkey API contracts.' },
    {
      type: 'tool_call',
      id: 't1d',
      name: 'mcp__legion__mark_task_done',
      input: { summary: 'Contracts and types for passkey registration and login', commitMessage: 'T1: auth contracts' },
      kind: 'mcp',
    },
    { type: 'usage', inputTokens: 88_000, outputTokens: 9_200, costUsd: 0.61 },
    { type: 'turn_complete', structuredOutput: null, isError: false, reason: null },
    { type: 'exited', code: 0 },
  );
  return events;
}

function clarifyPlanner(): AgentEvent[] {
  return [
    { type: 'session_started', sessionId: 'sess_rl_plan', model: 'claude-opus-4', version: '2.1.289' },
    ...read('p1', 'server/middleware/index.ts'),
    ...read('p2', 'server/routes/public.ts'),
    ...read('p3', 'docs/api.md'),
    {
      type: 'tool_call',
      id: 'p4',
      name: 'Bash',
      input: { command: 'rg -n "rateLimit|throttle" server' },
      kind: 'command',
    },
    { type: 'tool_result', id: 'p4', ok: true, output: 'no matches' },
    {
      type: 'message',
      text: 'There is no limiter today. Before drafting the plan I need to know who is limited, what happens over the limit, and which routes are exempt.',
    },
  ];
}

export function withSessionDemo(world: DemoWorld, now: number): DemoWorld {
  const runD: Run = {
    id: CLARIFY_RUN_ID,
    repoPath: '/Users/dev/src/erudiet/api',
    baseRef: 'main',
    title: 'Rate-limit the public API',
    issueText: 'Public API has no rate limiting; one customer script took us down last week.',
    issueUrl: 'https://github.com/erudiet/api/issues/431',
    status: 'clarifying',
    paused: false,
    plannerEngine: 'claude',
    plannerModel: null,
    integrationBranch: null,
    prUrl: null,
    error: null,
    createdAt: now - 3 * MIN,
    updatedAt: now - 50_000,
  };
  const planner: Attempt = {
    id: 'att_rlplanner001',
    runId: CLARIFY_RUN_ID,
    taskId: null,
    role: 'planner',
    engine: 'claude',
    model: null,
    effort: 'high',
    sessionId: 'sess_rl_plan',
    status: 'running',
    startedAt: now - 3 * MIN,
    endedAt: null,
    costUsd: 0.21,
    inputTokens: null,
    outputTokens: null,
    error: null,
  };
  const inbox: InboxItem[] = [
    {
      id: 'inb_rlclarify001',
      runId: CLARIFY_RUN_ID,
      taskId: null,
      attemptId: planner.id,
      kind: 'question',
      payload: {
        source: 'clarify',
        questions: [
          {
            id: 'q1',
            question: 'Who should the limit apply to?',
            options: ['Per API key', 'Per IP address', 'Per API key, falling back to IP'],
          },
          {
            id: 'q2',
            question: 'What should a client get once it is over the limit?',
            options: ['429 with Retry-After', '429 and an audit-log entry', 'Queue briefly, then 429'],
          },
          {
            id: 'q3',
            question: 'Which routes must never be limited (health checks, webhooks, …)?',
            options: [],
          },
        ],
      },
      createdAt: now - 50_000,
      resolvedAt: null,
      resolution: null,
    },
    {
      id: 'inb_authv2budg01',
      runId: 'run_authv2demo01',
      taskId: null,
      attemptId: null,
      kind: 'budget',
      payload: { spentUsd: 3.42, limitUsd: 4 },
      createdAt: now - 20_000,
      resolvedAt: null,
      resolution: null,
    },
  ];
  return {
    ...world,
    runs: [...world.runs, runD],
    attempts: [...world.attempts, planner],
    inbox: [...world.inbox, ...inbox],
    transcripts: {
      ...world.transcripts,
      att_authv2t1code: t1Long(),
      att_authv2t2code: t2(now),
      att_authv2t3code: t3(now),
      att_authv2t4revw: t4Review(),
      att_authv2t4fix1: t4Fix(),
      [planner.id]: clarifyPlanner(),
    },
  };
}

type Step = { attemptId: string; event: AgentEvent };

/**
 * Live steps: `intro` plays once (T2 finishes streaming its message), then `loop` repeats, interleaving T2's
 * follow-up with the base script.
 */
export function withSessionLive(base: readonly Step[]): { intro: Step[]; loop: Step[] } {
  const t2 = 'att_authv2t2code';
  const stream: Step[] = T2_STREAM.slice(T2_STREAMED).map((text) => ({
    attemptId: t2,
    event: { type: 'text_delta', text },
  }));
  stream.push({ attemptId: t2, event: { type: 'message', text: T2_STREAM.join('') } });
  const rest: Step[] = [
    {
      attemptId: t2,
      event: { type: 'tool_call', id: 'l1', name: 'Edit', input: { file_path: 'server/auth/errors.ts' }, kind: 'edit' },
    },
    { attemptId: t2, event: { type: 'file_change', path: 'server/auth/errors.ts', added: 27, removed: 3 } },
  ];
  const others = base.filter((s) => s.attemptId !== t2);
  return { intro: stream, loop: interleave(rest, others) };
}

function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x) out.push(x);
    if (y) out.push(y);
  }
  return out;
}
