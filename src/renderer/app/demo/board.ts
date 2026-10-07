/**
 * Demo fixtures for the project board: two more conversations in the `api` repository, still talking (no plan
 * yet), so its board has four tiles (they come last in the rail, so the ⌘1–9 run numbers stay put). One assistant runs on Claude, the other on Codex. Synthetic content.
 */
import type { Attempt, Run } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import type { DemoWorld } from './fixtures';

const MIN = 60_000;
const API = '/Users/dev/src/erudiet/api';
export const SAFARI_RUN_ID = 'run_safarisess01';
export const ONBOARD_RUN_ID = 'run_onbcopy00001';

const you = (text: string): AgentEvent => ({ type: 'user_message', text, attachments: [], priority: null });
const said = (text: string): AgentEvent => ({ type: 'message', text });
const done: AgentEvent = { type: 'turn_complete', structuredOutput: null, isError: false, reason: null };

function chatRun(id: string, title: string, issueText: string, createdAt: number, updatedAt: number): Run {
  return {
    id,
    repoPath: API,
    baseRef: 'main',
    title,
    issueText,
    issueUrl: null,
    status: 'chatting',
    paused: false,
    plannerEngine: 'claude',
    plannerModel: null,
    integrationBranch: null,
    prUrl: null,
    error: null,
    createdAt,
    updatedAt,
  };
}

function assistantOf(id: string, runId: string, engine: Attempt['engine'], startedAt: number): Attempt {
  return {
    id,
    runId,
    taskId: null,
    role: 'assistant',
    parentAttemptId: null,
    engine,
    model: engine === 'codex' ? 'gpt-5-codex' : 'claude-opus-4',
    effort: null,
    sessionId: `sess_${id}`,
    status: 'running',
    startedAt,
    endedAt: null,
    costUsd: engine === 'codex' ? null : 0.04,
    inputTokens: null,
    outputTokens: null,
    error: null,
  };
}

export function withBoardDemo(world: DemoWorld, now: number): DemoWorld {
  const at = (minutes: number) => now - minutes * MIN;
  const script = (attemptId: string, lines: [number, AgentEvent][]) => {
    world.transcripts[attemptId] = lines.map(([, event]) => event);
    world.transcriptTimes = { ...world.transcriptTimes, [attemptId]: lines.map(([minutes]) => at(minutes)) };
  };

  world.runs.push(
    chatRun(
      SAFARI_RUN_ID,
      'Why do sessions expire early on Safari?',
      'Users on Safari get signed out after about a day.',
      at(26),
      at(6),
    ),
    chatRun(ONBOARD_RUN_ID, 'Rewrite the onboarding emails', 'The welcome series reads like a manual.', at(14), at(1)),
  );
  world.attempts.push(
    assistantOf('att_safariassist', SAFARI_RUN_ID, 'claude', at(26)),
    assistantOf('att_onbcopyassis', ONBOARD_RUN_ID, 'codex', at(14)),
  );

  script('att_safariassist', [
    [26, you('Users on Safari get signed out after about a day, everyone else stays in for 30 days. Any idea why?')],
    [
      25.4,
      said(
        "Safari's tracking prevention caps cookies set from JavaScript at **7 days**, and at **24 hours** when the page was reached through a link-decorated URL. The web client writes the refresh token from `/auth/refresh` with `document.cookie`, so it falls under that cap.\n\nThe fix is to set it from the server as an `HttpOnly` cookie on the `/auth/refresh` response. That is also safer: scripts can no longer read the token.",
      ),
    ],
    [25.3, done],
    [7, you('Would that break the mobile app? It reads the token from the same endpoint.')],
    [
      6.4,
      said(
        "Not if the endpoint keeps returning the token in the body for clients that send `X-Client: mobile`. The mobile app sends it already, so only the web client would change. Want me to turn this into a run? I'd keep it to the server cookie, the web client and a regression test.",
      ),
    ],
    [6.3, done],
  ]);

  script('att_onbcopyassis', [
    [
      14,
      you(
        'The welcome series reads like a manual. Rewrite the three onboarding emails so each one does one thing. Templates live in `src/emails/onboarding/`.',
      ),
    ],
    [
      13.2,
      said(
        "I read all three. Each one currently lists every feature. Here's a split where each email has one job:\n\n1. **Day 0, Welcome:** connect a repository. One button.\n2. **Day 2, First run:** start one from an issue, with the plan sign-off explained in two lines.\n3. **Day 5, Your team:** invite a reviewer.\n\nShould the day 5 email still go out if they never finished day 2?",
      ),
    ],
    [13.1, done],
    [1.4, you('Skip it then, and send a nudge for day 2 instead.')],
    [1.1, said('Makes sense. Drafting the nudge and the conditional now; I will show you all four before anything')],
  ]);
  return world;
}
