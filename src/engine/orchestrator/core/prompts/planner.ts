/** Planner prompts: clarify (§8 step 2) and plan (§8 step 3). Both run read-only, in the same session. */
import { bullets, clipMiddle, fence, formatIssue, formatRepo, join, numbered, PROMPT_LIMITS, section } from './format';
import type { AgentPrompt, ClarifyPromptInput, PlanPromptInput } from './types';

const PLANNER_SYSTEM = `You are the planner in Legion, an orchestrator that turns an issue into a pull request using several coding agents (Claude Code and Codex) working in parallel.

How your plan is executed:
- Every task in your plan is implemented by a fresh coding agent in its own git worktree. That agent sees only the plan summary, its own task, and short summaries of the tasks it depends on. It does not see this conversation.
- A task starts only after every task it depends on has been reviewed and merged into a shared integration branch. Independent tasks run in parallel.
- Each finished task is verified with its verify commands and reviewed by a different model against its acceptance criteria before it is merged.

You are in read-only mode: explore the repository with your file-reading, search and read-only shell tools. Do not create, modify or delete files, and do not run commands that change the repository, install packages or touch the network.`;

/** Clarify step: decide whether questions are needed (0–5), with options where possible. */
export function buildClarifyPrompt(input: ClarifyPromptInput): AgentPrompt {
  const max = Math.min(5, Math.max(0, input.maxQuestions ?? 5));
  const prompt = join(
    'Before planning, decide whether the issue below is clear enough to plan. Most well-written issues are: asking zero questions is the expected outcome, not a failure.',
    section('Issue', formatIssue(input.issue)),
    section('Repository', formatRepo(input.repo)),
    section(
      'What to do',
      numbered([
        'Skim the repository enough to understand the area the issue touches: the README, the modules involved, existing patterns. Keep this short; the planning step will explore in depth.',
        'List the open decisions you would have to make to plan this work. Drop every decision the code, the conventions or common sense already settle, and every detail that implementation or review will settle.',
        `Ask only about what remains: decisions that would change the plan materially (scope, user-visible behavior, interfaces, compatibility, data migrations, security trade-offs). Ask at most ${max} question${max === 1 ? '' : 's'}; fewer is better.`,
      ]),
    ),
    section(
      'How to write questions',
      bullets([
        'One decision per question, answerable in a few seconds, understandable without reading the code.',
        'Give 2–4 concrete, mutually exclusive options whenever the answer space is small. Put the option you would choose first. Leave `options` empty only for genuinely free-form answers (a name, a URL, a number).',
        'Use ids `q1`, `q2`, … in the order a human should answer them.',
        'Do not ask for permission to start, for confirmation of what the issue already says, or about things you can look up.',
      ]),
    ),
    section(
      'Output',
      'Respond with the structured output only: `{"questions": [...]}`, each question as `{id, question, options}`. Return `{"questions": []}` when nothing needs clarifying.',
    ),
  );
  return { systemPrompt: PLANNER_SYSTEM, prompt };
}

/** Plan step: explore read-only, then produce `{markdown, dag}` per the plan schema. */
export function buildPlanPrompt(input: PlanPromptInput): AgentPrompt {
  const maxTasks = input.maxTasks ?? 12;
  const repoVerify = input.repo.verifyCommands ?? [];

  const revision = input.revision
    ? section(
        'Revision requested',
        join(
          'A human reviewed your previous plan and asked for changes. Revise it to address the feedback fully. Keep ids, wording and structure of tasks the feedback does not concern, so the human can see what changed.',
          `**Feedback**\n\n${fence(input.revision.feedback.trim(), 'text')}`,
          `**Previous plan**\n\n${fence(clipMiddle(input.revision.previousMarkdown.trim(), PROMPT_LIMITS.planChars), 'markdown')}`,
          `**Previous tasks**\n\n${fence(clipMiddle(JSON.stringify(input.revision.previousNodes, null, 2), PROMPT_LIMITS.planChars), 'json')}`,
        ),
      )
    : null;
  const validation =
    input.validationErrors && input.validationErrors.length > 0
      ? section(
          'Your previous output was rejected',
          `Legion's plan validator found these problems. Produce a corrected plan that fixes all of them:\n\n${bullets(input.validationErrors)}`,
        )
      : null;

  const prompt = join(
    'Produce the implementation plan for the issue below.',
    section('Issue', formatIssue(input.issue)),
    input.answers.length > 0
      ? section(
          'Clarifications from the human',
          input.answers.map((a) => `- **Q:** ${a.question}\n  **A:** ${a.answer}`).join('\n'),
        )
      : null,
    section('Repository', formatRepo(input.repo)),
    revision,
    validation,
    section(
      'Step 1: explore (read-only)',
      numbered([
        'Find every place the change touches: entry points, the modules to change, their callers, their tests.',
        'Learn the conventions to follow: language and framework versions, module layout, naming, error handling, how tests are written and where they live, lint/format rules.',
        'Find the commands that really exist for checking work: package scripts, Makefile targets, CI workflow steps. Note the fastest scoped forms (a single test file, a single package).',
        'Identify the hot files several changes would want to edit: manifests and lockfiles, barrel `index` files, route or plugin registries, schema files, shared configuration.',
      ]),
    ),
    section(
      'Step 2: design the task graph',
      bullets([
        '**Contracts first.** Decisions that several tasks depend on (types, interfaces, function signatures, schemas, migrations, config keys, file layout) are made in an early `contracts` task that writes them down in code, with stubs where useful. Parallel tasks must never have to guess a shared name or shape.',
        "**Wide and shallow.** Prefer one contracts task, then many independent tasks, then one integration task. Add a dependency only when a task needs another task's code merged first. Do not chain tasks that could run in parallel.",
        '**Right-sized tasks.** One task = one focused agent session: at most ~400 changed lines and usually 1–5 files, independently verifiable. Size S ≈ under 100 changed lines, M ≈ 100–250, L ≈ 250–400 (avoid L; split it). Do not split work so finely that a task cannot be verified on its own.',
        '**One writer per file.** Each file should be created or modified by exactly one task. If two tasks must write the same file, make one depend on the other. Legion serializes unordered tasks with overlapping writes automatically, which costs parallelism. Give hot files to a single owner, usually the contracts or the integration task.',
        '**Explicit touches.** For each task list every path it may create (`create`) or change (`modify`), plus important context (`read`). Use repo-relative paths or narrow globs (`src/api/users.ts`, `src/api/users/**`), never broad ones like `src/**`. Writes outside the declared touches are flagged to the reviewer.',
        '**Testable acceptance criteria.** 2–5 per task, ids `AC1`, `AC2`, …, each observable from the diff, the tests or a command (for example: "`parseRange` rejects reversed ranges with a `RangeError`; covered by a unit test"). Include tests in the same task as the code they test.',
        `**Real verify commands.** Each task needs at least one verify command that exists in this repository (or that the task itself adds), runs non-interactively from the repository root, and is as fast and scoped as the tooling allows. Never invent scripts or use placeholders. Legion also runs the repository-wide commands ${repoVerify.length > 0 ? repoVerify.map((c) => `\`${c}\``).join(', ') : '(none configured)'} on every task; do not repeat them.`,
        '**Integration last.** When there are three or more tasks, end with a task of kind `integration` that depends on the others, wires the pieces together (registrations, exports, configuration, docs) and runs the full test suite. A small issue may be a single task.',
        '**Risk.** `high` for database migrations, authentication or authorization, deleting data, breaking public APIs, CI or release configuration (these wait for human approval before merging); `med` for cross-cutting changes; `low` otherwise.',
        '**Effort.** Set `agent.effort` only with a reason: `high` for subtle algorithms or concurrency, `low` for mechanical edits; otherwise null. Do not choose engines or models: the user configures the coding agent.',
        '**Context hints.** In `contextHints.files` list the files the coder should read first; in `contextHints.notes` record pitfalls, conventions and the decisions from the contracts task the coder must follow.',
        `Use ids \`T1\`, \`T2\`, … in dependency order. Use at most ${maxTasks} tasks.`,
      ]),
    ),
    section(
      'Step 3: write the plan document',
      join(
        'The `markdown` field is what the human approves and what every coder reads as the plan summary. Use these sections:',
        numbered([
          '`## Summary`: 2–5 sentences that stand on their own: what changes and why.',
          '`## Approach`: the key design decisions and the contracts (names, signatures, data shapes) every task must respect.',
          '`## Tasks`: one line per task: id, title, what it delivers, its dependencies.',
          '`## Risks and open questions`: what could go wrong and the assumptions you made.',
          '`## Out of scope`: what this change deliberately does not do.',
        ]),
      ),
    ),
    section(
      'Output',
      'Respond with the structured output only: `{"markdown": "...", "dag": {"nodes": [...]}}`. Each node has `id`, `title`, `goal` (2–5 sentences: what and why), `kind` (contracts | feature | test | refactor | docs | integration), `dependsOn`, `acceptanceCriteria` (`{id, text}`), `touches` (`{glob, mode}`), `size` (S | M | L), `verify` (`{commands}`), `contextHints` (`{files, notes}`), `agent` (`{effort}`) and `risk` (low | med | high).',
    ),
  );
  return { systemPrompt: PLANNER_SYSTEM, prompt };
}
