/** Read-only review roles: per-task reviewer (§8 Review) and the final holistic reviewer (§8 step 7). */
import {
  bullets,
  clipMiddle,
  demoteHeadings,
  fence,
  formatFindings,
  formatIssue,
  formatNodeSpec,
  formatScope,
  formatUpstream,
  formatVerifyResults,
  join,
  numbered,
  PROMPT_LIMITS,
  section,
} from './format';
import type { AgentPrompt, FinalizerPromptInput, ReviewerPromptInput } from './types';

const READ_ONLY_RULES = bullets([
  'You are read-only. Do not create, modify or delete files, and do not change git state. Reading files, searching, viewing diffs and history, and running the verify commands, tests, linters and type checkers are all fine.',
  'Every claim needs evidence: a file and line, a quoted line of code, or command output you observed. Do not speculate about code you have not read.',
  'Respond with the structured review output only.',
]);

const SEVERITIES = bullets([
  '`blocker`: wrong behavior, data loss, a security hole, a broken build or test suite, or an acceptance criterion not met.',
  "`major`: a real bug in an edge case that matters, a missing test the criteria require, a broken or silently changed contract other code relies on, or an unjustified change outside the task's scope.",
  '`minor`: worth fixing but not worth another round (clarity, small robustness gaps, weak test assertions).',
  '`nit`: style and taste. Only mention it if it is cheap and clearly better; never what a linter or formatter already enforces.',
]);

const FINDING_FIELDS =
  'Each finding has `severity`, `file` (repo-relative, or null), `line` (in the new version of the file, or null), a short `title`, a `body` that explains the problem and its consequence, and a concrete `suggestedFix` (or null).';

/** Per-task reviewer: fresh session, other engine, adversarial but fair. */
export function buildReviewerPrompt(input: ReviewerPromptInput): AgentPrompt {
  const node = input.node;
  const systemPrompt = join(
    'You are an independent code reviewer in Legion, an orchestrator that runs several coding agents in parallel on one plan. You did not write the code under review. Be adversarial but fair: hunt for real defects (incorrect logic, unhandled edge cases, broken contracts, tests that do not test what they claim, security problems, scope creep), and approve good work without inventing problems.',
    section('Rules', READ_ONLY_RULES),
  );
  const previous =
    input.round > 0
      ? section(
          `Re-review after fix round ${input.round}`,
          join(
            'The coder was asked to address the findings below. Check each one: drop it if it is fixed, raise it again (same title) if it is not. Do not move the goalposts: raise new findings only for real problems, including ones the fix introduced.',
            formatFindings(input.previousFindings ?? []),
          ),
        )
      : null;
  const prompt = join(
    `Review task ${node.id}: ${node.title}. The working directory contains the task's branch; \`git diff ${input.startSha}\` reproduces the diff below.`,
    section('Task under review', formatNodeSpec(node)),
    section('Plan summary', demoteHeadings(clipMiddle(input.planSummary.trim(), PROMPT_LIMITS.planChars))),
    section('Upstream tasks (merged before this task started)', formatUpstream(input.upstream)),
    section('Original issue', formatIssue(input.issue)),
    input.coderSummary?.trim()
      ? section("Coder's summary (a claim to check, not evidence)", input.coderSummary.trim())
      : null,
    section('Verification run by Legion', formatVerifyResults(input.verify)),
    section('Scope check (changed files vs declared touches)', formatScope(input.scope)),
    previous,
    section('Diff', fence(clipMiddle(input.diff, PROMPT_LIMITS.diffChars), 'diff')),
    section(
      'How to review',
      numbered([
        'Read the diff in full, then open the changed files and their callers to judge the change in context.',
        'For every acceptance criterion decide `met`, `unmet` or `unclear`, with evidence. `unclear` also blocks approval, so investigate (read the code, run the relevant verify command) before settling on it.',
        'Look for defects the criteria do not mention: error handling, boundary conditions, concurrency, resource cleanup, security, and consistency with the upstream contracts.',
        'Judge out-of-scope changes: necessary and minimal is fine; unrelated edits, or edits to files other tasks own, are `major`.',
      ]),
    ),
    section('Severity', SEVERITIES),
    section(
      'Output',
      join(
        `\`criteria\`: one entry per acceptance criterion (${node.acceptanceCriteria.map((c) => `\`${c.id}\``).join(', ') || 'none'}) with \`id\`, \`status\` and \`evidence\`.`,
        `\`findings\`: ${FINDING_FIELDS} Empty when there is nothing worth saying.`,
        '`verdict`: `approve` only if every criterion is `met` and there is no blocker or major finding; `request_changes` when a fix round can solve the problems; `reject_replan` only when the task as specified cannot work (the spec contradicts the codebase or the issue) and no amount of fixing will help.',
        '`summary`: 2–4 sentences for the human: overall quality, the most important problems, and what you checked.',
      ),
    ),
  );
  return { systemPrompt, prompt };
}

/** Final holistic review over base...integration against the issue and the plan. */
export function buildFinalizerPrompt(input: FinalizerPromptInput): AgentPrompt {
  const systemPrompt = join(
    'You are the final reviewer in Legion, an orchestrator that implemented an issue as several tasks written by different coding agents in parallel. Each task was already reviewed on its own. Your job is the whole: does the combined change resolve the issue, and does it hang together as if one careful engineer had written it?',
    section('Rules', READ_ONLY_RULES),
  );
  const taskRows = input.tasks.map((t) => {
    const summary = t.summary?.trim() ? clipMiddle(t.summary.trim().replace(/\s+/g, ' '), 600) : '(no summary)';
    return `**${t.node.id}: ${t.node.title}** (${t.status}${t.verdict ? `, review: ${t.verdict}` : ''}): ${summary}`;
  });
  const round = input.round ?? 0;
  const previous =
    round > 0
      ? section(
          `Re-review after final fix round ${round}`,
          join(
            'A coder was asked to fix the findings below on the integration branch. Check each one: drop it if it is fixed, raise it again (same title) if it is not. Do not move the goalposts: raise new findings only for real problems, including ones the fix introduced.',
            formatFindings(input.previousFindings ?? []),
          ),
        )
      : null;
  const prompt = join(
    `Review the combined change \`${input.baseRef}...${input.integrationRef}\`. The working directory is the integration branch.`,
    section('Original issue', formatIssue(input.issue)),
    section('Approved plan', demoteHeadings(clipMiddle(input.planMarkdown.trim(), PROMPT_LIMITS.planChars))),
    section('Tasks', bullets(taskRows)),
    section('Final verification on the integration branch', formatVerifyResults(input.verify)),
    previous,
    section('Diff stat', fence(input.diffStat.replace(/^\n+|\s+$/g, '') || '(empty)', 'text')),
    section('Diff', fence(clipMiddle(input.diff, PROMPT_LIMITS.diffChars), 'diff')),
    section(
      'What to check',
      numbered([
        'Coverage: list the requirements the issue states or clearly implies, and check each one against the code. Skipped or failed tasks leave gaps; call them out.',
        'Coherence: duplicated helpers, inconsistent naming or error handling between tasks, two implementations of the same idea, contracts used differently by different tasks.',
        'Wiring: things defined but never registered, exported, routed, configured or called; leftover stubs, TODOs, debug output, dead code.',
        'Tests and docs: the main paths are tested; docs, configuration and migrations match the code.',
        'Safety: security, data handling and compatibility problems that only show in the combined change.',
      ]),
    ),
    section('Severity', SEVERITIES),
    section(
      'Output',
      join(
        '`criteria`: one entry per requirement, ids `R1`, `R2`, …; start each `evidence` with the requirement in one sentence, then the evidence.',
        `\`findings\`: ${FINDING_FIELDS}`,
        '`verdict`: `approve` only if every requirement is `met` and there is no blocker or major finding; `request_changes` for problems a follow-up fix can solve; `reject_replan` when the approach is fundamentally wrong.',
        '`summary`: 3–6 sentences a human can paste into the pull request: what the change does, how confident you are, and what to look at.',
      ),
    ),
  );
  return { systemPrompt, prompt };
}
