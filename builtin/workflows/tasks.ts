/**
 * tasks: runs a plan that was already agreed (by you and the assistant, or by a lead), without planning again.
 *
 * Every task in its own worktree, in dependency order and in parallel where possible: code → verify → review by
 * the other engine → fix rounds → squash-merge → final review of the whole → draft PR (or local merge, or the
 * branch). The planning half of `feature` is the conversation that came before.
 */
import { gate, workflow, z } from 'legion';
import { checkPlan, Engine, executePlan, type Plan } from './_tasks.ts';

const TaskInput = z.object({
  id: z.string().describe('T1, T2, …'),
  title: z.string(),
  goal: z.string().describe('2–5 sentences: what and why'),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]).describe('Paths or narrow globs the task may create or change'),
  verify: z.array(z.string()).default([]).describe('Fast, scoped commands for this task'),
  notes: z.string().default('').describe('Pitfalls, conventions, contracts; files to read first'),
  engine: Engine.nullable().default(null).describe('Engine that codes this task (default: coder)'),
});

const Input = z.object({
  title: z.string().min(1).describe('One line: what the change is (the PR title).'),
  summary: z.string().describe('The plan as markdown: summary, approach and contracts, risks, out of scope.'),
  tasks: z.array(TaskInput).min(1),
  coder: Engine.default('claude').describe('Engine that writes code; the other one reviews.'),
  finish: z.enum(['pr', 'merge', 'branch']).default('pr'),
  verify: z
    .array(z.string())
    .default([])
    .describe('Repository-wide checks, run once on the result (and on tasks without checks of their own).'),
  maxFixRounds: z.number().int().min(0).max(5).default(1),
  confirm: z.boolean().default(false).describe('Ask for approval of the plan before starting.'),
  base: z
    .string()
    .nullable()
    .default(null)
    .describe("Branch to start from and merge into (default: a lead's own branch, or the checked-out branch)."),
});

export default workflow(
  {
    name: 'tasks',
    description:
      'Run an agreed plan: its tasks in parallel worktrees with cross-engine review and fix rounds, merged, then a draft PR.',
    input: Input,
    example: {
      title: 'Add a --json flag to status',
      summary: 'Print the status as JSON when --json is passed.',
      tasks: [
        {
          id: 'T1',
          title: 'JSON output',
          goal: 'Add --json to the status command.',
          dependsOn: [],
          acceptanceCriteria: ['status --json prints valid JSON'],
          touches: [],
          verify: [],
          notes: '',
          engine: null,
        },
      ],
      coder: 'claude',
      finish: 'branch',
      verify: [],
      maxFixRounds: 1,
      confirm: false,
      base: null,
    },
  },
  async (input) => {
    const plan: Plan = {
      markdown: `# ${input.title}\n\n${input.summary}`,
      tasks: input.tasks.map(({ engine: _engine, ...task }) => task),
    };
    const problems = checkPlan(plan);
    if (problems.length > 0) throw new Error(`The plan is invalid:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    if (input.confirm) {
      const ok = await gate('approve', {
        title: 'Start on this plan?',
        show: `${plan.markdown}\n\n## Tasks\n${input.tasks.map((t) => `- **${t.id}** ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}${t.engine ? ` · ${t.engine}` : ''}`).join('\n')}`,
      });
      if (!ok.approved) return { started: false, note: ok.note };
    }
    return executePlan(plan, {
      ...input,
      engines: Object.fromEntries(input.tasks.map((t) => [t.id, t.engine])),
    });
  },
);
