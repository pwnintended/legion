/**
 * §8 steps 1–5: create run → clarify (planner, read-only) → plan (same planner session, resumed) →
 * validate → plan versions + sign-off → approval (integration branch, tasks, execution).
 */
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type InboxItem,
  type Plan,
  type PlanAnnotation,
  type PlanDag,
  type QuestionAnswer,
  REAL_ENGINE_KINDS,
  type RealEngineKind,
  type Run,
  type TaskNode,
} from '@shared/domain';
import type { JsonSchema, SessionAttachment } from '@shared/engine';
import type { RpcInput } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import {
  type ClarifyOutput,
  ClarifyOutputSchema,
  clarifyOutputJsonSchema,
  type PlanOutput,
  PlanOutputSchema,
  planOutputJsonSchema,
} from '@shared/schemas';
import type { z } from 'zod';
import { integrationBranchName, resolveSha, toplevel } from '../git';
import { inspectRepo } from '../rpc/repo-inspect';
import {
  type AgentPrompt,
  buildClarifyPrompt,
  buildPlanPrompt,
  enabledEngines,
  maxAttempts,
  noteTag,
  type PlanPromptInput,
  type ValidateOptions,
  type ValidationResult,
  validatePlan,
} from './core';
import type { AgentRun } from './live-session';
import { patchRunMeta, runMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator } from './orchestrator';
import { acquireRepo } from './repo-gc';
import { ensureIntegrationWorktree, provisionIntegration } from './worktrees';

/** Validation retries inside the planner session before the plan is stored as is (with its errors). */
const PLAN_VALIDATION_RETRIES = 2;

export function deriveTitle(issueText: string): string {
  const line =
    issueText
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? 'Untitled run';
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}

export async function validateOptions(o: Orchestrator, run: Run): Promise<ValidateOptions> {
  const config = await o.config(run);
  const settings = o.settings();
  return {
    highRiskGlobs: config?.highRiskGlobs ?? [],
    enabled: enabledEngines(settings),
    estimate: { concurrency: settings.concurrency, maxFixRounds: settings.limits.maxFixRounds },
  };
}

// -- create ----------------------------------------------------------------------------------------

export async function createRun(o: Orchestrator, input: RpcInput<'runs.create'>): Promise<Run> {
  o.assertOpen();
  const inspection = await inspectRepo(input.repoPath, o.ctx.env);
  if (!inspection.isGitRepo || !inspection.root) {
    throw new RpcError('bad_request', inspection.error ?? 'not a git repository');
  }
  if (!inspection.headSha) throw new RpcError('failed_precondition', 'the repository has no commits');
  const root = await toplevel(inspection.root);
  const baseRef = input.baseRef?.trim() || inspection.defaultBranch || inspection.currentBranch;
  if (!baseRef) throw new RpcError('bad_request', 'could not determine a base ref');
  let baseSha: string;
  try {
    baseSha = await resolveSha(root, baseRef);
  } catch {
    throw new RpcError('bad_request', `unknown base ref ${baseRef}`);
  }
  const usable = o.registry.usable(input.plannerEngine);
  if (!usable.ok) throw new RpcError('failed_precondition', usable.reason);
  const attachments = o.attachments.refs(input.attachmentIds);

  // The run belongs to the project of its checkout (added on the fly when it's new).
  const projectPath = await realpath(root).catch(() => root);
  const created = o.store.transaction(() => {
    const project = o.store.ensureProject(projectPath, basename(projectPath));
    const run = o.store.createRun({
      repoPath: root,
      projectId: project.id,
      baseRef,
      title: input.title?.trim() || deriveTitle(input.issueText),
      issueText: input.issueText,
      issueUrl: input.issueUrl,
      plannerEngine: input.plannerEngine,
      plannerModel: input.plannerModel,
      attachments,
    });
    o.attachments.claim(attachments, run.id);
    return run;
  });
  patchRunMeta(o.store, created.id, { baseSha });
  o.store.touchRecentRepo(root, basename(root));
  const run = o.store.transitionRun(created.id, 'draft', input.skipClarify ? 'planning' : 'clarifying');
  startPlanner(o, run.id);
  return run;
}

/** Start whatever planner step the run's status calls for (also used by recovery and inbox answers). */
export function startPlanner(o: Orchestrator, runId: string, revision: PlanRevision | null = null): void {
  const run = o.store.requireRun(runId);
  if (run.status === 'clarifying') o.runJob(runId, 'clarify', () => runClarify(o, runId));
  else if (run.status === 'planning') o.runJob(runId, 'plan', () => runPlan(o, runId, revision));
}

// -- planner session -------------------------------------------------------------------------------

/**
 * One planner step with the retry policy: resume the planner session (if any), wait for valid structured
 * output, then `check` (which may continue the conversation). Rate limits wait without counting; other
 * failures retry up to `1 + maxRetries` times, then the run fails. Returns null when the run failed or
 * left the expected status.
 */
async function plannerStep<T>(
  o: Orchestrator,
  runId: string,
  expected: Run['status'],
  prompt: AgentPrompt,
  jsonSchema: JsonSchema,
  schema: z.ZodType<T>,
  check: (output: T, session: AgentRun) => Promise<T> = async (output) => output,
  /** Sent with the prompt when the planner session is resumed (a fresh session gets all of the run's). */
  followUpAttachments: readonly SessionAttachment[] = [],
): Promise<T | null> {
  let failures = 0;
  for (;;) {
    const run = o.store.requireRun(runId);
    if (run.status !== expected) return null;
    const engine = run.plannerEngine;
    await o.waitForEngine(engine);
    const cwd = await ensureIntegrationWorktree(o, run);
    const meta = runMeta(o.store, runId);
    let session: AgentRun | null = null;
    try {
      session = await o.openSession({
        run,
        taskId: null,
        role: 'planner',
        engine,
        model: run.plannerModel ?? o.modelFor('planner', engine),
        effort: o.settings().roles.planner.effort,
        prompt,
        outputSchema: jsonSchema,
        cwd,
        resumeSessionId: meta.plannerSessionId,
        attachments: meta.plannerSessionId ? followUpAttachments : o.runAttachments(run),
      });
      if (session.sessionId) patchRunMeta(o.store, runId, { plannerSessionId: session.sessionId });
      const output = await check(await o.structuredTurn(session, schema), session);
      if (session.sessionId) patchRunMeta(o.store, runId, { plannerSessionId: session.sessionId });
      await o.finishAttempt(session, 'succeeded');
      return output;
    } catch (error) {
      if (o.closed || error instanceof Closed) throw new Closed('closed');
      const failure =
        error instanceof AgentFailure ? error.failure : { kind: 'agent_error' as const, message: String(error) };
      if (session) await o.finishAttempt(session, 'failed', failure.message);
      if (o.store.requireRun(runId).status !== expected) return null;
      if (failure.kind === 'rate_limited') {
        if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
        continue;
      }
      failures++;
      o.log.warn(`run ${runId}: planner failed (${failures}): ${failure.message}`);
      if (failure.kind === 'auth' || failures >= maxAttempts(o.limits())) {
        o.store.transitionRun(runId, expected, 'failed', { error: `planner failed: ${failure.message}` });
        return null;
      }
      // A session that cannot be resumed is replaced by a fresh one on the next try.
      if (failures >= 2) patchRunMeta(o.store, runId, { plannerSessionId: null });
    }
  }
}

// -- clarify ---------------------------------------------------------------------------------------

export async function runClarify(o: Orchestrator, runId: string): Promise<void> {
  const run = o.store.requireRun(runId);
  if (run.status !== 'clarifying') return;
  const config = await o.config(run);
  const prompt = buildClarifyPrompt({ issue: o.issue(run), repo: o.repoInput(run, config) });
  const output: ClarifyOutput | null = await plannerStep(
    o,
    runId,
    'clarifying',
    prompt,
    clarifyOutputJsonSchema,
    ClarifyOutputSchema,
  );
  if (!output) return;
  if (output.questions.length === 0) {
    o.store.transitionRun(runId, 'clarifying', 'planning');
    await runPlan(o, runId, null);
    return;
  }
  o.store.insertInboxItem({
    runId,
    taskId: null,
    attemptId: null,
    kind: 'question',
    payload: { source: 'clarify', questions: output.questions },
  });
}

/** Answers to the clarify questions (`runs.answerClarify`, or the `question` inbox item). */
export function answerClarify(
  o: Orchestrator,
  runId: string,
  answers: readonly QuestionAnswer[],
  resolvedItem: InboxItem | null = null,
  attachmentIds: readonly string[] | null = null,
): Run {
  const run = o.store.requireRun(runId);
  if (run.status !== 'clarifying') throw new RpcError('conflict', `run ${runId} is ${run.status}, not clarifying`);
  const item =
    resolvedItem ??
    o.store
      .listInbox({ runId, includeResolved: false })
      .find((i) => i.kind === 'question' && i.payload.source === 'clarify');
  if (item?.kind !== 'question') throw new RpcError('conflict', 'there are no open clarifying questions');
  const pairs = item.payload.questions.map((q) => ({
    question: q.question,
    answer: answers.find((a) => a.questionId === q.id)?.answer.trim() || '(no answer: use your judgement)',
  }));
  const attachments = o.attachments.refs(attachmentIds);
  const next = o.store.transaction(() => {
    if (!resolvedItem) {
      o.store.resolveInboxItem(item.id, {
        kind: 'question',
        answers: [...answers],
        ...(attachments.length ? { attachments } : {}),
      });
    }
    const meta = runMeta(o.store, runId);
    o.attachments.claim(attachments, runId);
    patchRunMeta(o.store, runId, {
      answers: [...meta.answers, ...pairs],
      answerAttachments: [...meta.answerAttachments, ...attachments],
    });
    return o.store.transitionRun(runId, 'clarifying', 'planning');
  });
  startPlanner(o, runId);
  return next;
}

// -- plan ------------------------------------------------------------------------------------------

export interface PlanRevision {
  feedback: string;
  previous: Plan;
}

export async function runPlan(o: Orchestrator, runId: string, revision: PlanRevision | null): Promise<void> {
  const run = o.store.requireRun(runId);
  if (run.status !== 'planning') return;
  const config = await o.config(run);
  const settings = o.settings();
  const enabled = enabledEngines(settings);
  const available = REAL_ENGINE_KINDS.filter((k) => enabled[k] || o.registry.isFake(k));
  const defaultCoder: RealEngineKind = settings.roles.coder.engine === 'codex' ? 'codex' : 'claude';
  const base: PlanPromptInput = {
    issue: o.issue(run),
    repo: o.repoInput(run, config),
    answers: runMeta(o.store, runId).answers,
    engines: { available, defaultCoder },
    revision: revision
      ? {
          previousMarkdown: revision.previous.markdown,
          previousNodes: revision.previous.dag.nodes,
          feedback: revision.feedback,
        }
      : null,
  };
  const options = await validateOptions(o, run);
  let validation: ValidationResult | null = null;
  const output: PlanOutput | null = await plannerStep(
    o,
    runId,
    'planning',
    buildPlanPrompt(base),
    planOutputJsonSchema,
    PlanOutputSchema,
    async (first, session) => {
      let current = first;
      for (let i = 0; ; i++) {
        validation = validatePlan({ nodes: current.dag.nodes }, options);
        if (validation.ok || i >= PLAN_VALIDATION_RETRIES) return current;
        await session.send(
          buildPlanPrompt({ ...base, validationErrors: validation.errors.map((e) => e.message) }).prompt,
        );
        current = await o.structuredTurn(session, PlanOutputSchema);
      }
    },
    // The planner session saw the run's attachments in the clarify step; the answers may add some.
    revision ? [] : o.attachments.forSession(runMeta(o.store, runId).answerAttachments),
  );
  if (!output) return;
  const result: ValidationResult = validation ?? validatePlan({ nodes: output.dag.nodes }, options);
  storePlanVersion(o, runId, {
    markdown: output.markdown,
    dag: planDagWithErrors(result, output.dag.nodes),
    source: 'agent',
    feedback: revision?.feedback ?? null,
  });
}

/** The DAG to persist: the validated one, or (with errors) the raw nodes plus the errors as notes. */
export function planDagWithErrors(result: ValidationResult, nodes: readonly TaskNode[]): PlanDag {
  if (result.ok) return result.dag;
  return {
    nodes: [...nodes],
    annotations: [
      ...result.dag.annotations,
      ...result.errors.map((e) => ({
        kind: 'note' as const,
        nodeIds: [...e.nodeIds],
        message: `[error] ${e.message}`,
      })),
    ],
  };
}

/** Insert a plan version, move the run to awaiting_approval, supersede the old sign-off item. */
export function storePlanVersion(
  o: Orchestrator,
  runId: string,
  input: { markdown: string; dag: PlanDag; source: Plan['source']; feedback: string | null },
): Plan {
  return o.store.transaction(() => {
    const plan = o.store.insertPlan({ runId, ...input });
    const run = o.store.requireRun(runId);
    if (run.status === 'planning') o.store.transitionRun(runId, 'planning', 'awaiting_approval');
    o.dismissOpen(runId, (item) => item.kind === 'plan_signoff', `superseded by plan v${plan.version}`);
    o.store.insertInboxItem({
      runId,
      taskId: null,
      attemptId: null,
      kind: 'plan_signoff',
      payload: { planId: plan.id, version: plan.version },
    });
    return plan;
  });
}

/** Node pairs whose write overlap a human accepted (`[overlap_accepted]` notes left by `undoAutoEdge`). */
export function acceptedOverlaps(annotations: readonly PlanAnnotation[]): [string, string][] {
  const out: [string, string][] = [];
  for (const a of annotations) {
    const [x, y] = a.nodeIds;
    if (x !== undefined && y !== undefined && noteTag(a) === 'overlap_accepted') out.push([x, y]);
  }
  return out;
}

function latestPlanOrConflict(o: Orchestrator, run: Run, planId: string): Plan {
  if (run.status !== 'awaiting_approval') {
    throw new RpcError('conflict', `run ${run.id} is ${run.status}, not awaiting_approval`);
  }
  const latest = o.store.latestPlan(run.id);
  if (!latest) throw new RpcError('not_found', `run ${run.id} has no plan`);
  if (latest.id !== planId) {
    throw new RpcError('conflict', `plan ${planId} is not the latest version (v${latest.version} is)`, {
      latestPlanId: latest.id,
    });
  }
  return latest;
}

function validationError(result: ValidationResult): RpcError {
  return new RpcError(
    'bad_request',
    `the plan is invalid: ${result.errors.map((e) => e.message).join(' ')}`,
    result.errors.map((e) => ({ code: e.code, message: e.message, nodeIds: e.nodeIds })),
  );
}

/**
 * Human edit (`runs.updatePlan`): validate and store a new version (source `user`). The client's
 * annotations (when sent) carry its DAG decisions: accepted overlaps (undone auto edges) stay unserialized.
 */
export async function updatePlan(o: Orchestrator, input: RpcInput<'runs.updatePlan'>): Promise<Plan> {
  const run = o.store.requireRun(input.runId);
  const base = latestPlanOrConflict(o, run, input.basePlanId);
  const annotations = input.annotations ?? base.dag.annotations;
  const options = await validateOptions(o, run);
  const result = validatePlan(
    { nodes: input.nodes, annotations },
    { ...options, acceptedOverlaps: acceptedOverlaps(annotations) },
  );
  if (!result.ok) throw validationError(result);
  return storePlanVersion(o, run.id, { markdown: input.markdown, dag: result.dag, source: 'user', feedback: null });
}

export function requestPlanRevision(o: Orchestrator, runId: string, planId: string, feedback: string): Run {
  const run = o.store.requireRun(runId);
  const previous = latestPlanOrConflict(o, run, planId);
  const next = o.store.transaction(() => {
    for (const item of o.store.listInbox({ runId, includeResolved: false })) {
      if (item.kind === 'plan_signoff') {
        o.store.resolveInboxItem(item.id, { kind: 'plan_signoff', approved: false, feedback });
      }
    }
    return o.store.transitionRun(runId, 'awaiting_approval', 'planning');
  });
  startPlanner(o, runId, { feedback, previous });
  return next;
}

/** `runs.approvePlan`: integration branch at the base sha, one task per node, execution starts. */
export async function approvePlan(o: Orchestrator, runId: string, planId: string): Promise<Run> {
  const run = o.store.requireRun(runId);
  const plan = latestPlanOrConflict(o, run, planId);
  const result = validatePlan(plan.dag, await validateOptions(o, run));
  if (!result.ok) throw validationError(result);
  try {
    await ensureIntegrationWorktree(o, run);
  } catch (error) {
    throw new RpcError('failed_precondition', `could not create the integration worktree: ${(error as Error).message}`);
  }
  await acquireRepo(o, run);
  const next = o.store.transaction(() => {
    latestPlanOrConflict(o, o.store.requireRun(runId), planId);
    o.store.approvePlan(plan.id);
    for (const node of plan.dag.nodes) o.store.insertTask({ runId, nodeId: node.id, status: 'blocked' });
    o.store.updateRun(runId, { integrationBranch: integrationBranchName(runId) });
    for (const item of o.store.listInbox({ runId, includeResolved: false })) {
      if (item.kind === 'plan_signoff') {
        o.store.resolveInboxItem(item.id, { kind: 'plan_signoff', approved: true, feedback: null });
      }
    }
    return o.store.transitionRun(runId, 'awaiting_approval', 'executing');
  });
  o.background(`provision integration ${runId}`, async () =>
    provisionIntegration(o, o.store.requireRun(runId), await o.config(run)),
  );
  o.scheduleTick();
  return next;
}
