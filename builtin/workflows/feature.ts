/**
 * feature: from a task description to a draft pull request.
 *
 * clarify → plan (human approves, or asks for changes) → integration branch → every task of the plan in its own
 * worktree, in dependency order and in parallel where possible: code → verify → review by the other engine →
 * fix rounds → squash-merge (an agent resolves conflicts) → final review of the whole → draft PR (or local merge).
 */
import { agent, ask, gate, loop, workflow, z } from 'legion';
import { checkPlan, Engine, executePlan, Plan } from './_tasks.ts';

const Input = z.object({
  task: z.string().min(1).describe('What to build or change: an issue text, a description, a link plus context.'),
  coder: Engine.default('claude').describe('Engine that writes code; the other one reviews.'),
  finish: z
    .enum(['pr', 'merge', 'branch'])
    .default('pr')
    .describe('Open a draft PR, merge into the base branch, or leave the branch.'),
  verify: z
    .array(z.string())
    .default([])
    .describe('Repository-wide checks run on every task and on the result (e.g. "pnpm test").'),
  maxFixRounds: z.number().int().min(0).max(5).default(2),
  clarify: z.boolean().default(true).describe('Let the planner ask questions first.'),
});

const Questions = z.object({
  questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.string()) })),
});

const PLANNER = `You are the planner of a multi-agent coding workflow. Every task in your plan is implemented by a fresh coding agent in its own git worktree; it sees only the plan summary, its own task and summaries of the tasks it depends on. A task starts after all its dependencies were reviewed and merged into a shared integration branch; independent tasks run in parallel. Each task is verified with its commands and reviewed by a different model before it is merged.
You are read-only: explore with reading, search and read-only shell commands. Do not change files, install packages or touch the network.`;

export default workflow(
  {
    name: 'feature',
    description: 'Plan a change, implement it as parallel reviewed tasks in worktrees, and open a draft PR.',
    input: Input,
    example: {
      task: 'Add a --json flag to the status command',
      coder: 'claude',
      finish: 'pr',
      verify: [],
      maxFixRounds: 2,
      clarify: true,
    },
  },
  async (input) => {
    // ---- clarify ------------------------------------------------------------------------------
    const answers: { question: string; answer: string }[] = [];
    if (input.clarify) {
      const { questions } = await agent('clarify', {
        mode: 'read',
        system: PLANNER,
        output: Questions,
        label: 'clarify the task',
        prompt: `Before planning, decide whether this task is clear enough to plan. Asking zero questions is the expected outcome for a well-written task.

Skim the repository enough to understand the area it touches. Ask only about decisions that would change the plan materially (scope, user-visible behavior, interfaces, compatibility, migrations, security trade-offs) and that the code, conventions or common sense do not settle. At most 4 questions, one decision each, with 2–4 concrete options (your preferred one first) unless the answer is free-form.

## Task
${input.task}`,
      });
      for (const q of questions) {
        answers.push({ question: q.question, answer: await ask(`answer-${q.id}`, q.question, { options: q.options }) });
      }
    }

    // ---- plan (until approved) ----------------------------------------------------------------
    // Why the previous round did not end in an approved plan; what the next draft must address.
    let lastFeedback: string | null = null;
    const planned = await loop<Plan>('plan', { max: 5 }, async (round) => {
      const feedback = round > 1 ? lastFeedback : null;
      const plan = await agent('draft', {
        mode: 'read',
        system: PLANNER,
        output: Plan,
        label: round === 1 ? 'plan' : `plan (revision ${round - 1})`,
        // Revisions continue the previous draft's session, which already explored the repository.
        ...(round > 1 ? { resume: `plan/${round - 1}/draft` } : input.clarify ? { resume: 'clarify' } : {}),
        prompt: round > 1 ? `Revise the plan.\n\n${feedback}` : planPrompt(input.task, answers, input.verify),
      });
      const problems = checkPlan(plan);
      if (problems.length > 0) {
        lastFeedback = `The plan is invalid; fix all of these:\n${problems.map((p) => `- ${p}`).join('\n')}`;
        return;
      }
      const verdict = await gate('approve', { title: 'Approve the plan?', show: showPlan(plan) });
      if (verdict.approved) return { done: true, value: plan };
      lastFeedback = `A human reviewed the plan and asked for changes. Address the feedback fully; keep ids and wording of tasks it does not concern.\n\nFeedback:\n${verdict.note ?? '(none given)'}`;
    });
    if (!planned.value) throw new Error('No approved plan after 5 rounds');

    return executePlan(planned.value, { ...input, title: input.task });
  },
);

function planPrompt(task: string, answers: { question: string; answer: string }[], verify: readonly string[]): string {
  return `Produce the implementation plan for the task below.

## Task
${task}
${answers.length ? `\n## Clarifications from the human\n${answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join('\n')}\n` : ''}
## Explore (read-only)
Find every place the change touches (entry points, modules, callers, tests), the conventions to follow, the check commands that really exist (package scripts, Makefile, CI) with their fastest scoped forms, and the hot files several changes would want to edit (manifests, lockfiles, barrels, registries).

## Design the task graph
- Contracts first: shared types, interfaces, schemas and names go into an early task so parallel tasks never guess a shared shape.
- Wide and shallow: one contracts task, many independent tasks, one integration task at the end when there are three or more. Add a dependency only when a task needs another's code merged first.
- Right-sized: one focused agent session each (≤ ~400 changed lines, usually 1–5 files), independently verifiable, tests in the same task as the code.
- One writer per file: if two tasks must write the same file, make one depend on the other.
- 2–5 testable acceptance criteria per task; at least one real, fast verify command per task. ${verify.length ? `These repository-wide checks also run on every task, do not repeat them: ${verify.map((v) => `\`${v}\``).join(', ')}.` : ''}
- A small change may be a single task. Use at most 10 tasks, ids T1, T2, … in dependency order.

## Plan document
\`markdown\` is what the human approves and every coder reads: ## Summary (2–5 sentences), ## Approach (key decisions and contracts), ## Tasks (one line each), ## Risks and open questions, ## Out of scope. Start it with a one-line title as a level-1 heading.`;
}
function showPlan(plan: Plan): string {
  const tasks = plan.tasks
    .map(
      (t) =>
        `- **${t.id}** ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}\n  ${t.acceptanceCriteria.map((a) => `· ${a}`).join('\n  ')}`,
    )
    .join('\n');
  return `${plan.markdown}\n\n## Task graph\n${tasks}`;
}
