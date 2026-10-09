/**
 * Workspace-write roles: coder, fixer (follow-up in the coder session), final fixer (the integration branch after
 * the final review) and merge-conflict resolver.
 */
import type { TaskNode } from '@shared/domain';
import {
  bullets,
  clipMiddle,
  demoteHeadings,
  fence,
  formatCriteria,
  formatFindings,
  formatIssue,
  formatNodeSpec,
  formatRepo,
  formatUpstream,
  formatVerifyResults,
  join,
  numbered,
  PROMPT_LIMITS,
  section,
} from './format';
import {
  type AgentPrompt,
  type CoderPromptInput,
  DEFAULT_TOOL_NAMES,
  type FinalFixerPromptInput,
  type FixerPromptInput,
  type ResolverPromptInput,
  type ToolNames,
} from './types';

const TASK_SCOPE =
  'Stay in scope: do this task and nothing else. Change only the files covered by the declared touches. If another file must change, keep that change minimal and explain it in your summary. Do not refactor or reformat unrelated code.';

function workspaceRules(tools: ToolNames, extra: readonly string[] = [], scope = TASK_SCOPE): string {
  return bullets([
    'Work only inside the current working directory. It is a git worktree dedicated to this job; do not read or write files of other checkouts and do not `cd` outside it.',
    scope,
    'Do not commit, push, create or switch branches, rebase, reset, stash or otherwise change git state. Legion commits your work with the commit message you provide. Reading history and diffs is fine.',
    'Do not install new dependencies unless the task requires it.',
    `Report progress with \`${tools.reportProgress}\` at meaningful milestones (one short line each).`,
    `Finish by calling \`${tools.markTaskDone}\`; until you do, Legion considers the work unfinished.`,
    `Do not wait for a human when you can decide yourself: when something is ambiguous, choose what is most consistent with the plan and the codebase, and record the decision in your summary. Call \`${tools.requestHumanInput}\` only when you truly cannot proceed (contradictory requirements, missing access, a destructive choice only a human can make).`,
    ...extra,
  ]);
}

/** Coders (not resolvers): show the human what they built. */
function presentRule(tools: ToolNames): string {
  return `When your work produces something the human should see rather than read about (a screenshot of UI you changed, a generated report or diagram), show it with \`${tools.present}\` before you finish: save it under the system temp dir (never in the worktree), one call per thing, with a caption saying what to look at. Skip it when there is nothing visual or nothing new to show.`;
}

/** Coders with an implementation lead: where to take questions the plan leaves open. */
function leadRule(tools: ToolNames): string {
  return `You report to an implementation lead that knows the whole plan and the other tasks. When the task brief leaves open something that affects other tasks (a shared name, shape, interface or behaviour) or that the plan decided, ask the lead with \`${tools.askLead}\` instead of guessing; it answers from the plan. Small local decisions are yours: make them and note them in your summary.`;
}

function finishInstructions(tools: ToolNames, structuredReport: boolean, commitHint: string): string {
  return join(
    numbered([
      'Run every verify command of the task, and the repository-wide verify commands if there are any, and make them pass. If one cannot pass for reasons outside this task, say so explicitly in your summary.',
      `Call \`${tools.markTaskDone}\` with:\n   - \`summary\`: what you changed and why, decisions you made, anything the reviewer should look at closely (a few short paragraphs or bullets);\n   - \`commitMessage\`: ${commitHint}`,
    ]),
    structuredReport
      ? 'Then end your turn with the final task report as structured output: `status` (done | blocked | partial), `summary`, `commitMessage`, `criteria` (each acceptance criterion with met | unmet | unclear and concrete evidence) and `notes` (follow-ups or risky spots, or null).'
      : null,
  );
}

const CODER_SYSTEM = `You are a coding agent in Legion, an orchestrator that runs several coding agents in parallel on one plan. You implement exactly one task of that plan in your own git worktree. Other agents implement the other tasks at the same time; independent reviewers check your work against the task's acceptance criteria before it is merged.`;

/** The coder's system prompt; `lead` adds where to take questions the plan leaves open. */
export function coderSystem(tools: ToolNames, lead: boolean): string {
  return join(
    CODER_SYSTEM,
    section('Rules', workspaceRules(tools, [presentRule(tools), ...(lead ? [leadRule(tools)] : [])])),
  );
}

/** The fixer's system prompt: the coder's, without the lead (a fix round answers to its findings). */
export function fixerSystem(tools: ToolNames): string {
  return coderSystem(tools, false);
}

/** Coder: implement one task node. */
export function buildCoderPrompt(input: CoderPromptInput): AgentPrompt {
  const tools = input.tools ?? DEFAULT_TOOL_NAMES;
  const node = input.node;
  const retry =
    input.attempt > 1
      ? section(
          `This is attempt ${input.attempt}`,
          join(
            "A previous attempt at this task failed and the worktree was reset to the task's starting point. Learn from the failure; take a different approach if the previous one was the problem.",
            input.previousFailure?.trim() ? fence(clipMiddle(input.previousFailure.trim(), 4_000), 'text') : null,
          ),
        )
      : null;
  const systemPrompt = coderSystem(tools, input.lead === true);
  const prompt = join(
    `Implement task ${node.id}: ${node.title}.`,
    section(
      'Plan summary',
      join(
        demoteHeadings(clipMiddle(input.planSummary.trim(), PROMPT_LIMITS.planChars)),
        input.planFile
          ? `The whole approved plan is in \`${input.planFile}\` in your worktree: its approach and every contract (names, types, signatures, schemas, file layout) and the other tasks. Read the parts your task defines or builds on before you write code, and use its names exactly. It is Legion's file: never edit or commit it.`
          : null,
      ),
    ),
    section('Your task', formatNodeSpec(node)),
    section('Upstream tasks (already merged into your starting point)', formatUpstream(input.upstream)),
    section('Original issue', formatIssue(input.issue)),
    section('Repository', formatRepo(input.repo)),
    retry,
    section(
      'How to work',
      numbered([
        'Read the context hints, the files you will change and the code that calls them. Check what the upstream tasks merged: build on their contracts, do not redefine them.',
        "Implement the goal so that every acceptance criterion is met. Follow the repository's conventions and existing patterns.",
        'Add or update tests as the acceptance criteria require.',
      ]),
    ),
    section(
      'When you are done',
      finishInstructions(
        tools,
        input.structuredReport === true,
        `an imperative subject of at most 72 characters in the repository's commit style (for example "Add range parsing to the query builder"), optionally followed by a blank line and a short body.`,
      ),
    ),
  );
  return { systemPrompt, prompt };
}

/**
 * Fixer: a follow-up message in the coder's session (resumed), or the first message of a fresh session.
 * It is self-contained enough for both.
 */
export function buildFixerPrompt(input: FixerPromptInput): AgentPrompt {
  const tools = input.tools ?? DEFAULT_TOOL_NAMES;
  const node = input.node;
  const systemPrompt = fixerSystem(tools);
  const merged = input.mergedIntegrationRef
    ? `Your task passed review, but verification failed after merging it into the integration branch. Legion has merged \`${input.mergedIntegrationRef}\` into your branch, so your worktree now contains the other tasks' merged work. The failure is most likely an interaction between your change and theirs: fix it on your side and keep their behavior intact.`
    : null;
  const prompt = join(
    `Fix round ${input.round} of ${input.maxRounds} for task ${node.id}: ${node.title}.`,
    merged,
    input.humanNote?.trim() ? section('Note from the human', input.humanNote.trim()) : null,
    input.findings.length > 0 ? section('Review findings to address', formatFindings(input.findings)) : null,
    input.unmetCriteria.length > 0
      ? section('Acceptance criteria the reviewer did not consider met', formatCriteria(input.unmetCriteria))
      : null,
    input.failedVerify.length > 0 ? section('Failed verification', formatVerifyResults(input.failedVerify)) : null,
    section(
      'Task reminder',
      join(
        `**Acceptance criteria**\n\n${bullets(node.acceptanceCriteria.map((c) => `**${c.id}**: ${c.text}`))}`,
        `**Declared touches**\n\n${bullets(node.touches.map((t) => `\`${t.glob}\` (${t.mode})`))}`,
        `**Verify commands**\n\n${bullets(node.verify.commands.map((c) => `\`${c}\``))}`,
      ),
    ),
    section(
      'How to fix',
      bullets([
        'Address every item above. Fix the cause, not the symptom: do not weaken or delete tests to make them pass.',
        'If you are confident a finding is wrong, do not change the code for it; explain why in your summary. A fresh reviewer will read your explanation.',
        'Make no unrelated changes.',
      ]),
    ),
    section(
      'When you are done',
      finishInstructions(
        tools,
        input.structuredReport === true,
        'the commit message for the whole task (not just this round), in the same style as before.',
      ),
    ),
  );
  return { systemPrompt, prompt };
}

/** The final fixer's system prompt: the coder's rules, scoped to the findings instead of one task. */
export function finalFixerSystem(tools: ToolNames): string {
  return join(
    'You are a coding agent in Legion, an orchestrator that implemented an issue as several tasks written by different coding agents in parallel. Every task was reviewed and merged into the integration branch; a final reviewer then read the combined change and found problems. You fix them in the integration worktree.',
    section(
      'Rules',
      workspaceRules(
        tools,
        [presentRule(tools)],
        'Stay in scope: fix the findings you are given and nothing else. Several tasks wrote this code, so change whatever files the fixes need, but keep each change minimal and do not refactor or reformat unrelated code.',
      ),
    ),
  );
}

/**
 * Final fixer: the final review found blockers in the combined change. A coder session in the integration
 * worktree (resumed across rounds, or fresh) fixes them; Legion commits, re-verifies and reviews again.
 */
export function buildFinalFixerPrompt(input: FinalFixerPromptInput): AgentPrompt {
  const tools = input.tools ?? DEFAULT_TOOL_NAMES;
  const systemPrompt = finalFixerSystem(tools);
  const prompt = join(
    `Final fix round ${input.round} of ${input.maxRounds} on \`${input.integrationRef}\` (the combined change \`${input.baseRef}...${input.integrationRef}\`).`,
    input.humanNote?.trim() ? section('Note from the human', input.humanNote.trim()) : null,
    input.findings.length > 0 ? section('Final review findings to address', formatFindings(input.findings)) : null,
    input.unmetCriteria.length > 0
      ? section('Requirements the final reviewer did not consider met', formatCriteria(input.unmetCriteria))
      : null,
    section('Original issue', formatIssue(input.issue)),
    section(
      'Verify commands',
      bullets(
        input.verifyCommands.map((c) => `\`${c}\``),
        '(none declared; run the tests that cover the code you change)',
      ),
    ),
    section(
      'How to fix',
      bullets([
        `Read the change with \`git diff ${input.baseRef}...HEAD\` and the code around each finding before you edit.`,
        'Address every item above. Fix the cause, not the symptom: do not weaken or delete tests to make them pass.',
        'Keep the behavior of the merged tasks intact; they were each reviewed. Prefer the smallest change that makes the whole coherent.',
        'If you are confident a finding is wrong, do not change the code for it; explain why in your summary. A fresh final reviewer will read your explanation.',
      ]),
    ),
    section(
      'When you are done',
      finishInstructions(
        tools,
        input.structuredReport === true,
        'an imperative subject of at most 72 characters describing this fix (for example "Register the CSV exporter with the report menu"), optionally followed by a blank line and a short body.',
      ),
    ),
  );
  return { systemPrompt, prompt };
}

function briefSpec(node: TaskNode): string {
  return join(
    `### ${node.id}: ${node.title}`,
    node.goal.trim(),
    bullets(node.acceptanceCriteria.map((c) => `**${c.id}**: ${c.text}`)),
  );
}

/** The merge-conflict resolver's system prompt. */
export function resolverSystem(tools: ToolNames): string {
  return join(
    'You are a merge-conflict resolver in Legion, an orchestrator that runs several coding agents in parallel on one plan. A task branch has to absorb the integration branch, which already contains other reviewed tasks, and the merge stopped with conflicts.',
    section(
      'Rules',
      workspaceRules(tools, [
        'Exception to the git rule: you may pick one side of a conflicted file with `git checkout --ours -- <file>` (this task) or `git checkout --theirs -- <file>` (integration). Do not commit, stage, abort the merge or reset; Legion completes the merge commit.',
      ]),
    ),
  );
}

/** Resolver: finish a conflicted merge of the integration branch into the task branch. */
export function buildResolverPrompt(input: ResolverPromptInput): AgentPrompt {
  const tools = input.tools ?? DEFAULT_TOOL_NAMES;
  const systemPrompt = resolverSystem(tools);
  const install = input.installCommand ? `\`${input.installCommand}\`` : "the repository's install command";
  const prompt = join(
    `Resolve the merge of \`${input.integrationRef}\` into the branch of task ${input.node.id}: ${input.node.title}.`,
    input.attempt > 1
      ? section(
          `This is attempt ${input.attempt}`,
          input.previousFailure?.trim()
            ? `The previous resolution failed:\n\n${fence(clipMiddle(input.previousFailure.trim(), 4_000), 'text')}`
            : 'The previous resolution failed.',
        )
      : null,
    section('Conflicted files', bullets(input.conflictFiles.map((f) => `\`${f}\``))),
    section('This task (your side, "ours")', briefSpec(input.node)),
    section(
      'Already merged tasks touching the same code (integration side, "theirs")',
      input.otherNodes.length > 0 ? input.otherNodes.map(briefSpec).join('\n\n') : '(unknown)',
    ),
    section(
      'How to resolve',
      numbered([
        'For every conflicted file, read both sides and understand what each task intended.',
        "Preserve the intent of both. The integration side has already been reviewed and merged: keep its behavior and adapt this task's change on top of it.",
        "Never drop either side's tests. If both sides added tests, keep both.",
        `Lockfiles and generated files are never merged by hand: take the integration version, then regenerate them (for lockfiles run ${install}).`,
        'Remove every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) and make sure nothing else still refers to removed code.',
        'Run the verify commands of this task and make them pass.',
        `If the two sides genuinely contradict each other and no resolution can preserve both intents, explain the contradiction with \`${tools.requestHumanInput}\` instead of guessing.`,
      ]),
    ),
    section(
      'When you are done',
      finishInstructions(
        tools,
        input.structuredReport === true,
        `\`Merge ${input.integrationRef} into ${input.node.id}\`, followed by a blank line and one line per conflicted file describing how you resolved it.`,
      ),
    ),
  );
  return { systemPrompt, prompt };
}
