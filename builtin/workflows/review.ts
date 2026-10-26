/**
 * review: both engines review the changes in your checkout (the branch against its base, plus uncommitted work)
 * independently, their findings are merged into one list, and — if you want — an agent fixes the ones you pick.
 */
import { agent, gate, parallel, sh, workflow, z } from 'legion';

const Input = z.object({
  base: z
    .string()
    .nullable()
    .default(null)
    .describe('Branch or commit to diff against; default: merge-base with the default branch.'),
  focus: z.string().nullable().default(null).describe('What to pay attention to (optional).'),
  fix: z.boolean().default(false).describe('Offer to fix the findings afterwards (edits your checkout).'),
  fixer: z.enum(['claude', 'codex']).default('claude'),
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

const Review = z.object({ findings: z.array(Finding), summary: z.string() });
const Merged = z.object({
  findings: z.array(Finding.extend({ foundBy: z.enum(['claude', 'codex', 'both']) })),
  summary: z.string(),
});

export default workflow(
  {
    name: 'review',
    description:
      'Cross-engine code review of the current branch and uncommitted changes, optionally followed by fixes.',
    input: Input,
    example: { base: null, focus: null, fix: true, fixer: 'claude' },
  },
  async (input) => {
    const base = (
      await sh(
        'base',
        `git merge-base HEAD ${input.base ?? '"$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"'}`,
        { label: 'find the base commit' },
      )
    ).stdout.trim();

    const prompt = `Review the changes in this repository: \`git diff ${base}\` shows them (committed on this branch and uncommitted). Untracked files count too (\`git status\`).
${input.focus ? `\nFocus: ${input.focus}\n` : ''}
Look for real defects (logic errors, unhandled edge cases, broken contracts, missing or misleading tests, security problems) and for changes that make the code clearly messier than it needs to be. Back every finding with evidence (file and line, quoted code, or command output) and give a concrete suggestedFix. Severities: blocker, major, minor, nit. Prefer a few high-conviction findings over many small ones. You are read-only: never change files or git state; running tests and linters is fine.`;

    const [claude, codex] = await parallel([
      () => agent('review-claude', { engine: 'claude', mode: 'read', output: Review, prompt, label: 'claude reviews' }),
      () => agent('review-codex', { engine: 'codex', mode: 'read', output: Review, prompt, label: 'codex reviews' }),
    ]);

    const merged = await agent('merge', {
      engine: 'claude',
      mode: 'read',
      output: Merged,
      label: 'merge the findings',
      prompt: `Two reviewers looked at the same change independently. Merge their findings into one list: combine duplicates (foundBy: both), drop findings you can verify are wrong by reading the code, keep the rest with their severity (raise or lower it only with a reason). Order by severity. Then write a 2–4 sentence overall summary.

## Claude's review
${JSON.stringify(claude, null, 2)}

## Codex's review
${JSON.stringify(codex, null, 2)}`,
    });

    if (!input.fix || merged.findings.length === 0) return merged;

    const decision = await gate('approve-fix', {
      title: `Fix ${merged.findings.filter((f) => f.severity !== 'nit').length} findings in your checkout?`,
      show: `${merged.summary}\n\n${formatFindings(merged.findings)}\n\nApprove to fix all blocker/major/minor findings, or request changes to say which ones (e.g. "only 1 and 3").`,
    });
    const which = decision.approved
      ? 'every blocker, major and minor finding'
      : `the findings the user picked: ${decision.note ?? '(none)'}`;
    await agent('fix', {
      engine: input.fixer,
      label: 'fix',
      prompt: `Fix ${which} below in this repository. Keep the changes minimal and in the repository's style, update tests where needed, and run the relevant checks. Do not commit.\n\n${formatFindings(merged.findings)}`,
    });
    return { ...merged, fixed: which };
  },
);

function formatFindings(findings: (Finding & { foundBy?: string })[]): string {
  return findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}${f.foundBy ? ` — ${f.foundBy}` : ''}\n   ${f.body}${f.suggestedFix ? `\n   Fix: ${f.suggestedFix}` : ''}`,
    )
    .join('\n');
}
