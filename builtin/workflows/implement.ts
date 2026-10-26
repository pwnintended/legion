/**
 * implement: one focused change, no planning round. A coder works in its own worktree, the other engine reviews,
 * fix rounds until it approves, then a draft PR (or a local merge) after the human signs off.
 */
import { agent, ask, gate, git, loop, sh, WorkflowCancelled, type Worktree, workflow, z } from 'legion';

const Input = z.object({
  task: z.string().min(1).describe('The change to make, with enough context to do it without asking.'),
  coder: z.enum(['claude', 'codex']).default('claude').describe('Engine that writes code; the other one reviews.'),
  finish: z.enum(['pr', 'merge', 'branch']).default('pr'),
  verify: z.array(z.string()).default([]).describe('Checks that must pass, e.g. "pnpm test".'),
  maxFixRounds: z.number().int().min(0).max(5).default(2),
});

const Report = z.object({
  summary: z.string().describe('What you changed and why'),
  commitMessage: z.string().describe('Conventional one-line subject, optional body'),
});

const Finding = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  suggestedFix: z.string().nullable(),
});
type Finding = z.infer<typeof Finding>;

const Review = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  findings: z.array(Finding),
  summary: z.string(),
});
type Review = z.infer<typeof Review>;

const REVIEWER = `You are an independent code reviewer; you did not write this code. Approve only when the change does what was asked, is correct, is tested where it matters, and leaves the code no messier than before. Severities: blocker (wrong behavior, broken build/tests, security), major (a real bug in an edge case that matters, a missing test, a clear structural regression), minor, nit. Back every finding with evidence (file and line, or command output) and a concrete suggestedFix. You are read-only: never change files or git state; running tests and linters is fine.`;

export default workflow(
  {
    name: 'implement',
    description: 'Implement one focused change in a worktree with cross-engine review, then open a draft PR.',
    input: Input,
    example: {
      task: 'Make the --verbose flag also print timings',
      coder: 'claude',
      finish: 'pr',
      verify: [],
      maxFixRounds: 2,
    },
  },
  async (input) => {
    const reviewer = input.coder === 'claude' ? 'codex' : 'claude';
    const wt = await git.worktree('work');

    const report = await agent('code', {
      engine: input.coder,
      cwd: wt.path,
      output: Report,
      allow: input.verify,
      label: 'implement',
      prompt: `Implement this change in the repository (your working directory is a fresh git worktree):

${input.task}

Follow the repository's conventions, write or update tests, and make ${input.verify.length ? input.verify.map((c) => `\`${c}\``).join(', ') : 'the relevant checks'} pass. Do not commit, push or create branches. Finish with the structured report.`,
    });

    let findings: Finding[] = [];
    let lastSession = 'code';
    const reviewed = await loop('review', { max: input.maxFixRounds + 1 }, async (round) => {
      const checks = await verify(input.verify, wt);
      const review = await agent('review', {
        engine: reviewer,
        mode: 'read',
        untrusted: true,
        cwd: wt.path,
        system: REVIEWER,
        output: Review,
        label: `review${round > 1 ? ` (round ${round})` : ''}`,
        prompt: `Review the change in the working directory: \`git diff ${wt.baseSha}\` shows it (uncommitted changes included).

## What was asked
${input.task}

## The coder's report
${report.summary}

## Checks
${checks.map((c) => `- \`${c.command}\`: ${c.ok ? 'passed' : `FAILED\n${c.output}`}`).join('\n') || '(none configured)'}
${round > 1 ? `\n## Re-review\nThe coder was asked to fix these; drop the fixed ones, repeat the rest, add new ones only for real problems:\n${formatFindings(findings)}` : ''}`,
      });
      findings = review.findings;
      if (approves(review) && checks.every((c) => c.ok)) return { done: true };
      if (round > input.maxFixRounds) return;
      await agent('fix', {
        engine: input.coder,
        cwd: wt.path,
        resume: lastSession,
        allow: input.verify,
        label: `fix round ${round}`,
        prompt: `A reviewer looked at your work. Fix every blocker and major finding (minor ones where cheap) and make the checks pass. Do not commit.\n\n${review.summary}\n\n${formatFindings(review.findings)}${
          checks.some((c) => !c.ok)
            ? `\n\nFailing checks:\n${checks
                .filter((c) => !c.ok)
                .map((c) => `- ${c.command}\n${c.output}`)
                .join('\n')}`
            : ''
        }`,
      });
      lastSession = `review/${round}/fix`;
    });

    if (!reviewed.done) {
      const choice = await ask(
        'unresolved',
        `The review still has blocking findings after ${input.maxFixRounds} fix rounds:\n${formatFindings(findings)}\nWhat now?`,
        {
          options: ['ship anyway', 'stop here (keep the branch)', 'abort the run'],
        },
      );
      if (choice === 'abort the run') throw new WorkflowCancelled('Aborted after review');
      if (choice !== 'ship anyway') return { branch: wt.branch, worktree: wt.path, findings };
    }

    await git.commit(wt, report.commitMessage);
    const open = findings.filter((f) => f.severity !== 'nit');
    const body = `${report.summary}\n${open.length ? `\n## Open review findings\n${formatFindings(open)}\n` : ''}\n---\nMade with Legion.`;
    if (input.finish === 'branch') return { branch: wt.branch, worktree: wt.path };

    const ok = await gate('ship', {
      title:
        input.finish === 'pr'
          ? `Open a draft PR for ${wt.branch}?`
          : `Merge ${wt.branch} into ${wt.baseBranch ?? 'the base branch'}?`,
      show: `${body}\n\n\`\`\`diff\n${clip(await git.diff(wt), 20_000)}\n\`\`\``,
    });
    if (!ok.approved) return { branch: wt.branch, worktree: wt.path, note: ok.note };
    const subject = report.commitMessage.split('\n')[0] ?? input.task.slice(0, 70);
    if (input.finish === 'pr') {
      const pr = await git.pr(wt, { title: subject, body });
      await git.remove(wt);
      return { pr: pr.url, branch: wt.branch };
    }
    const merged = await git.mergeToBase(wt, { message: subject });
    await git.remove(wt);
    return { merged: merged.sha };
  },
);

interface Check {
  command: string;
  ok: boolean;
  output: string;
}

async function verify(commands: readonly string[], wt: Worktree): Promise<Check[]> {
  const out: Check[] = [];
  for (const [i, command] of commands.entries()) {
    const r = await sh(`verify-${i + 1}`, command, { cwd: wt.path, allowFail: true, timeoutMs: 15 * 60_000 });
    out.push({ command, ok: r.code === 0, output: clip(`${r.stdout}\n${r.stderr}`.trim(), 4000) });
  }
  return out;
}

function approves(review: Review): boolean {
  return (
    review.verdict === 'approve' && !review.findings.some((f) => f.severity === 'blocker' || f.severity === 'major')
  );
}

function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return '(no findings)';
  return findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n  ${f.body}${f.suggestedFix ? `\n  Fix: ${f.suggestedFix}` : ''}`,
    )
    .join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
