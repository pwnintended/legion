/** Research agents (pure): who may spawn how many, and how a report reads as a message. */
import type { Role } from '@shared/domain';
import type { ResearchReport } from '@shared/schemas';
import { bullets, clipMiddle, join } from './prompts/format';

export const RESEARCH_ROLES: ReadonlySet<Role> = new Set<Role>(['researcher', 'research_lead']);

/** Research agents a parent may have running at once, by the parent's role (absent = may not spawn). */
export const RESEARCH_CAPS: Partial<Record<Role, number>> = { lead: 3, research_lead: 4 };

/** A report as its parent reads it (one message, bounded). */
export const REPORT_MAX_CHARS = 12_000;

export function formatResearchReport(title: string, report: ResearchReport): string {
  const findings = report.findings.map((f) =>
    join(
      `**${f.claim.trim()}**`,
      f.evidence.trim() ? f.evidence.trim() : null,
      f.sources.length > 0 ? `Sources: ${f.sources.map((s) => `\`${s}\``).join(', ')}` : null,
    ),
  );
  return clipMiddle(
    join(
      `**Research: ${title.trim()}** (confidence ${report.confidence})`,
      report.summary.trim(),
      findings.length > 0
        ? `**Findings**\n\n${findings.map((f) => `- ${f.replace(/\n\n/g, '\n  ')}`).join('\n')}`
        : null,
      report.openQuestions.length > 0 ? `**Open questions**\n\n${bullets(report.openQuestions)}` : null,
    ),
    REPORT_MAX_CHARS,
  );
}
