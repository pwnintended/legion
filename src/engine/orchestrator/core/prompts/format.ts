/** Markdown building blocks shared by the prompt builders. */
import type { ReviewCriterion, ReviewFinding, TaskNode } from '@shared/domain';
import type { GateResult } from '../gates';
import type { ScopeReport } from '../scope';
import type { AttachmentNote, IssueInput, RepoInput, UpstreamSummary, VerifyResultInput } from './types';

/** Character budgets for embedded material. Prompts stay well inside both engines' context windows. */
export const PROMPT_LIMITS = {
  issueChars: 20_000,
  planChars: 16_000,
  diffChars: 120_000,
  verifyTailChars: 4_000,
  upstreamSummaryChars: 2_000,
  conventionsChars: 6_000,
} as const;

/** Keep head and tail, cut the middle with a visible marker. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 60);
  const head = Math.ceil(keep * 0.7);
  const tailLength = keep - head;
  const omitted = text.length - head - tailLength;
  return `${text.slice(0, head)}\n[… ${omitted} characters omitted …]\n${tailLength > 0 ? text.slice(-tailLength) : ''}`;
}

/** Keep the tail (logs). */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[… ${text.length - max} earlier characters omitted …]\n${text.slice(-max)}`;
}

/** A fenced block whose fence is longer than any backtick run inside. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}

/** Shift markdown headings down by `by` levels (outside code fences) so embedded documents nest. */
export function demoteHeadings(markdown: string, by = 2): string {
  let fenceMarker: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1] as string;
        if (fenceMarker === null) fenceMarker = marker;
        else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) fenceMarker = null;
        return line;
      }
      const heading = fenceMarker === null ? /^(#{1,6})(\s.*)?$/.exec(line) : null;
      if (!heading) return line;
      return `${'#'.repeat(Math.min(6, (heading[1] as string).length + by))}${heading[2] ?? ''}`;
    })
    .join('\n');
}

/**
 * The body of a `# <title>`..`### <title>` section of a markdown document (case-insensitive), or null.
 * Useful to pull the plan's Summary for the PR body.
 */
export function markdownSection(markdown: string, title: string): string | null {
  const lines = markdown.split('\n');
  const wanted = title.trim().toLowerCase();
  const start = lines.findIndex((l) => {
    const m = /^#{1,3}\s+(.*?)\s*$/.exec(l);
    return m !== null && (m[1] as string).toLowerCase() === wanted;
  });
  if (start === -1) return null;
  const level = (/^#+/.exec(lines[start] as string)?.[0] ?? '#').length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+)\s/.exec(l);
    return m !== null && (m[1] as string).length <= level;
  });
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

export function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}`;
}

export function bullets(items: readonly string[], empty = '(none)'): string {
  return items.length === 0 ? empty : items.map((i) => `- ${i}`).join('\n');
}

export function numbered(items: readonly string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

export function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n');
}

export function formatIssue(issue: IssueInput): string {
  return join(
    `**${issue.title.trim()}**`,
    issue.url ? `Source: ${issue.url}` : null,
    fence(clipMiddle(issue.text.trim() || '(no description)', PROMPT_LIMITS.issueChars), 'text'),
    formatAttachments(issue.attachments ?? []),
  );
}

const ATTACHMENT_KIND_LABEL: Record<AttachmentNote['kind'], string> = {
  image: 'image',
  text: 'text file',
  file: 'document',
};

/** One line naming the files attached to the issue (their content travels with this message). */
export function formatAttachments(attachments: readonly AttachmentNote[]): string | null {
  if (attachments.length === 0) return null;
  const list = attachments.map((a) => `\`${a.name.replace(/`/g, "'")}\` (${ATTACHMENT_KIND_LABEL[a.kind]})`).join(', ');
  const images = attachments.some((a) => a.kind === 'image');
  return `Attached by the human: ${list}. Their content is included in this conversation${images ? '; images are often UI references (mockups, screenshots of bugs) — look at them closely' : ''}.`;
}

export function formatRepo(repo: RepoInput): string {
  return join(
    bullets([
      `Base ref: \`${repo.baseRef}\``,
      `Repo verify commands (\`legion.json\`): ${inlineList(repo.verifyCommands)}`,
      `Setup commands: ${inlineList(repo.setupCommands)}`,
      `Install command: ${repo.installCommand ? `\`${repo.installCommand}\`` : '(not configured)'}`,
    ]),
    repo.conventions?.trim()
      ? `Repository conventions:\n\n${clipMiddle(repo.conventions.trim(), PROMPT_LIMITS.conventionsChars)}`
      : null,
  );
}

function inlineList(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.map((v) => `\`${v}\``).join(', ') : '(none)';
}

/** The full task spec, as every role sees it. */
/** Where coders find the whole approved plan in their worktree (provisioned, never committed). */
export const PLAN_FILE = '.legion/plan.md';

/**
 * The whole approved plan as one document (the coders' `.legion/plan.md`, the lead's `read_plan`): its
 * markdown with every contract, then every task's spec. With `section`, only the part under that heading.
 */
export function planDocument(
  plan: { version: number; markdown: string; nodes: readonly TaskNode[] },
  section: string | null = null,
): string {
  const doc = [
    `# Approved plan (v${plan.version})`,
    plan.markdown.trim(),
    '## Tasks',
    ...plan.nodes.map((node) => formatNodeSpec(node)),
  ].join('\n\n');
  if (!section?.trim()) return `${doc}\n`;
  return markdownSection(doc, section) ?? `No section "${section}" in the plan. Its headings:\n\n${headings(doc)}`;
}

function headings(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .join('\n');
}

export function formatNodeSpec(node: TaskNode): string {
  const touches = node.touches.map((t) => `\`${t.glob}\` (${t.mode})`);
  return join(
    `### ${node.id}: ${node.title}`,
    bullets([
      `Kind: ${node.kind}`,
      `Size: ${node.size}`,
      `Risk: ${node.risk}`,
      `Depends on: ${node.dependsOn.join(', ') || '(none)'}`,
    ]),
    `**Goal**\n\n${node.goal.trim()}`,
    `**Acceptance criteria**\n\n${bullets(node.acceptanceCriteria.map((c) => `**${c.id}**: ${c.text}`))}`,
    `**Declared touches** (create/modify = may write; read = context only)\n\n${bullets(touches)}`,
    `**Verify commands**\n\n${bullets(node.verify.commands.map((c) => `\`${c}\``))}`,
    node.contextHints.files.length > 0 || node.contextHints.notes.trim()
      ? `**Context hints**\n\n${join(
          node.contextHints.files.length > 0 ? bullets(node.contextHints.files.map((f) => `\`${f}\``)) : null,
          node.contextHints.notes.trim() || null,
        )}`
      : null,
  );
}

export function formatUpstream(upstream: readonly UpstreamSummary[]): string {
  if (upstream.length === 0) return 'No upstream tasks: this task starts from the base.';
  return upstream
    .map((u) =>
      join(
        `### ${u.nodeId}: ${u.title} (merged)`,
        clipMiddle(u.summary.trim() || '(no summary)', PROMPT_LIMITS.upstreamSummaryChars),
        u.files && u.files.length > 0 ? `Files: ${u.files.map((f) => `\`${f}\``).join(', ')}` : null,
      ),
    )
    .join('\n\n');
}

/**
 * Verification results as a bullet list, failures with their output tail. Gate results show by name with
 * their status and summary (built-in gates without a command); legacy results by their command.
 */
export function formatVerifyResults(results: readonly (VerifyResultInput | GateResult)[]): string {
  if (results.length === 0) return '(no verification results)';
  return results.map((r) => (isGateResult(r) ? formatGateResult(r) : formatLegacyVerifyResult(r))).join('\n');
}

function isGateResult(r: VerifyResultInput | GateResult): r is GateResult {
  return 'name' in r && 'status' in r && typeof r.name === 'string' && typeof r.status === 'string';
}

function formatDuration(durationMs: number | null | undefined): string {
  return durationMs != null ? `, ${(durationMs / 1000).toFixed(1)}s` : '';
}

function formatTail(text: string): string | null {
  const tail = text.trim();
  return tail ? fence(clipTail(tail, PROMPT_LIMITS.verifyTailChars), 'text') : null;
}

function formatLegacyVerifyResult(r: VerifyResultInput): string {
  const outcome =
    r.exitCode === null ? 'killed / timed out' : r.exitCode === 0 ? 'passed' : `failed (exit ${r.exitCode})`;
  return join(
    `- \`${r.command}\`: ${outcome}${formatDuration(r.durationMs)}`,
    r.exitCode === 0 ? null : formatTail(r.outputTail),
  );
}

function formatGateResult(r: GateResult): string {
  const builtin = r.kind !== 'command';
  const outcome =
    r.status === 'pass'
      ? 'passed'
      : r.status === 'skipped'
        ? 'skipped'
        : !r.blocking
          ? 'warning'
          : builtin || r.exitCode === 0
            ? 'failed'
            : r.exitCode === null
              ? 'killed / timed out'
              : `failed (exit ${r.exitCode})`;
  const command = builtin ? '' : ` (\`${r.command}\`)`;
  const summary = r.summary.trim() ? ` — ${r.summary.trim()}` : '';
  return join(
    `- **${r.name}**${command}: ${outcome}${formatDuration(r.durationMs)}${summary}`,
    r.status === 'fail' ? formatTail(r.outputTail) : null,
  );
}

export function formatFindings(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return '(none)';
  return findings
    .map((f, i) => {
      const where = f.file ? ` — \`${f.file}${f.line != null ? `:${f.line}` : ''}\`` : '';
      return join(
        `${i + 1}. **[${f.severity}] ${f.title}**${where}`,
        indent(f.body.trim()),
        f.suggestedFix?.trim() ? indent(`Suggested fix: ${f.suggestedFix.trim()}`) : null,
      );
    })
    .join('\n');
}

export function formatCriteria(criteria: readonly ReviewCriterion[]): string {
  return bullets(criteria.map((c) => `**${c.id}** (${c.status}): ${c.evidence}`));
}

export function formatScope(scope: ScopeReport): string {
  return bullets([
    `Changed files within declared touches: ${scope.inScope.length}`,
    `Out of scope: ${scope.outOfScope.length === 0 ? 'none' : scope.outOfScope.map((p) => `\`${p}\``).join(', ')}`,
    ...(scope.readOnly.length > 0
      ? [`Declared read-only but changed: ${scope.readOnly.map((p) => `\`${p}\``).join(', ')}`]
      : []),
    `Declared write touches left untouched: ${scope.unusedTouches.length === 0 ? 'none' : scope.unusedTouches.map((p) => `\`${p}\``).join(', ')}`,
  ]);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `   ${line}` : line))
    .join('\n');
}
