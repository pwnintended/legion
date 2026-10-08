/**
 * The scripted agent used in fake-engine mode (`LEGION_FAKE_ENGINES=1`): plausible, role-aware behaviour
 * so the whole pipeline (clarify → plan → coders → review → merge → PR) can be demoed without real CLIs.
 * It reads what it needs from the prompts Legion builds (task ids, touches, criteria).
 *
 * One run exercises every human touch point once: one clarify question, a 3-task plan (T2 depends on T1),
 * one tool approval (T3's coder asks to run a linter), one review with a major finding (T2's first review)
 * that the fix round resolves (the re-review approves), then the PR gate. Along the way T2's coder presents a
 * (synthetic) screenshot, T3's coder presents the document it wrote, and the lead sends the assistant a status
 * update whenever a task merges.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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
        agent: { effort: null },
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
        agent: { effort: null },
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
        agent: { effort: null },
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

// -- a synthetic screenshot (a PNG drawn from rectangles; no text) -------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

type Rect = [x: number, y: number, w: number, h: number, rgb: number];

/** A 1200×750 mock of a settings page (sidebar, header, a list with one highlighted row), as a PNG. */
export function demoScreenshot(): Buffer {
  const width = 1200;
  const height = 750;
  const rects: Rect[] = [
    [0, 0, width, height, 0x1e1e2e],
    [0, 0, 240, height, 0x181825],
    [24, 32, 120, 14, 0xcba6f7],
    ...[0, 1, 2, 3, 4].map((i): Rect => [24, 88 + i * 40, 150 - i * 12, 10, i === 2 ? 0xcdd6f4 : 0x585b70]),
    [240, 0, width - 240, 72, 0x181825],
    [288, 28, 220, 16, 0xcdd6f4],
    [1040, 20, 112, 32, 0xcba6f7],
    ...[0, 1, 2].map((i): Rect => [288, 120 + i * 92, 864, 72, i === 0 ? 0x313244 : 0x252536]),
    ...[0, 1, 2].map((i): Rect => [312, 140 + i * 92, 32, 32, [0x94e2d5, 0xfab387, 0x89b4fa][i] as number]),
    ...[0, 1, 2].map((i): Rect => [364, 144 + i * 92, 260 - i * 40, 12, 0xcdd6f4]),
    ...[0, 1, 2].map((i): Rect => [364, 166 + i * 92, 180, 8, 0x6c7086]),
    ...[0, 1, 2].map((i): Rect => [1032, 146 + i * 92, 96, 20, i === 0 ? 0xa6e3a1 : 0x45475a]),
    [288, 420, 864, 1, 0x313244],
    [288, 452, 360, 12, 0x6c7086],
  ];
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (const [x, y, w, h, rgb] of rects) {
    for (let row = y; row < Math.min(height, y + h); row++) {
      for (let col = x; col < Math.min(width, x + w); col++) {
        const at = row * rowBytes + 1 + col * 3;
        raw[at] = (rgb >> 16) & 0xff;
        raw[at + 1] = (rgb >> 8) & 0xff;
        raw[at + 2] = rgb & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The task whose coder presents a screenshot, and the one whose coder presents the document it wrote. */
export const DEMO_SCREENSHOT_TASK = 'T2';
export const DEMO_DOCUMENT_TASK = 'T3';

function presentSteps(role: string, id: string, path: string, resumed: boolean): FakeStep[] {
  if (role !== 'coder' || resumed) return [];
  if (id === DEMO_SCREENSHOT_TASK) {
    return [
      {
        kind: 'mcp',
        tool: 'present',
        args: async () => {
          const dir = await mkdtemp(join(tmpdir(), 'legion-demo-'));
          const file = join(dir, 'feature-preview.png');
          await writeFile(file, demoScreenshot());
          return {
            title: 'Feature preview',
            caption: 'The new list under Settings. The first row is the one you just added; the others are older.',
            files: [file],
          };
        },
      },
    ];
  }
  if (id === DEMO_DOCUMENT_TASK) {
    return [
      {
        kind: 'mcp',
        tool: 'present',
        args: {
          title: 'Documentation draft',
          caption: 'What a reader sees first. Tell me if the tone is off before it merges.',
          files: [path],
        },
      },
    ];
  }
  return [];
}

/** `T2 running → merged: Implemented T2 …` lines of a lead wake. */
function mergedTasks(message: string): string[] {
  return [...message.matchAll(/^- (T\d+) \w+ → merged/gm)].map((m) => m[1] as string);
}

/**
 * The scripted assistant: hands the request to the planner on its first turn, then relays Legion's news in a
 * sentence (status updates, presentations, the plan and PR gates) and stays quiet about the rest.
 */
function assistantSteps(ctx: Parameters<FakeScript>[0]): FakeStep[] {
  if (ctx.turn === 0 && !ctx.resumed) {
    const request = ctx.message.split('\n\n## Repository')[0]?.trim() ?? ctx.message;
    const title = (request.split('\n')[0] ?? 'Demo change').replace(/^#+\s*/, '').slice(0, 80) || 'Demo change';
    return [
      {
        kind: 'text',
        text: "Got it. I'll have a planner look through the repository and draft a plan; you sign it off before anything is written.",
      },
      { kind: 'mcp', tool: 'start_implementation', args: { title, brief: request, clarify: true } },
      usage(0.003),
    ];
  }
  if (!ctx.message.startsWith('Update from Legion')) {
    return [{ kind: 'text', text: "Noted. I'll pass that on to the lead." }, usage(0.002)];
  }
  const news = ctx.message;
  const lines: string[] = [];
  if (/clarifying question/.test(news)) lines.push('The planner has a question for you before it drafts the plan.');
  if (/waits for the human's sign-off/.test(news))
    lines.push(
      'The plan is ready: three tasks, with the feature built on the core module. Sign it off when it looks right.',
    );
  if (/→ executing/.test(news)) lines.push('Plan approved. The coders are starting on T1 and T3.');
  const merged = [...news.matchAll(/(T\d+(?:, T\d+)*) merged into the integration branch/g)].map((m) => m[1]);
  if (merged.length) lines.push(`${merged.join(', ')} merged. Nothing is blocked.`);
  for (const m of news.matchAll(/showed the human "([^"]+)"/g))
    lines.push(`There's something to look at above: ${m[1]}.`);
  if (/needs the human/.test(news)) lines.push('One task needs a decision from you.');
  if (/→ pr_ready/.test(news))
    lines.push('Everything is merged and the final review passed. The draft pull request is ready for you to open.');
  if (lines.length === 0) return [usage(0.001)];
  return [{ kind: 'text', text: lines.join(' ') }, usage(0.002)];
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
  if (role === 'researcher' || role === 'research_lead') {
    return [
      { kind: 'text', text: 'Looking it up.' },
      { kind: 'tool', name: 'Grep', toolKind: 'read', input: { pattern: 'legion-demo' }, output: 'README.md' },
      usage(0.01),
      { kind: 'output', value: 'auto' },
    ];
  }
  if (role === 'assistant') return assistantSteps(ctx);
  if (role === 'session') {
    if (ctx.turn > 0 || ctx.resumed) return [{ kind: 'text', text: 'Done. Anything else?' }, usage(0.002)];
    return [
      ...attachmentSteps(ctx),
      { kind: 'text', text: 'Let me look at the repository first.' },
      { kind: 'tool', name: 'Read', toolKind: 'read', input: { path: 'README.md' }, output: '# readme' },
      { kind: 'tool', name: 'Bash', toolKind: 'command', input: { command: 'git status --short' }, output: '' },
      { kind: 'text', text: 'The working tree is clean. Tell me what to change and I will edit it here.' },
      usage(0.01),
    ];
  }
  if (role === 'lead') {
    const merged = ctx.turn === 0 ? [] : mergedTasks(ctx.message);
    const status: FakeStep[] = merged.length
      ? [
          {
            kind: 'mcp',
            tool: 'send_message',
            args: {
              to: 'lead',
              kind: 'status',
              body: `${merged.join(', ')} merged into the integration branch.\nNothing is blocked; the remaining tasks are on track.`,
            },
          },
        ]
      : [];
    return [
      { kind: 'text', text: ctx.turn === 0 ? 'Plan read; standing by for my coders.' : 'Noted.' },
      ...status,
      usage(0.004),
    ];
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
      ...presentSteps(role, id, path, ctx.resumed),
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
