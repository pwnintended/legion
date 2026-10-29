# Workflows

A workflow is a TypeScript file that tells Legion's agents what to do, in what order, and where to stop for you.
You rarely write one by hand: ask the assistant to write or change one, and it validates it for you.

## Where workflows come from

Resolution order, first match by name wins:

1. `.legion/workflows/<name>.ts` in the project (commit them)
2. `~/.config/legion/workflows/<name>.ts`
3. builtin: [`feature`](../builtin/workflows/feature.ts), [`tasks`](../builtin/workflows/tasks.ts),
   [`implement`](../builtin/workflows/implement.ts), [`review`](../builtin/workflows/review.ts), and
   [`box`](../builtin/workflows/box.ts)

## The builtin workflows

| Builtin | What it does |
|---|---|
| `feature` | Clarify, plan (you approve or ask for changes), then implement the plan's tasks in parallel worktrees in dependency order. Each task gets a review from the other engine and fix rounds, then is squash-merged into an integration branch (an agent resolves conflicts). A final review of the whole, then a draft PR (or a local merge). |
| `tasks` | The second half of `feature`, for a plan you already agreed with the assistant (or a lead): the tasks you give it, each optionally on its own engine, run the same way, through to the PR. `confirm: true` asks before starting. |
| `implement` | One focused change in a worktree: code, then cross-engine review and fix rounds, then a gate, then a draft PR or merge. |
| `review` | Both engines review your branch and uncommitted changes independently. Their findings are merged, and an agent can then fix the ones you pick. |
| `box` | The box agent (remote mode): sets up or extends the image Upstash Boxes start from. The assistant starts it when agents ask for tools (`legion-need`). |

`feature`, `tasks` and `implement` keep runs short: one fix round by default (`maxFixRounds`), each task runs its
own scoped `verify` commands, and the repository-wide checks run once on the merged result. A run of one task skips
the final review. When the base branch moved on and conflicts by the time the run merges, an agent merges it into
the integration branch first instead of failing. Leads and the assistant are told to make small changes
themselves instead of starting a workflow.

Planning prefers one cohesive task with implementation, types, wiring and tests together. `feature` enforces
`maxTasks: 3` by default (configurable from 1 to 10); this is a ceiling, not a target. Split only substantial
independent work when parallel execution pays for the additional setup and reviews. `tasks` keeps the task
list you explicitly supply.

Task reviews request fixes only for evidenced blocker or major findings, or failing configured checks.
A `request_changes` verdict with only minor/nit findings does not trigger a fix round. Suggestions remain in
the PR description. Follow-up reviews resume the reviewer, receive the coder's updated report, and focus on
unresolved findings and regressions from the fixes. The final integration review retains its blocker-only
fix threshold and checks how tasks work together.

## Writing a workflow

A workflow is a plain TypeScript module (erasable syntax only) that imports from `legion`:

```ts
import { agent, gate, git, loop, workflow, z } from 'legion';

export default workflow(
  { name: 'tidy', description: 'Refactor one module with review', input: z.object({ path: z.string() }) },
  async ({ path }) => {
    const wt = await git.worktree('tidy');
    await agent('code', { engine: 'codex', cwd: wt.path, prompt: `Simplify ${path} without changing behavior.` });
    await loop('review', { max: 3 }, async (round) => {
      const r = await agent('review', {
        engine: 'claude', mode: 'read', untrusted: true, cwd: wt.path,
        output: z.object({ ok: z.boolean(), issues: z.array(z.string()) }),
        prompt: `Review \`git diff ${wt.baseSha}\`.`,
      });
      if (r.ok) return { done: true };
      await agent('fix', { engine: 'codex', cwd: wt.path, resume: round === 1 ? 'code' : `review/${round - 1}/fix`, prompt: r.issues.join('\n') });
    });
    const ok = await gate('ship', { title: 'Open a draft PR?', show: await git.diff(wt) });
    return ok.approved ? git.pr(wt, { title: `Tidy ${path}`, body: 'Refactor, reviewed by Claude.' }) : null;
  },
);
```

The full API is in the assistant's prompt ([`src/assistant/prompt.ts`](../src/assistant/prompt.ts)) and in
[`src/workflow/runtime.ts`](../src/workflow/runtime.ts). It provides `agent`, `gate`, `ask`, `sh`, `step`,
`loop`, `group`, `parallel` and `log`, plus `git.integration`, `worktree`, `commit`, `merge`, `mergeInto`,
`finishMerge`, `diff`, `changedFiles`, `pr`, `mergeToBase` and `remove`.

**Durability.** Every primitive is a named step, journaled in `.legion/runs/<id>/journal.jsonl`. A resumed run
re-executes the workflow from the top, and finished steps return their recorded result instantly. An agent step
interrupted mid-turn resumes its own session. For this to work:

- Step keys must be unique within a run. `loop` rounds and `group` scope them (`T1/review/2/fix`).
- Code between steps must be deterministic.

**Validation.** `legion validate` (and the assistant, after every edit) does three things:

1. Type-checks the file against the SDK.
2. Loads it.
3. Dry-runs it. Fake agents answer with schema-shaped samples, gates approve, and git and the shell are
   simulated. This catches typos, broken control flow and duplicate keys before a real run spends tokens.
