/**
 * The per-task driver (§8 step 6): provision → code → commit → verify + scope check → cross-engine
 * review → approve / fix round (resumed coder session) / escalate. It runs the task from its current
 * status until it reaches a status that waits for something else (merge queue, human, retry slot), so it
 * is re-entrant: recovery and resume simply start it again.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Run, Task, TaskNode } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import type { ReviewOutput, TaskReport } from '@shared/schemas';
import { ReviewOutputSchema, reviewOutputJsonSchema, TaskReportSchema, taskReportJsonSchema } from '@shared/schemas';
import {
  abortMerge,
  changedFiles,
  cleanWorktree,
  commitAll,
  createWorktree,
  git,
  gitText,
  LOCKFILES,
  mergeIntoTaskBranch,
  provisionFiles,
  removeWorktree,
  taskBranchName,
  touchedPaths,
  untrackedFiles,
} from '../git';
import {
  type AgentPrompt,
  blockingFindings,
  buildCoderPrompt,
  buildFixerPrompt,
  buildReviewerPrompt,
  checkScope,
  coderEngineFor,
  decideAfterCoderTurn,
  decideAfterFailure,
  decideAfterReview,
  decideAfterVerify,
  type Failure,
  markdownSection,
  PLAN_FILE,
  packageScriptsChanged,
  planDocument,
  reviewerEngineFor,
  sensitivePaths,
  type TaskDecision,
  taskStatusPath,
  type UpstreamSummary,
} from './core';
import type { AgentRun } from './live-session';
import { type FixContext, patchTaskMeta, taskMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator } from './orchestrator';
import { confirmedIntegrationSha, runVerification, taskDiffBase, verifyCommands } from './worktrees';

type Step = 'next' | 'park';

/** Reviewer sessions in a row that may fail to produce a review before the task escalates. */
const MAX_REVIEW_FAILURES = 3;

export const RESUME_PROMPT =
  'Legion was restarted while you were working on this task. Your previous turn was cut off. Look at the current state of the working directory, continue the task from there, and finish exactly as instructed (run the verify commands, call mark_task_done, end with the task report).';

const NUDGE_REPORT =
  'You ended your turn without the final task report. If the task is complete, call mark_task_done and end with the structured task report. Otherwise end with the task report with status `partial` or `blocked` and explain why in the summary.';

export async function driveTask(o: Orchestrator, taskId: string): Promise<void> {
  try {
    for (;;) {
      o.assertOpen();
      const task = o.store.requireTask(taskId);
      const run = o.store.requireRun(task.runId);
      if (run.status !== 'executing') return;
      let step: Step;
      switch (task.status) {
        case 'provisioning':
          step = await provision(o, run, task);
          break;
        case 'running':
          step = await code(o, run, task, 'coder');
          break;
        case 'fixing':
          step = await code(o, run, task, 'fixer');
          break;
        case 'verifying':
          step = await verify(o, run, task);
          break;
        case 'reviewing':
          step = await review(o, run, task);
          break;
        default:
          return;
      }
      if (step === 'park') return;
    }
  } catch (error) {
    if (o.closed || error instanceof Closed) return;
    const task = o.store.getTask(taskId);
    // A human moved the task or the run (cancel, skip, requestChanges) while this step ran: nothing to do.
    const run = task ? o.store.getRun(task.runId) : null;
    if (run?.status !== 'executing' || (error instanceof RpcError && error.code === 'conflict')) {
      o.log.warn(`task ${taskId}: step abandoned (${(error as Error).message})`);
      return;
    }
    o.log.error(`task ${taskId}: driver failed`, error);
    const path = task ? taskStatusPath(task.status, 'failed') : null;
    if (!task || !path || path.length === 0) return;
    o.applyDecision(taskId, {
      action: 'fail',
      path,
      patch: {},
      escalation: 'other',
      reason: `internal error: ${(error as Error).message}`,
    });
  }
}

function park(o: Orchestrator, task: Task, reason: NonNullable<ReturnType<Orchestrator['gate']>>): Step {
  o.parked.set(task.id, reason);
  return 'park';
}

function failureOf(error: unknown): Failure {
  return error instanceof AgentFailure ? error.failure : { kind: 'agent_error', message: (error as Error).message };
}

function checkOpen(o: Orchestrator, error: unknown): void {
  if (o.closed || error instanceof Closed) throw new Closed('closed');
}

// -- context ---------------------------------------------------------------------------------------

export function planSummary(o: Orchestrator, runId: string): string {
  const plan = o.approvedPlan(runId);
  if (!plan) return '';
  return markdownSection(plan.markdown, 'Summary') ?? plan.markdown;
}

/**
 * Write the whole approved plan into the task's worktree (`PLAN_FILE`). Its folder ignores itself
 * (`.legion/.gitignore` = `*`), so git never lists, stages or cleans it and it is never committed. Refreshed
 * before every coder session and after every plan change.
 */
export async function writePlanFile(o: Orchestrator, task: Task, worktree: string): Promise<string | null> {
  const plan = o.approvedPlan(task.runId);
  if (!plan) return null;
  const path = join(worktree, PLAN_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(join(dirname(path), '.gitignore'), '*\n');
  await writeFile(path, planDocument({ version: plan.version, markdown: plan.markdown, nodes: plan.dag.nodes }));
  return PLAN_FILE;
}

/** After a plan change: refresh the plan file of every task whose worktree has one (coders mid-work included). */
export async function refreshPlanFiles(o: Orchestrator, runId: string): Promise<void> {
  for (const task of o.store.listTasks(runId)) {
    if (!task.worktreePath || !existsSync(join(task.worktreePath, PLAN_FILE))) continue;
    await writePlanFile(o, task, task.worktreePath).catch((error: unknown) => {
      o.log.warn(`task ${task.id}: could not refresh the plan file: ${(error as Error).message}`);
    });
  }
}

export function upstreamOf(o: Orchestrator, task: Task, node: TaskNode): UpstreamSummary[] {
  const nodes = new Map(o.approvedNodes(task.runId).map((n) => [n.id, n]));
  const tasks = new Map(o.store.listTasks(task.runId).map((t) => [t.nodeId, t]));
  return node.dependsOn.map((id) => {
    const dep = tasks.get(id);
    const meta = dep ? taskMeta(o.store, dep.id) : null;
    return {
      nodeId: id,
      title: nodes.get(id)?.title ?? id,
      summary: meta?.report?.summary ?? (dep?.status === 'skipped' ? '(skipped by a human)' : '(no summary)'),
      files: meta?.files ?? [],
    };
  });
}

/**
 * 1-based number of this fresh coder attempt over the task's whole life (`attemptCount` restarts at 0
 * after a human retry; the prompt should still say it is a retry and carry the failure / note).
 */
function attemptNumber(o: Orchestrator, task: Task): number {
  const sessions = new Set(
    o.store
      .listAttempts(task.runId)
      .filter((a) => a.taskId === task.id && a.role === 'coder' && a.sessionId !== null)
      .map((a) => a.sessionId),
  );
  const current = taskMeta(o.store, task.id).coderSessionId;
  return Math.max(1, task.attemptCount, sessions.size + (current && sessions.has(current) ? 0 : 1));
}

/** The model the task's coder actually ran (latest coder attempt), else the configured one. */
export function coderModelOf(o: Orchestrator, task: Task, node: TaskNode): string | null {
  const attempt = o.store
    .listAttempts(task.runId)
    .filter((a) => a.taskId === task.id && a.role === 'coder')
    .at(-1);
  return attempt?.model ?? task.modelOverride ?? node.agent.model ?? null;
}

function lastCoderAttemptId(o: Orchestrator, task: Task): string | null {
  return (
    o.store
      .listAttempts(task.runId)
      .filter((a) => a.taskId === task.id && a.role === 'coder')
      .at(-1)?.id ?? null
  );
}

// -- provision -------------------------------------------------------------------------------------

async function provision(o: Orchestrator, run: Run, task: Task): Promise<Step> {
  const node = o.nodeOf(task);
  const path = o.taskPath(run, task.id);
  const branch = taskBranchName(run.id, node.id, node.title);
  try {
    const startSha = await confirmedIntegrationSha(o, run);
    await removeWorktree({ repo: run.repoPath, path });
    await createWorktree({ repo: run.repoPath, path, branch, startSha, resetBranch: true });
    o.assertOpen();
    o.store.updateTask(task.id, { branch, worktreePath: path, startSha });
    const config = await o.config(run);
    if (config) await provisionFiles(run.repoPath, path, config);
    const setup = config?.setup ?? [];
    if (setup.length > 0) {
      const outcome = await runVerification(o, {
        run,
        task,
        attemptId: null,
        phase: 'setup',
        commands: setup,
        cwd: path,
      });
      if (!outcome.ok) throw new Error(`setup failed: ${outcome.results.at(-1)?.command ?? ''}`);
    }
    // Copies and setup output are Legion's, not the agent's work: never committed, kept when cleaning.
    patchTaskMeta(o.store, task.id, { provisioned: await untrackedFiles(path) });
    o.store.transitionTask(task.id, 'provisioning', 'running');
    return 'next';
  } catch (error) {
    checkOpen(o, error);
    const current = o.store.requireTask(task.id);
    o.applyDecision(
      task.id,
      decideAfterFailure(current, { kind: 'provision_failed', message: (error as Error).message }, o.limits()),
    );
    return 'next';
  }
}

// -- code / fix ------------------------------------------------------------------------------------

/** Wait for the coder's turn and extract its report (structured output, else `mark_task_done`). */
export async function coderTurn(o: Orchestrator, session: AgentRun): Promise<TaskReport | null> {
  for (let nudged = false; ; nudged = true) {
    const turn = await session.nextTurn();
    o.assertOpen();
    const failure = o.turnFailure(turn);
    if (failure) throw new AgentFailure(failure);
    const parsed = TaskReportSchema.safeParse(turn.kind === 'turn' ? turn.structuredOutput : null);
    if (parsed.success) return parsed.data;
    if (session.markDone) {
      return {
        status: 'done',
        summary: session.markDone.summary,
        commitMessage: session.markDone.commitMessage,
        criteria: [],
        notes: null,
      };
    }
    if (nudged) return null;
    await session.send(NUDGE_REPORT);
  }
}

async function code(o: Orchestrator, run: Run, task: Task, mode: 'coder' | 'fixer'): Promise<Step> {
  const node = o.nodeOf(task);
  const engine = coderEngineFor(node, task);
  const gate = o.gate(run.id, engine);
  if (gate) return park(o, task, gate);
  const worktree = task.worktreePath;
  if (!worktree) {
    o.applyDecision(
      task.id,
      decideAfterFailure(task, { kind: 'provision_failed', message: 'no worktree' }, o.limits()),
    );
    return 'next';
  }
  const settings = o.settings();
  const limits = settings.limits;
  const config = await o.config(run);
  const planFile = await writePlanFile(o, task, worktree).catch((error: unknown) => {
    o.log.warn(`task ${task.id}: could not write the plan file: ${(error as Error).message}`);
    return null;
  });
  const meta = taskMeta(o.store, task.id);
  const tools = o.toolNames(engine);
  const leadAttemptId = o.leadAttemptId(run.id);
  const interrupted = o.store
    .listAttempts(run.id)
    .find(
      (a) =>
        a.taskId === task.id &&
        a.role === 'coder' &&
        a.status === 'interrupted' &&
        a.sessionId !== null &&
        a.sessionId === meta.coderSessionId,
    );

  let prompt: AgentPrompt;
  let resume: string | null = null;
  if (mode === 'fixer') {
    const fix: FixContext = meta.fix ?? {
      findings: [],
      unmetCriteria: [],
      failedVerify: [],
      humanNote: null,
      mergedIntegrationRef: null,
    };
    let mergedRef: string | null = null;
    if (fix.mergedIntegrationRef) {
      // Post-merge failure: bring the other tasks' merged work into this branch first.
      const merged = await mergeIntoTaskBranch(worktree, fix.mergedIntegrationRef, meta.provisioned).catch(() => null);
      if (merged?.status === 'conflict') await abortMerge(worktree);
      else if (merged) mergedRef = fix.mergedIntegrationRef;
      patchTaskMeta(o.store, task.id, { fix: { ...fix, mergedIntegrationRef: null } });
    }
    prompt = buildFixerPrompt({
      node,
      findings: fix.findings,
      unmetCriteria: fix.unmetCriteria,
      failedVerify: fix.failedVerify,
      round: Math.max(1, task.fixRounds),
      maxRounds: limits.maxFixRounds,
      mergedIntegrationRef: mergedRef,
      humanNote: fix.humanNote,
      tools,
      structuredReport: true,
    });
    resume = meta.coderSessionId;
  } else {
    const full = buildCoderPrompt({
      issue: o.issue(run),
      repo: o.repoInput(run, config),
      node,
      planSummary: planSummary(o, run.id),
      planFile,
      upstream: upstreamOf(o, task, node),
      attempt: attemptNumber(o, task),
      previousFailure: meta.previousFailure,
      tools,
      structuredReport: true,
      lead: leadAttemptId !== null,
    });
    if (interrupted) {
      resume = meta.coderSessionId;
      prompt = { systemPrompt: full.systemPrompt, prompt: RESUME_PROMPT };
    } else {
      prompt = full;
    }
  }

  const open = (resumeSessionId: string | null, reuseAttemptId: string | null, p: AgentPrompt) =>
    o.openSession({
      run,
      taskId: task.id,
      role: 'coder',
      engine,
      model: task.modelOverride ?? node.agent.model ?? o.modelFor('coder', engine),
      effort: task.effortOverride ?? node.agent.effort ?? settings.roles.coder.effort,
      prompt: p,
      outputSchema: taskReportJsonSchema,
      cwd: worktree,
      allowedCommands: verifyCommands(node, config),
      resumeSessionId,
      reuseAttemptId,
      // A fresh coder session sees the run's attachments with its first message (resumes already have them).
      attachments: resumeSessionId ? null : o.runAttachments(run),
      parentAttemptId: leadAttemptId,
    });

  let session: AgentRun | null = null;
  let report: TaskReport | null;
  try {
    try {
      session = await open(resume, interrupted?.id ?? null, prompt);
    } catch (error) {
      // A session that cannot be resumed (e.g. lost transcript): start a fresh one with the full prompt.
      if (!resume || !(error instanceof AgentFailure) || error.failure.kind !== 'agent_error') throw error;
      o.log.warn(`task ${task.id}: could not resume ${resume}, starting a fresh session`);
      const fresh =
        mode === 'coder'
          ? buildCoderPrompt({
              issue: o.issue(run),
              repo: o.repoInput(run, config),
              node,
              planSummary: planSummary(o, run.id),
              upstream: upstreamOf(o, task, node),
              attempt: attemptNumber(o, task),
              previousFailure: meta.previousFailure,
              tools,
              structuredReport: true,
              lead: leadAttemptId !== null,
            })
          : prompt;
      session = await open(null, null, fresh);
    }
    if (session.sessionId) patchTaskMeta(o.store, task.id, { coderSessionId: session.sessionId });
    report = await coderTurn(o, session);
    await o.finishAttempt(session, 'succeeded');
  } catch (error) {
    checkOpen(o, error);
    const failure = failureOf(error);
    if (session) await o.finishAttempt(session, 'failed', failure.message);
    if (failure.kind === 'rate_limited' && o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
    o.applyDecision(task.id, decideAfterFailure(o.store.requireTask(task.id), failure, limits));
    return 'next';
  }

  if (report) {
    patchTaskMeta(o.store, task.id, {
      report: { status: report.status, summary: report.summary, commitMessage: report.commitMessage },
    });
    o.store.updateTask(task.id, { report: { summary: report.summary, commitMessage: report.commitMessage } });
  }
  if (report?.status === 'done') {
    await commitAll(worktree, report.commitMessage.trim() || `${node.id}: ${node.title}`, meta.provisioned);
  }
  o.assertOpen();
  const current = o.store.requireTask(task.id);
  const base = await taskDiffBase(run, current, worktree);
  const changed = base ? await changedFiles(worktree, base, 'HEAD') : [];
  patchTaskMeta(o.store, task.id, { files: touchedPaths(changed) });
  const decision = decideAfterCoderTurn(
    current,
    { report: report ? { status: report.status } : null, changedFiles: changed.length },
    limits,
  );
  o.applyDecision(task.id, decision, {
    ...(report?.status === 'blocked' ? { summary: `the agent is blocked: ${report.summary}` } : {}),
  });
  return 'next';
}

// -- verify ----------------------------------------------------------------------------------------

async function verify(o: Orchestrator, run: Run, task: Task): Promise<Step> {
  const node = o.nodeOf(task);
  const worktree = task.worktreePath as string;
  const config = await o.config(run);
  const outcome = await runVerification(o, {
    run,
    task,
    attemptId: lastCoderAttemptId(o, task),
    phase: 'task',
    commands: verifyCommands(node, config),
    cwd: worktree,
  });
  // The agent's work is committed; anything else in the tree now is verify output (stamps, coverage,
  // formatter rewrites). Discard it so a later commit never sweeps it into the task.
  await cleanWorktree(worktree, taskMeta(o.store, task.id).provisioned);
  const base = await taskDiffBase(run, task, worktree);
  const changed = base ? touchedPaths(await changedFiles(worktree, base, 'HEAD')) : [];
  const alwaysAllowed = config?.installCommand ? LOCKFILES.map((l) => `**/${l.file}`) : [];
  const scope = checkScope(node, changed, alwaysAllowed);
  const sensitive = base ? await sensitiveChanges(worktree, base, changed) : [];
  patchTaskMeta(o.store, task.id, { lastVerify: outcome.results, scope, sensitive });
  const current = o.store.requireTask(task.id);
  const decision = decideAfterVerify(current, outcome.ok, o.limits());
  const failed = outcome.results.filter((r) => r.exitCode !== 0);
  if (decision.action === 'fix' || decision.resume === 'fix') {
    patchTaskMeta(o.store, task.id, {
      fix: { findings: [], unmetCriteria: [], failedVerify: failed, humanNote: null, mergedIntegrationRef: null },
    });
  }
  o.applyDecision(task.id, decision, {
    ...(decision.escalation
      ? { summary: `verification keeps failing: ${failed.map((f) => f.command).join(', ')}` }
      : {}),
  });
  return 'next';
}

/** Sensitive paths among `changed`, plus every `package.json` whose `scripts` changed since `base`. */
async function sensitiveChanges(worktree: string, base: string, changed: readonly string[]): Promise<string[]> {
  const out = sensitivePaths(changed);
  const show = (rev: string, path: string) =>
    git(worktree, ['show', `${rev}:${path}`], { okExitCodes: [0, 128] }).then((r) =>
      r.exitCode === 0 ? r.stdout : null,
    );
  for (const path of changed) {
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    if (packageScriptsChanged(await show(base, path), await show('HEAD', path))) out.push(`${path} (scripts)`);
  }
  return out;
}

// -- review ----------------------------------------------------------------------------------------

async function review(o: Orchestrator, run: Run, task: Task): Promise<Step> {
  const node = o.nodeOf(task);
  const settings = o.settings();
  const coderEngine = coderEngineFor(node, task);
  const engine = reviewerEngineFor(coderEngine, o.availableEngines());
  const gate = o.gate(run.id, engine);
  if (gate) return park(o, task, gate);
  const worktree = task.worktreePath as string;
  const startSha = (await taskDiffBase(run, task, worktree)) as string;
  const meta = taskMeta(o.store, task.id);
  const reviews = new Map(o.store.listReviews(run.id).map((r) => [r.id, r]));
  const previous = meta.reviewIds.length > 0 ? reviews.get(meta.reviewIds.at(-1) as string) : undefined;
  const previousFindings = previous ? blockingFindings(previous) : [];
  const diff = await gitText(worktree, ['diff', '--no-color', '--no-ext-diff', startSha, 'HEAD']);
  const config = await o.config(run);
  const prompt = buildReviewerPrompt({
    issue: o.issue(run),
    node,
    planSummary: planSummary(o, run.id),
    upstream: upstreamOf(o, task, node),
    diff,
    startSha,
    verify: meta.lastVerify,
    scope: meta.scope ?? checkScope(node, []),
    coderSummary: meta.report?.summary ?? null,
    round: task.fixRounds,
    previousFindings,
  });

  let session: AgentRun | null = null;
  let output: ReviewOutput;
  try {
    session = await o.openSession({
      run,
      taskId: task.id,
      role: 'reviewer',
      engine,
      model: o.reviewModel('reviewer', engine, coderEngine, coderModelOf(o, task, node)),
      effort: settings.roles.reviewer.effort,
      prompt,
      outputSchema: reviewOutputJsonSchema,
      cwd: worktree,
      attachments: o.runAttachments(run),
      // Under the lead (when the run has one), beside the coder it reviews: the lead sees it and can brief it.
      parentAttemptId: o.leadAttemptId(run.id),
    });
    output = await o.structuredTurn(session, ReviewOutputSchema);
    await o.finishAttempt(session, 'succeeded');
  } catch (error) {
    checkOpen(o, error);
    const failure = failureOf(error);
    if (session) await o.finishAttempt(session, 'failed', failure.message);
    if (failure.kind === 'rate_limited') {
      if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
      return park(o, task, { kind: 'rate', engine });
    }
    const failures = meta.reviewFailures + 1;
    patchTaskMeta(o.store, task.id, { reviewFailures: failures });
    if (failure.kind !== 'auth' && failures < MAX_REVIEW_FAILURES) return 'next';
    const escalation: TaskDecision = {
      action: 'escalate',
      path: taskStatusPath(task.status, 'awaiting_human') ?? [],
      patch: {},
      escalation: 'other',
      reason: `the ${engine} reviewer failed ${failures} time(s): ${failure.message}`,
      resume: 'review',
    };
    o.applyDecision(task.id, escalation);
    return 'next';
  }

  const stored = o.store.insertReview({
    runId: run.id,
    taskId: task.id,
    attemptId: session.attempt.id,
    verdict: output.verdict,
    criteria: output.criteria,
    findings: output.findings,
    summary: output.summary,
  });
  patchTaskMeta(o.store, task.id, { reviewIds: [...meta.reviewIds, stored.id], reviewFailures: 0 });
  const current = o.store.requireTask(task.id);
  const decision = decideAfterReview(
    current,
    output,
    { node, highRiskGlobs: config?.highRiskGlobs ?? [], previousFindings, sensitiveChanges: meta.sensitive },
    o.limits(),
  );
  if (decision.action === 'fix' || decision.resume === 'fix') {
    patchTaskMeta(o.store, task.id, {
      fix: {
        findings: blockingFindings(output),
        unmetCriteria: output.criteria.filter((c) => c.status !== 'met'),
        failedVerify: [],
        humanNote: null,
        mergedIntegrationRef: null,
      },
    });
  }
  o.applyDecision(task.id, decision, {
    ...(decision.escalation ? { summary: `${decision.reason}. Reviewer: ${output.summary}` } : {}),
  });
  if (decision.action === 'approve' && decision.path.includes('awaiting_human')) {
    const why =
      meta.sensitive.length > 0
        ? `changes agent/CI/hook configuration or package scripts (${meta.sensitive.join(', ')})`
        : 'is high risk';
    o.escalate(
      run.id,
      task.id,
      'other',
      `${node.id} (${node.title}) ${why} and passed review. Approve the merge, or request changes for its coder.`,
      ['skip', 'abort'],
      'merge',
    );
  }
  return 'next';
}
