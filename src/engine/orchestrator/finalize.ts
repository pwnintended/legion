/**
 * §8 steps 7–8: every task terminal → integrating (full verify on the integration worktree) →
 * finalizing (holistic review on the engine other than the coders' majority; blockers → a final fix round:
 * a coder session in the integration worktree, commit, back to integrating; out of rounds → inbox) →
 * pr_ready (inbox item with the PR text) → `runs.createPr` (push + draft PR through the `PrHost`), or
 * `runs.mergeLocally` (merge commit onto the local base branch) → done.
 */
import type { PullRequest, Review, ReviewFinding, Run } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { ReviewOutputSchema, reviewOutputJsonSchema, type TaskReport, taskReportJsonSchema } from '@shared/schemas';
import type { RunPatch } from '../db';
import { cleanWorktree, commitAll, gitText, type LegionConfig, mergeIntoBase } from '../git';
import {
  blockingFindings,
  buildFinalFixerPrompt,
  buildFinalizerPrompt,
  buildPrBody,
  finalizerEngineFor,
  maxAttempts,
  type PrText,
  reviewerEngineFor,
  TERMINAL_STATUSES,
  type VerifyResultInput,
} from './core';
import type { AgentRun } from './live-session';
import { patchRunMeta, runMeta, taskMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator } from './orchestrator';
import { releaseRepo } from './repo-gc';
import { coderModelOf, coderTurn, planSummary } from './tasks';
import { ensureIntegrationWorktree, integrationKeep, provisionIntegration, runVerification } from './worktrees';

export async function finalize(o: Orchestrator, runId: string): Promise<void> {
  let run = o.store.requireRun(runId);
  if (run.status === 'executing') {
    if (o.mergeLoops.has(runId)) return;
    const tasks = o.store.listTasks(runId);
    if (tasks.length === 0 || !tasks.every((t) => TERMINAL_STATUSES.has(t.status))) return;
    run = o.store.transitionRun(runId, 'executing', 'integrating');
  }
  if (run.paused) return;
  const config = await o.config(run);
  if (run.status === 'integrating') {
    await provisionIntegration(o, run, config);
    const integration = await ensureIntegrationWorktree(o, run);
    const commands = finalVerifyCommands(o, run, config?.verify ?? null);
    if (commands.length > 0) {
      const outcome = await runVerification(o, {
        run,
        task: null,
        attemptId: null,
        phase: 'final',
        commands,
        cwd: integration,
      });
      await cleanWorktree(integration, integrationKeep(o, run));
      if (!outcome.ok) {
        const failed = outcome.results.filter((r) => r.exitCode !== 0).map((r) => r.command);
        o.escalate(
          runId,
          null,
          'verify_failed',
          `Final verification failed on ${run.integrationBranch ?? 'the integration branch'}: ${failed.join(', ')}. Retry, skip it, or abort the run.`,
          ['retry', 'skip', 'abort'],
        );
        return;
      }
    }
    run = o.store.transitionRun(runId, 'integrating', 'finalizing');
  }
  if (run.status === 'finalizing') {
    if (runMeta(o.store, runId).finalFix) {
      // Fixed and committed → integrating: verify and review the whole change again.
      if (await finalFix(o, run, config)) await finalize(o, runId);
      return;
    }
    const review = await finalReview(o, run);
    if (!review) return;
    const blockers = review.findings.filter((f) => f.severity === 'blocker');
    if (blockers.length > 0) {
      const rounds = runMeta(o.store, runId).finalFixRounds;
      if (rounds < o.limits().maxFixRounds) {
        patchRunMeta(o.store, runId, { finalFix: finalFixContext(review, null) });
        await finalize(o, runId);
        return;
      }
      o.escalate(
        runId,
        null,
        'final_review',
        `The final review found ${blockers.length} blocker(s)${rounds > 0 ? ` after ${rounds} fix round(s)` : ''}: ${blockers.map((b) => b.title).join('; ')}. Retry runs another fix round (with your note), skip continues to the PR, abort cancels the run.`,
        ['retry', 'skip', 'abort'],
        'fix',
      );
      return;
    }
    enterPrReady(o, runId);
  }
}

/** What the final fixer gets from a final review: its blocker/major findings and unmet requirements. */
export function finalFixContext(review: Review, humanNote: string | null) {
  return {
    findings: blockingFindings(review),
    unmetCriteria: review.criteria.filter((c) => c.status !== 'met'),
    humanNote,
  };
}

/** `legion.json` verify, else every merged node's verify commands. */
function finalVerifyCommands(o: Orchestrator, run: Run, repoVerify: readonly string[] | null): string[] {
  if (repoVerify && repoVerify.length > 0) return [...repoVerify];
  const merged = new Set(
    o.store
      .listTasks(run.id)
      .filter((t) => t.status === 'merged')
      .map((t) => t.nodeId),
  );
  const commands = o
    .approvedNodes(run.id)
    .filter((n) => merged.has(n.id))
    .flatMap((n) => n.verify.commands);
  return [...new Set(commands.map((c) => c.trim()).filter(Boolean))];
}

/** The latest result of every final verify command, in run order. */
function latestFinalVerify(o: Orchestrator, runId: string): VerifyResultInput[] {
  const latest = new Map<string, VerifyResultInput>();
  for (const v of o.store.listVerifications(runId)) {
    if (v.phase !== 'final') continue;
    latest.delete(v.command);
    latest.set(v.command, {
      command: v.command,
      exitCode: v.exitCode,
      outputTail: v.outputTail,
      durationMs: v.durationMs,
    });
  }
  return [...latest.values()];
}

function latestReviewByTask(reviews: readonly Review[]): Map<string, Review> {
  const out = new Map<string, Review>();
  for (const review of reviews) if (review.taskId) out.set(review.taskId, review);
  return out;
}

async function finalReview(o: Orchestrator, run: Run): Promise<Review | null> {
  const settings = o.settings();
  const tasks = o.store.listTasks(run.id);
  const nodes = o.approvedNodes(run.id);
  const byNode = new Map(tasks.map((t) => [t.nodeId, t]));
  const merged = nodes.filter((n) => byNode.get(n.id)?.status === 'merged');
  const coders = merged.map(() => o.coderEngine());
  const engine = finalizerEngineFor(coders, o.availableEngines());
  // Same engine as (some of) the coders when the other one is unavailable: review with a different model.
  const sameEngineCoder = merged.find(() => o.coderEngine() === engine);
  const sameEngineTask = sameEngineCoder ? byNode.get(sameEngineCoder.id) : undefined;
  const model =
    sameEngineCoder && sameEngineTask
      ? o.reviewModel('finalizer', engine, engine, coderModelOf(o, sameEngineTask))
      : o.modelFor('finalizer', engine);
  const integration = await ensureIntegrationWorktree(o, run);
  const base = runMeta(o.store, run.id).baseSha ?? run.baseRef;
  const [diffStat, diff] = await Promise.all([
    gitText(integration, ['diff', '--stat', '--no-color', `${base}...HEAD`]),
    gitText(integration, ['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`]),
  ]);
  const allReviews = o.store.listReviews(run.id);
  const reviews = latestReviewByTask(allReviews);
  const previousFinal = allReviews.filter((r) => r.taskId === null).at(-1);
  const prompt = buildFinalizerPrompt({
    issue: o.issue(run),
    planMarkdown: o.approvedPlan(run.id)?.markdown ?? '',
    baseRef: run.baseRef,
    integrationRef: run.integrationBranch ?? 'HEAD',
    tasks: nodes.map((node) => {
      const task = byNode.get(node.id);
      return {
        node,
        status: task?.status ?? 'blocked',
        summary: task ? (taskMeta(o.store, task.id).report?.summary ?? null) : null,
        verdict: task ? (reviews.get(task.id)?.verdict ?? null) : null,
      };
    }),
    diffStat,
    diff,
    verify: latestFinalVerify(o, run.id),
    round: runMeta(o.store, run.id).finalFixRounds,
    previousFindings: previousFinal ? blockingFindings(previousFinal) : [],
  });

  for (let failures = 0; ; ) {
    if (o.store.requireRun(run.id).status !== 'finalizing' || o.store.requireRun(run.id).paused) return null;
    await o.waitForEngine(engine);
    let session: AgentRun | null = null;
    try {
      session = await o.openSession({
        run,
        taskId: null,
        role: 'finalizer',
        engine,
        model,
        effort: settings.roles.finalizer.effort,
        prompt,
        outputSchema: reviewOutputJsonSchema,
        cwd: integration,
        attachments: o.runAttachments(run),
      });
      const output = await o.structuredTurn(session, ReviewOutputSchema);
      await o.finishAttempt(session, 'succeeded');
      return o.store.insertReview({
        runId: run.id,
        taskId: null,
        attemptId: session.attempt.id,
        verdict: output.verdict,
        criteria: output.criteria,
        findings: output.findings,
        summary: output.summary,
      });
    } catch (error) {
      if (o.closed || error instanceof Closed) throw new Closed('closed');
      const failure =
        error instanceof AgentFailure ? error.failure : { kind: 'agent_error' as const, message: String(error) };
      if (session) await o.finishAttempt(session, 'failed', failure.message);
      if (failure.kind === 'rate_limited') {
        if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
        continue;
      }
      failures++;
      if (failure.kind === 'auth' || failures >= maxAttempts(settings.limits)) {
        o.escalate(
          run.id,
          null,
          'other',
          `The final review could not run (${failure.message}). Retry it, skip it (continue to the PR), or abort the run.`,
          ['retry', 'skip', 'abort'],
        );
        return null;
      }
    }
  }
}

/**
 * One final fix round: a coder session (coder engine, no task) in the integration worktree addresses
 * `RunMeta.finalFix`; later rounds resume the same session. Its work is committed onto the integration branch
 * and the run goes back to integrating (true). False when the run stopped, or the round escalated.
 */
async function finalFix(o: Orchestrator, run: Run, config: LegionConfig | null): Promise<boolean> {
  const meta = runMeta(o.store, run.id);
  const fix = meta.finalFix;
  if (!fix) return false;
  const settings = o.settings();
  const engine = o.coderEngine();
  const integration = await ensureIntegrationWorktree(o, run);
  const keep = integrationKeep(o, run);
  const commands = finalVerifyCommands(o, run, config?.verify ?? null);
  const round = meta.finalFixRounds + 1;
  const prompt = buildFinalFixerPrompt({
    issue: o.issue(run),
    baseRef: run.baseRef,
    integrationRef: run.integrationBranch ?? 'HEAD',
    findings: fix.findings,
    unmetCriteria: fix.unmetCriteria,
    verifyCommands: commands,
    round,
    maxRounds: Math.max(round, settings.limits.maxFixRounds),
    humanNote: fix.humanNote,
    tools: o.toolNames(engine),
    structuredReport: true,
  });
  const open = (resumeSessionId: string | null) =>
    o.openSession({
      run,
      taskId: null,
      role: 'coder',
      engine,
      model: o.modelFor('coder', engine),
      effort: settings.roles.coder.effort,
      prompt,
      outputSchema: taskReportJsonSchema,
      cwd: integration,
      allowedCommands: commands,
      resumeSessionId,
      // A fresh session sees the run's attachments with its first message (a resumed one already has them).
      attachments: resumeSessionId ? null : o.runAttachments(run),
    });

  let report: TaskReport | null = null;
  for (let failures = 0; ; ) {
    const current = o.store.requireRun(run.id);
    if (current.status !== 'finalizing' || current.paused) return false;
    await o.waitForEngine(engine);
    let session: AgentRun | null = null;
    try {
      const resume = runMeta(o.store, run.id).finalFixerSessionId;
      try {
        session = await open(resume);
      } catch (error) {
        // A session that cannot be resumed (e.g. lost transcript): start a fresh one.
        if (!resume || !(error instanceof AgentFailure) || error.failure.kind !== 'agent_error') throw error;
        o.log.warn(`run ${run.id}: could not resume the final fixer ${resume}, starting a fresh session`);
        session = await open(null);
      }
      if (session.sessionId) patchRunMeta(o.store, run.id, { finalFixerSessionId: session.sessionId });
      report = await coderTurn(o, session);
      await o.finishAttempt(session, 'succeeded');
      break;
    } catch (error) {
      if (o.closed || error instanceof Closed) throw new Closed('closed');
      const failure =
        error instanceof AgentFailure ? error.failure : { kind: 'agent_error' as const, message: String(error) };
      if (session) await o.finishAttempt(session, 'failed', failure.message);
      if (failure.kind === 'rate_limited') {
        if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
        continue;
      }
      failures++;
      if (failure.kind === 'auth' || failures >= maxAttempts(settings.limits)) {
        o.escalate(
          run.id,
          null,
          'other',
          `The final fix could not run (${failure.message}). Retry it, skip it (continue to the PR), or abort the run.`,
          ['retry', 'skip', 'abort'],
        );
        return false;
      }
    }
  }

  if (o.store.requireRun(run.id).status !== 'finalizing') return false;
  if (report?.status === 'blocked' || report === null) {
    await cleanWorktree(integration, keep);
    patchRunMeta(o.store, run.id, { finalFixRounds: round });
    const why = report ? `the fixer is blocked: ${report.summary}` : 'the fixer ended its turn without reporting';
    o.escalate(
      run.id,
      null,
      'final_review',
      `Final fix round ${round} did not finish (${why}). Retry runs another fix round (with your note), skip continues to the PR, abort cancels the run.`,
      ['retry', 'skip', 'abort'],
      'fix',
    );
    return false;
  }
  await commitAll(integration, report.commitMessage.trim() || `Address the final review (round ${round})`, keep);
  o.store.transaction(() => {
    patchRunMeta(o.store, run.id, { finalFix: null, finalFixRounds: round });
    o.store.transitionRun(run.id, 'finalizing', 'integrating');
  });
  return true;
}

/** PR title and body from the run's data (§8 step 8). */
export function prText(o: Orchestrator, run: Run): PrText {
  const enabled = o.availableEngines();
  const nodes = o.approvedNodes(run.id);
  const tasks = new Map(o.store.listTasks(run.id).map((t) => [t.nodeId, t]));
  const reviews = o.store.listReviews(run.id);
  const latest = latestReviewByTask(reviews);
  const final = reviews.filter((r) => r.taskId === null).at(-1) ?? null;
  const minor: { nodeId: string | null; finding: ReviewFinding }[] = [];
  for (const node of nodes) {
    const task = tasks.get(node.id);
    const review = task ? latest.get(task.id) : undefined;
    for (const finding of review?.findings ?? []) {
      if (finding.severity === 'minor' || finding.severity === 'nit') minor.push({ nodeId: node.id, finding });
    }
  }
  for (const finding of final?.findings ?? []) {
    if (finding.severity !== 'blocker') minor.push({ nodeId: null, finding });
  }
  const summary = [planSummary(o, run.id).trim(), final ? `**Final review:** ${final.summary}` : null]
    .filter(Boolean)
    .join('\n\n');
  const issue = /github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/.exec(run.issueUrl ?? '');
  const skipped = nodes.filter((n) => tasks.get(n.id)?.status === 'skipped').map((n) => `${n.id} (${n.title})`);
  return buildPrBody({
    runId: run.id,
    title: run.title,
    issueUrl: run.issueUrl,
    closes: issue ? `${issue[1]}#${issue[2]}` : null,
    baseRef: run.baseRef,
    integrationBranch: run.integrationBranch ?? '',
    summary,
    tasks: nodes.map((node) => {
      const task = tasks.get(node.id);
      const coder = o.coderEngine();
      return {
        nodeId: node.id,
        title: node.title,
        status: task?.status ?? 'blocked',
        coderEngine: coder,
        reviewerEngine: task && latest.has(task.id) ? reviewerEngineFor(coder, enabled) : null,
        verdict: task ? (latest.get(task.id)?.verdict ?? null) : null,
        fixRounds: task?.fixRounds ?? 0,
      };
    }),
    verification: latestFinalVerify(o, run.id),
    minorFindings: minor,
    notes: skipped.length > 0 ? [`Skipped by a human: ${skipped.join(', ')}.`] : [],
    attachments: o.attachmentRefs(run).map((a) => a.name),
  });
}

/** finalizing → pr_ready, with a `pr_ready` inbox item carrying the proposed title and body. */
export function enterPrReady(o: Orchestrator, runId: string): Run {
  const run = o.store.requireRun(runId);
  const text = prText(o, run);
  return o.store.transaction(() => {
    patchRunMeta(o.store, runId, { finalFix: null });
    const next = o.store.transitionRun(runId, 'finalizing', 'pr_ready');
    o.dismissOpen(runId, (item) => item.kind === 'pr_ready', 'superseded');
    o.store.insertInboxItem({
      runId,
      taskId: null,
      attemptId: null,
      kind: 'pr_ready',
      payload: { integrationBranch: run.integrationBranch ?? '', title: text.title, body: text.body },
    });
    return next;
  });
}

/** Runs with a `runs.createPr` / `runs.mergeLocally` in flight (archive and refresh wait for it to settle). */
export const prInFlight = new Set<string>();

/** Human PR gate (`runs.createPr` / approving the `pr_ready` item): push + draft PR → done. */
export async function createPr(
  o: Orchestrator,
  runId: string,
  title: string | null,
  body: string | null,
): Promise<{ run: Run; url: string }> {
  let url = '';
  const run = await passGate(o, runId, title, body, 'pr', async (run, text) => {
    let pr: PullRequest;
    try {
      await o.prHost.push(run.repoPath, run.integrationBranch);
      pr = await o.prHost.createDraftPr({
        repoPath: run.repoPath,
        base: run.baseRef,
        head: run.integrationBranch,
        title: text.title,
        body: text.body,
      });
    } catch (error) {
      throw new RpcError('failed_precondition', `could not create the pull request: ${(error as Error).message}`);
    }
    url = pr.url;
    return { prUrl: pr.url, pr };
  });
  return { run, url };
}

/**
 * The PR gate without a remote (`runs.mergeLocally` / approving the `pr_ready` item with `action: 'merge'`):
 * one merge commit of the integration branch onto the local base branch, titled like the PR → done.
 */
export async function mergeLocally(
  o: Orchestrator,
  runId: string,
  title: string | null,
  body: string | null,
): Promise<{ run: Run; sha: string }> {
  let sha = '';
  const run = await passGate(o, runId, title, body, 'merge', async (run, text) => {
    const message = `${text.title}\n\n${text.body}`.trim();
    try {
      sha = await mergeIntoBase(run.repoPath, run.baseRef, run.integrationBranch, `${message}\n`);
    } catch (error) {
      throw new RpcError('failed_precondition', `could not merge into ${run.baseRef}: ${(error as Error).message}`);
    }
    return { merged: { into: run.baseRef, sha, at: Date.now() } };
  });
  return { run, sha };
}

/** Runs the gate's `land` once per run, then records its patch, resolves the `pr_ready` item and finishes the run. */
async function passGate(
  o: Orchestrator,
  runId: string,
  title: string | null,
  body: string | null,
  action: 'pr' | 'merge',
  land: (run: Run & { integrationBranch: string }, text: { title: string; body: string }) => Promise<RunPatch>,
): Promise<Run> {
  const run = o.store.requireRun(runId);
  if (run.status !== 'pr_ready') throw new RpcError('conflict', `run ${runId} is ${run.status}, not pr_ready`);
  if (!run.integrationBranch) throw new RpcError('failed_precondition', 'the run has no integration branch');
  if (prInFlight.has(runId)) throw new RpcError('conflict', 'the run is already being landed');
  prInFlight.add(runId);
  try {
    const item = o.store
      .listInbox({ runId, includeResolved: false })
      .find((i): i is Extract<typeof i, { kind: 'pr_ready' }> => i.kind === 'pr_ready');
    const text = item ? item.payload : prText(o, run);
    const finalTitle = title?.trim() || text.title;
    const finalBody = body ?? text.body;
    const patch = await land(
      { ...run, integrationBranch: run.integrationBranch },
      { title: finalTitle, body: finalBody },
    );
    const done = o.store.transaction(() => {
      o.store.updateRun(runId, patch);
      if (item) {
        o.store.resolveInboxItem(item.id, {
          kind: 'pr_ready',
          approved: true,
          title: finalTitle,
          body: finalBody,
          action,
        });
      }
      return o.store.transitionRun(runId, 'pr_ready', 'done');
    });
    await releaseRepo(o, done);
    return done;
  } finally {
    prInFlight.delete(runId);
  }
}
