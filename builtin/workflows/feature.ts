/**
 * feature: from a task description to a draft pull request.
 *
 * clarify → plan (human approves, or asks for changes) → integration branch → every task of the plan in its own
 * worktree, in dependency order and in parallel where possible: code → verify → review by the other engine →
 * fix rounds → squash-merge (an agent resolves conflicts) → final review of the whole → draft PR (or local merge).
 */
import { agent, ask, gate, git, group, log, loop, sh, WorkflowCancelled, type Worktree, workflow, z } from 'legion';

const Engine = z.enum(['claude', 'codex']);

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

const Task = z.object({
  id: z.string().describe('T1, T2, … in dependency order'),
  title: z.string(),
  goal: z.string().describe('2–5 sentences: what and why'),
  dependsOn: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  touches: z.array(z.string()).describe('Repo-relative paths or narrow globs the task may create or change'),
  verify: z.array(z.string()).describe('Fast, scoped commands that exist in this repository'),
  notes: z.string().describe('Pitfalls, conventions, contracts to follow; files to read first'),
});
type Task = z.infer<typeof Task>;

const Plan = z.object({
  markdown: z.string().describe('## Summary, ## Approach, ## Tasks, ## Risks, ## Out of scope'),
  tasks: z.array(Task),
});
type Plan = z.infer<typeof Plan>;

const Report = z.object({
  summary: z.string().describe('What you changed and why, for the reviewer and later tasks'),
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

const PLANNER = `You are the planner of a multi-agent coding workflow. Every task in your plan is implemented by a fresh coding agent in its own git worktree; it sees only the plan summary, its own task and summaries of the tasks it depends on. A task starts after all its dependencies were reviewed and merged into a shared integration branch; independent tasks run in parallel. Each task is verified with its commands and reviewed by a different model before it is merged.
You are read-only: explore with reading, search and read-only shell commands. Do not change files, install packages or touch the network.`;

const REVIEWER = `You are an independent code reviewer. You did not write the code under review. Approve only when it is correct and leaves the codebase no messier than it found it; be demanding and fair, and do not invent problems.
Severities: blocker = wrong behavior, broken build/tests, an acceptance criterion not met, a security hole; major = a real bug in an edge case that matters, a missing test the criteria require, a broken contract, unjustified changes outside the task, or a clear structural regression; minor = worth a follow-up; nit = style (rarely worth mentioning).
Every claim needs evidence (file and line, quoted code, or command output you saw). Give each finding a concrete suggestedFix. You are read-only: do not change files or git state; running tests and linters is fine.`;

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
    const reviewer = input.coder === 'claude' ? 'codex' : 'claude';

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
    const plan = planned.value;

    // ---- implement ----------------------------------------------------------------------------
    const integration = await git.integration();
    const results = new Map<string, Promise<TaskResult>>();
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const run = (task: Task): Promise<TaskResult> => {
      let result = results.get(task.id);
      if (!result) {
        result = (async () => {
          const upstream = await Promise.all(task.dependsOn.map((d) => run(byId.get(d) as Task)));
          return group(task.id, () => implement(task, upstream));
        })();
        results.set(task.id, result);
      }
      return result;
    };

    const implement = async (task: Task, upstream: TaskResult[]): Promise<TaskResult> => {
      const failed = upstream.find((u) => !u.merged);
      if (failed) {
        log(`${task.id} skipped: it depends on ${failed.id}, which was not merged`);
        return { id: task.id, title: task.title, summary: 'skipped', merged: false, findings: [] };
      }
      const wt = await git.worktree(task.id, { from: integration });
      const checks = [...task.verify, ...input.verify];
      const report = await agent('code', {
        engine: input.coder,
        cwd: wt.path,
        output: Report,
        allow: checks,
        label: `${task.id} code: ${task.title}`,
        prompt: coderPrompt(plan, task, upstream, checks),
      });

      let lastSession = 'code';
      let findings: Finding[] = [];
      const reviewed = await loop('review', { max: input.maxFixRounds + 1 }, async (round) => {
        const verification = await verify(checks, wt);
        const review = await agent('review', {
          engine: reviewer,
          mode: 'read',
          untrusted: true,
          cwd: wt.path,
          output: Review,
          label: `${task.id} review${round > 1 ? ` (round ${round})` : ''}`,
          system: REVIEWER,
          prompt: reviewPrompt(plan, task, wt, report.summary, verification, round > 1 ? findings : null),
        });
        findings = review.findings;
        if (approves(review) && verification.every((v) => v.ok)) return { done: true };
        if (round > input.maxFixRounds) return;
        await agent('fix', {
          engine: input.coder,
          cwd: wt.path,
          resume: lastSession,
          allow: checks,
          label: `${task.id} fix round ${round}`,
          prompt: fixPrompt(review, verification),
        });
        lastSession = `${task.id}/review/${round}/fix`;
      });

      if (!reviewed.done) {
        const choice = await ask(
          'unresolved',
          `${task.id} (${task.title}) still has blocking findings after ${input.maxFixRounds} fix rounds:\n${formatFindings(findings)}\nWhat now?`,
          {
            options: ['merge anyway', 'skip this task', 'abort the run'],
          },
        );
        if (choice === 'abort the run') throw new WorkflowCancelled(`Aborted at ${task.id}`);
        if (choice === 'skip this task')
          return { id: task.id, title: task.title, summary: report.summary, merged: false, findings };
      }

      await git.commit(wt, report.commitMessage);
      let merged = await git.merge(wt, integration, { message: `${task.id}: ${task.title}` });
      if (!merged.ok) {
        // Bring the integration branch into the task branch, let an agent resolve, then merge again.
        const sync = await git.mergeInto(wt, integration);
        if (!sync.ok) {
          await agent('resolve', {
            engine: input.coder,
            cwd: wt.path,
            label: `${task.id} resolve conflicts`,
            prompt: `Merging the integration branch into this task branch left conflicts in:\n${sync.conflicts.map((c) => `- ${c}`).join('\n')}\n\nResolve every conflict, keeping both sides' intent (the integration branch holds other tasks' reviewed work). Remove all conflict markers and make sure the checks still pass. Do not commit.`,
          });
          await git.finishMerge(wt, { message: `Merge integration into ${task.id}` });
        }
        merged = await git.merge(wt, integration, { message: `${task.id}: ${task.title}`, key: 'merge-again' });
        if (!merged.ok)
          throw new Error(`${task.id} still conflicts with the integration branch: ${merged.conflicts.join(', ')}`);
      }
      await git.remove(wt);
      return {
        id: task.id,
        title: task.title,
        summary: report.summary,
        merged: true,
        findings: findings.filter((f) => f.severity !== 'nit'),
      };
    };

    // allSettled: one failing task must not end the run while its siblings' agents are still working.
    const settled = await Promise.allSettled(plan.tasks.map(run));
    const failure = settled.find((s) => s.status === 'rejected');
    if (failure) throw failure.reason;
    const tasks = settled.map((s) => (s as PromiseFulfilledResult<TaskResult>).value);
    const mergedTasks = tasks.filter((t) => t.merged);
    if (mergedTasks.length === 0) throw new Error('No task was merged');

    // ---- final review of the whole ------------------------------------------------------------
    let remaining: Finding[] = [];
    await loop('final', { max: 2 }, async (round) => {
      const verification = await verify(input.verify, integration);
      const review = await agent('review', {
        engine: reviewer,
        mode: 'read',
        untrusted: true,
        cwd: integration.path,
        output: Review,
        system: REVIEWER,
        label: `final review${round > 1 ? ' (again)' : ''}`,
        prompt: finalPrompt(plan, mergedTasks, integration, verification),
      });
      remaining = review.findings;
      const blocking = review.findings.filter((f) => f.severity === 'blocker');
      if (blocking.length === 0 && verification.every((v) => v.ok)) return { done: true };
      if (round === 2) return;
      await agent('fix', {
        engine: input.coder,
        cwd: integration.path,
        allow: input.verify,
        label: 'final fix',
        prompt: fixPrompt(review, verification),
      });
      await git.commit(integration, 'Address final review', { key: 'commit-fix' });
    });

    // ---- finish -------------------------------------------------------------------------------
    const title = firstLine(plan.markdown) ?? input.task.slice(0, 70);
    const body = prBody(plan, tasks, remaining);
    if (input.finish === 'branch') return { branch: integration.branch, tasks: summarize(tasks) };
    const ok = await gate('ship', {
      title:
        input.finish === 'pr'
          ? `Open a draft PR for ${integration.branch}?`
          : `Merge ${integration.branch} into the base branch?`,
      show: `${body}\n\n## Diff\n\n\`\`\`diff\n${clip(await git.diff(integration), 20_000)}\n\`\`\``,
    });
    if (!ok.approved) return { branch: integration.branch, tasks: summarize(tasks), note: ok.note };
    if (input.finish === 'pr') {
      const pr = await git.pr(integration, { title, body });
      return { pr: pr.url, branch: integration.branch, tasks: summarize(tasks) };
    }
    const result = await git.mergeToBase(integration, { message: title });
    return { merged: result.sha, tasks: summarize(tasks) };
  },
);

interface TaskResult {
  id: string;
  title: string;
  summary: string;
  merged: boolean;
  findings: Finding[];
}

interface Verification {
  command: string;
  ok: boolean;
  output: string;
}

async function verify(commands: readonly string[], wt: Worktree): Promise<Verification[]> {
  const results: Verification[] = [];
  for (const [i, command] of commands.entries()) {
    const r = await sh(`verify-${i + 1}`, command, { cwd: wt.path, allowFail: true, timeoutMs: 15 * 60_000 });
    results.push({ command, ok: r.code === 0, output: clip(`${r.stdout}\n${r.stderr}`.trim(), 4000) });
  }
  return results;
}

function approves(review: Review): boolean {
  return (
    review.verdict === 'approve' && !review.findings.some((f) => f.severity === 'blocker' || f.severity === 'major')
  );
}

function checkPlan(plan: Plan): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (plan.tasks.length === 0) problems.push('the plan has no tasks');
  for (const t of plan.tasks) {
    if (!/^[A-Za-z0-9_-]+$/.test(t.id)) problems.push(`task id "${t.id}" may only contain letters, digits, - and _`);
    if (ids.has(t.id)) problems.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) if (!ids.has(d)) problems.push(`${t.id} depends on unknown task ${d}`);
  }
  // Cycles: depth-first search over dependsOn.
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      problems.push(`dependency cycle: ${[...path, id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) visit(d, [...path, id]);
    state.set(id, 'done');
  };
  for (const t of plan.tasks) visit(t.id, []);
  return problems;
}

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

function coderPrompt(plan: Plan, task: Task, upstream: TaskResult[], checks: readonly string[]): string {
  return `You are implementing one task of a larger plan, in your own git worktree. Other agents implement the other tasks in parallel.

## Plan summary
${plan.markdown}

## Your task: ${task.id} — ${task.title}
${task.goal}

Acceptance criteria:
${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Files you may change: ${task.touches.join(', ') || '(as needed)'}
Notes: ${task.notes || '(none)'}
${upstream.length ? `\n## Already merged before you started\n${upstream.map((u) => `- ${u.id} ${u.title}: ${u.summary}`).join('\n')}\n` : ''}
## Rules
- Follow the repository's conventions; stay within your task and its files; keep names and contracts the plan defines.
- Write tests with the code. Run ${checks.length ? checks.map((c) => `\`${c}\``).join(', ') : 'the relevant checks'} and make them pass.
- Do not commit, push or create branches: the workflow commits for you.
- Finish with the structured report: a summary of what you changed and a commit message.`;
}

function reviewPrompt(
  plan: Plan,
  task: Task,
  wt: Worktree,
  summary: string,
  verification: Verification[],
  previous: Finding[] | null,
): string {
  return `Review task ${task.id}: ${task.title}. The working directory is the task's branch; \`git diff ${wt.baseSha}\` shows the change (uncommitted changes included).

## Task
${task.goal}
Acceptance criteria:
${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join('\n')}
Declared files: ${task.touches.join(', ') || '(not declared)'}

## Plan summary
${clip(plan.markdown, 6000)}

## The coder's report
${summary}

## Checks
${formatVerification(verification)}
${previous ? `\n## Re-review\nThe coder was asked to fix the findings below. Drop the fixed ones, repeat (same title) the ones that are not; raise new findings only for real problems, including ones the fix introduced.\n${formatFindings(previous)}\n` : ''}
Verdict \`approve\` only when every criterion is met and there is no blocker or major finding.`;
}

function fixPrompt(review: Review, verification: Verification[]): string {
  const failing = verification.filter((v) => !v.ok);
  return `A reviewer looked at your work. Fix every blocker and major finding (minor ones where cheap), then make the checks pass. Do not commit.

## Review
${review.summary}

${formatFindings(review.findings)}
${failing.length ? `\n## Failing checks\n${formatVerification(failing)}` : ''}`;
}

function finalPrompt(plan: Plan, tasks: TaskResult[], wt: Worktree, verification: Verification[]): string {
  return `Review the combined change on the integration branch. The working directory has it checked out; \`git diff ${wt.baseSha}\` shows everything. Each task was reviewed on its own already: look for what only shows when they meet — duplicated helpers, contracts used differently, inconsistent naming or error handling, wiring that is missing, and whether the whole actually does what the plan says.

## Plan
${clip(plan.markdown, 8000)}

## Tasks
${tasks.map((t) => `- ${t.id} ${t.title}: ${t.summary}`).join('\n')}

## Checks
${formatVerification(verification)}

Only a blocker triggers another fix round; everything else goes into the pull request description.`;
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

function formatVerification(results: Verification[]): string {
  if (results.length === 0) return '(no checks configured)';
  return results
    .map((v) => `- \`${v.command}\`: ${v.ok ? 'passed' : `FAILED\n\`\`\`\n${v.output}\n\`\`\``}`)
    .join('\n');
}

function prBody(plan: Plan, tasks: TaskResult[], remaining: Finding[]): string {
  const open = [...remaining, ...tasks.flatMap((t) => t.findings)].filter((f) => f.severity !== 'nit');
  const skipped = tasks.filter((t) => !t.merged);
  return `${plan.markdown.replace(/^# .*\n+/, '')}

## Tasks
${tasks.map((t) => `- ${t.merged ? '✅' : '⏭️'} ${t.id} ${t.title}`).join('\n')}
${skipped.length ? `\nNot merged: ${skipped.map((t) => t.id).join(', ')}\n` : ''}${open.length ? `\n## Open review findings\n${formatFindings(open)}\n` : ''}
---
Made with Legion.`;
}

function summarize(tasks: TaskResult[]) {
  return tasks.map((t) => ({ id: t.id, title: t.title, merged: t.merged }));
}

function firstLine(markdown: string): string | null {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() ?? null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
