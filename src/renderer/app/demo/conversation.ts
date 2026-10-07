/**
 * Demo conversation for the passkeys run: the human talks to an assistant, a lead reports milestones to it,
 * a coder shows screenshots of the UI it built and the lead shares a document. The screenshots are drawn on a
 * canvas when first asked for (synthetic: a mock of the settings page, not a capture of a real app).
 */
import type { AttachmentRef } from '@shared/attachments';
import type { AgentMessage, Attempt, InboxItem, Presentation } from '@shared/domain';
import type { AgentEvent } from '@shared/events';
import type { DemoWorld } from './fixtures';

const MIN = 60_000;
export const CONVERSATION_RUN_ID = 'run_authv2demo01';
const ASSISTANT = 'att_authv2assist';
const LEAD = 'att_authv2lead01';

/** Demo files: an image drawn on demand, or a text document. */
export type DemoFile = { ref: AttachmentRef } & ({ draw: 'passkeys' | 'passkeys-empty' } | { text: string });

const ERROR_CODES = `# Registration API: error codes

Every failure of \`POST /auth/passkeys/register\` returns the standard error envelope with one of these codes, so the Settings page can say what went wrong.

| Code | When | What the UI says |
| --- | --- | --- |
| \`INVALID_ATTESTATION\` | The authenticator's response does not verify | "That passkey couldn't be verified. Try again." |
| \`CHALLENGE_EXPIRED\` | More than 5 minutes passed since the options call | "That took too long. Start again." |
| \`UNKNOWN_CREDENTIAL\` | Sign-in with a passkey that was removed | "This passkey is no longer on your account." |
| \`ALREADY_REGISTERED\` | The same authenticator registered twice | "This device already has a passkey." |

## Notes

- \`CHALLENGE_EXPIRED\` returns **410 Gone**, not 400: the client restarts the ceremony instead of showing a form error.
- Codes are stable; the messages are the UI's to change.
`;

const ref = (id: string, name: string, kind: AttachmentRef['kind'], mime: string, size: number): AttachmentRef => ({
  id,
  name,
  kind,
  mime,
  size,
  sha256: `demo-${id}`,
});

const SHOT = ref('file_demoshot0001', 'settings-passkeys.png', 'image', 'image/png', 184_310);
const EMPTY_SHOT = ref('file_demoshot0002', 'settings-passkeys-empty.png', 'image', 'image/png', 96_422);
const DOC = ref('file_demodoc00001', 'registration-error-codes.md', 'text', 'text/markdown', ERROR_CODES.length);

export const DEMO_FILES: Readonly<Record<string, DemoFile>> = {
  [SHOT.id]: { ref: SHOT, draw: 'passkeys' },
  [EMPTY_SHOT.id]: { ref: EMPTY_SHOT, draw: 'passkeys-empty' },
  [DOC.id]: { ref: DOC, text: ERROR_CODES },
};

const you = (text: string): AgentEvent => ({ type: 'user_message', text, attachments: [], priority: null });
const said = (text: string): AgentEvent => ({ type: 'message', text });
const done: AgentEvent = { type: 'turn_complete', structuredOutput: null, isError: false, reason: null };

export function withConversationDemo(world: DemoWorld, now: number): DemoWorld {
  const run = world.runs.find((r) => r.id === CONVERSATION_RUN_ID);
  if (!run) return world;
  const at = (minutes: number) => now - minutes * MIN;
  const base = {
    runId: run.id,
    taskId: null,
    engine: 'claude' as const,
    model: 'claude-opus-4',
    effort: null,
    sessionId: null,
    endedAt: null,
    costUsd: 0.06,
    inputTokens: null,
    outputTokens: null,
    error: null,
  };
  const assistant: Attempt = {
    ...base,
    id: ASSISTANT,
    role: 'assistant',
    parentAttemptId: null,
    status: 'running',
    startedAt: at(58),
  };
  const lead: Attempt = {
    ...base,
    id: LEAD,
    role: 'lead',
    parentAttemptId: ASSISTANT,
    status: 'running',
    startedAt: at(41),
    costUsd: 0.09,
  };
  for (const attempt of world.attempts) {
    if (attempt.runId !== run.id) continue;
    if (attempt.role === 'planner') attempt.parentAttemptId = ASSISTANT;
    else if (attempt.role !== 'assistant' && attempt.role !== 'lead') attempt.parentAttemptId = LEAD;
  }
  world.attempts.push(assistant, lead);

  // The conversation, with its own clock (the transcript replay otherwise spreads events evenly).
  const script: [number, AgentEvent][] = [
    [
      58,
      you(
        'Add passkey (WebAuthn) login. Users register a passkey from Settings and sign in with it; password login stays as the fallback.',
      ),
    ],
    [
      57.6,
      said(
        "Got it. I'll have a planner read through the repository and draft a plan; you sign it off before anything is written.",
      ),
    ],
    [57.5, { type: 'tool_call', id: 'as1', name: 'mcp__legion__start_implementation', input: {}, kind: 'mcp' }],
    [57.5, { type: 'tool_result', id: 'as1', ok: true, output: '{"status":"clarifying"}' }],
    [57.4, done],
    [47.5, you('Keep the challenge store in Redis, we already run it for sessions.')],
    [
      47.2,
      said(
        'Passed on. The planner is revising: the migration becomes a task of its own, and the challenge store reuses the session Redis client.',
      ),
    ],
    [47.1, done],
    [
      41.6,
      said(
        'Plan v2 is approved. T1 lays down the shared WebAuthn contracts first; registration, the enrollment UI and the credential migration follow in parallel.',
      ),
    ],
    [41.5, done],
    [
      23.7,
      said(
        "T1 is merged, so the shared types are in. Registration (T2), the enrollment UI (T3) and the migration (T4) are running now. I'll tell you when something needs you.",
      ),
    ],
    [23.6, done],
    [
      8.7,
      said(
        'T3 shared the new Passkeys section above. It also needs your OK to add `@simplewebauthn/browser`: that changes the lockfile, which T6 owns, so I left the call to you.',
      ),
    ],
    [8.6, done],
    [
      2.8,
      said(
        'One snag: review sent the migration (T4) back because the sign counter would overflow past 2³². Its coder is fixing it; nothing else is blocked.',
      ),
    ],
    [2.7, done],
  ];
  world.transcripts[ASSISTANT] = script.map(([, event]) => event);
  world.transcriptTimes = { ...world.transcriptTimes, [ASSISTANT]: script.map(([minutes]) => at(minutes)) };
  world.transcripts[LEAD] = [said('Plan read; standing by for my coders.'), done];

  const message = (id: string, minutes: number, body: string): AgentMessage => ({
    id,
    runId: run.id,
    fromAttemptId: LEAD,
    toAttemptId: ASSISTANT,
    kind: 'status',
    body,
    replyTo: null,
    createdAt: at(minutes),
    deliveredAt: at(minutes - 0.1),
  });
  world.messages = [
    ...(world.messages ?? []),
    {
      id: 'msg_authv2brief1',
      runId: run.id,
      fromAttemptId: ASSISTANT,
      toAttemptId: LEAD,
      kind: 'brief',
      body: 'The human wants Redis for the challenge store; keep password login untouched.',
      replyTo: null,
      createdAt: at(41.2),
      deliveredAt: at(41.1),
    },
    message(
      'msg_authv2stat01',
      24,
      'T1 merged: auth contracts and types are in.\nT2, T3 and T4 can start; T4 owns the migration.',
    ),
    message(
      'msg_authv2stat02',
      3,
      "T4's review sent it back: the sign counter overflows past 2³².\nIts coder is in fix round 1. Nothing else is blocked.",
    ),
  ];

  const t3 = world.tasks.find((t) => t.runId === run.id && t.nodeId === 'T3');
  const presentations: Presentation[] = [
    {
      id: 'shw_authv2t3shot',
      runId: run.id,
      taskId: t3?.id ?? null,
      attemptId: 'att_authv2t3code',
      title: 'Passkeys section in Settings',
      caption:
        'The list under **Settings → Security**, with rename and remove on each passkey. The second shot is the empty state a new account sees.',
      attachments: [SHOT, EMPTY_SHOT],
      createdAt: at(11),
    },
    {
      id: 'shw_authv2leaddoc',
      runId: run.id,
      taskId: null,
      attemptId: LEAD,
      title: 'Registration API error codes',
      caption: 'What T2 returns for each failure, so the UI (T3) and the API agree before T5 builds sign-in on both.',
      attachments: [DOC],
      createdAt: at(1.5),
    },
  ];
  world.presentations = [...(world.presentations ?? []), ...presentations];

  // Plan sign-off, twice: changes asked for v1, v2 approved. The open approval sits where it happened.
  const signoff = (id: string, version: number, created: number, resolved: number, feedback: string | null) =>
    ({
      id,
      runId: run.id,
      taskId: null,
      attemptId: null,
      kind: 'plan_signoff',
      payload: { planId: `plan_authv2demo0${version}`, version },
      resolution: { approved: feedback === null, feedback },
      createdAt: at(created),
      resolvedAt: at(resolved),
    }) as InboxItem;
  world.inbox.push(
    signoff('inb_authv2plan001', 1, 51, 48, 'Split the migration out of the registration task.'),
    signoff('inb_authv2plan002', 2, 46, 42, null),
  );
  const approval = world.inbox.find((i) => i.id === 'inb_authv2appr01');
  if (approval) approval.createdAt = at(9);
  return world;
}

// ---------------------------------------------------------------------------------------------
// The synthetic screenshots
// ---------------------------------------------------------------------------------------------

const PALETTE = {
  bg: '#0f1117',
  side: '#151821',
  panel: '#1a1e29',
  line: '#262b38',
  text: '#e6e9f2',
  sub: '#9aa3b5',
  faint: '#6b7385',
  accent: '#7c9cff',
  ok: '#5fd39a',
};

/** Draw a mock settings page (1200×750) and return it as base64 PNG, or null outside a browser. */
export function drawDemoShot(kind: 'passkeys' | 'passkeys-empty'): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = 1200 * scale;
  canvas.height = 750 * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  const font = (size: number, weight = 400) => `${weight} ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  const round = (x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  const text = (value: string, x: number, y: number, size: number, color: string, weight = 400) => {
    ctx.font = font(size, weight);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };

  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, 1200, 750);
  ctx.fillStyle = PALETTE.side;
  ctx.fillRect(0, 0, 248, 750);
  text('Acme', 28, 44, 17, PALETTE.text, 650);
  const nav = ['Profile', 'Security', 'Notifications', 'Billing', 'Team'];
  nav.forEach((item, i) => {
    if (i === 1) round(16, 74 + i * 38, 216, 32, 7, PALETTE.panel);
    text(item, 30, 95 + i * 38, 14, i === 1 ? PALETTE.text : PALETTE.sub, i === 1 ? 600 : 400);
  });

  text('Security', 296, 66, 13, PALETTE.faint);
  text('Passkeys', 296, 100, 26, PALETTE.text, 650);
  text('Sign in with Touch ID, Face ID or a security key instead of your password.', 296, 128, 14, PALETTE.sub);
  round(1004, 76, 152, 38, 8, PALETTE.accent);
  text('Add a passkey', 1027, 100, 14, '#0b0d14', 600);

  if (kind === 'passkeys') {
    const rows = [
      ['MacBook Pro · Touch ID', 'Added 12 May · Used today', true],
      ['iPhone 15 · Face ID', 'Added 2 Apr · Used 3 days ago', false],
      ['YubiKey 5C', 'Added 18 Jan · Never used', false],
    ] as const;
    rows.forEach(([name, meta, current], i) => {
      const y = 168 + i * 92;
      round(296, y, 860, 76, 10, PALETTE.panel, PALETTE.line);
      round(318, y + 20, 36, 36, 9, '#232838');
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(331, y + 36, 6, 0, Math.PI * 2);
      ctx.moveTo(337, y + 38);
      ctx.lineTo(346, y + 46);
      ctx.stroke();
      text(name, 372, y + 34, 15, PALETTE.text, 600);
      text(meta, 372, y + 56, 13, PALETTE.sub);
      if (current) {
        round(372 + ctx.measureText(meta).width + 24, y + 42, 88, 22, 11, '#163326');
        text('This device', 372 + ctx.measureText(meta).width + 36, y + 58, 12, PALETTE.ok, 600);
      }
      text('Rename', 1018, y + 44, 13, PALETTE.sub, 500);
      text('Remove', 1090, y + 44, 13, '#ff8a8a', 500);
    });
    ctx.fillStyle = PALETTE.line;
    ctx.fillRect(296, 460, 860, 1);
    text('Password sign-in stays available as a fallback.', 296, 494, 13, PALETTE.faint);
  } else {
    round(296, 168, 860, 300, 12, PALETTE.panel, PALETTE.line);
    ctx.strokeStyle = PALETTE.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(726, 252, 16, 0, Math.PI * 2);
    ctx.moveTo(737, 263);
    ctx.lineTo(756, 282);
    ctx.moveTo(748, 274);
    ctx.lineTo(742, 280);
    ctx.stroke();
    ctx.textAlign = 'center';
    text('No passkeys yet', 726, 334, 18, PALETTE.text, 600);
    text('Add one to sign in with your fingerprint, face or a security key.', 726, 362, 14, PALETTE.sub);
    round(650, 392, 152, 38, 8, PALETTE.accent);
    text('Add a passkey', 726, 416, 14, '#0b0d14', 600);
    ctx.textAlign = 'start';
  }
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
