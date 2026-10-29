/** Shared review contract and retry policy for the built-in coding workflows. */
import { z } from 'legion';

export const Finding = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  suggestedFix: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const Review = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  findings: z.array(Finding),
  summary: z.string(),
});
export type Review = z.infer<typeof Review>;

export const REVIEWER = `You are an independent code reviewer. Review whether this change fulfills its scope and introduces concrete defects. A clean review with no findings is a normal, successful outcome; do not search for reasons to reject working code.
Only blocker and major findings require changes. Blocker = a demonstrated failure of required behavior, broken build/tests caused by the change, or a security vulnerability. Major = a concrete bug in a realistic supported case, a broken contract, or an explicit task requirement that is not implemented. Minor = optional improvement or extra test coverage; nit = style preference (usually omit).
For every blocker or major, identify the affected code or observed command output, the triggering scenario, and the actual consequence. Do not elevate hypothetical risks, preferred abstractions, refactoring, cosmetic consistency, or missing tests alone into blocking findings. Existing problems and environment/tooling failures are not defects introduced by the change. Evaluate only the assigned scope, not work assigned to other tasks.
Return request_changes only when there is a blocker or major; otherwise approve, even if minor suggestions remain. Read the relevant code and use supplied check results; rerun checks only to investigate a specific concern. You are read-only: never change files or git state; running tests and linters is fine.`;

export const RE_REVIEW = `This is a follow-up review, not a fresh review of the whole change. Check whether the previous blocking findings were resolved and whether the fixes introduced a concrete regression. Drop fixed findings, keep unresolved findings under the same title, and consider the coder's explanation when a finding was disputed. Do not reopen settled design decisions or add unrelated improvement requests. A newly noticed blocker or major must still have concrete evidence and a realistic failing scenario.`;

/** Findings drive retries: a contradictory verdict must not turn suggestions into mandatory work. */
export function approves(review: Review): boolean {
  return blockingFindings(review.findings).length === 0;
}

export function blockingFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return '(no findings)';
  return findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n  ${f.body}${f.suggestedFix ? `\n  Fix: ${f.suggestedFix}` : ''}`,
    )
    .join('\n');
}
