/**
 * The serialized merge queue (§8 step 6): one task at a time per run. `merge-tree` forecast → squash-merge
 * into the integration worktree (pre-merge sha recorded first) → post-merge verify → merged, or reset to
 * the pre-merge sha and send the task back to fixing. Conflicts: merge integration into the task branch,
 * take integration's side of lockfiles (then re-run the install command), resolver session for the rest,
 * `finishMerge`; after `maxResolverAttempts` failures → `conflict` inbox item.
 */
import { join } from 'node:path';
import type { Run, Task, TaskNode } from '@shared/domain';
import { taskReportJsonSchema } from '@shared/schemas';
import {
  abortMerge,
  changedFiles,
  cleanWorktree,
  commitPaths,
  finishMerge,
  forecastMerge,
  gitText,
  headSha,
  installCommand,
  integrationBranchName,
  isLockfilePath,
  isMergeInProgress,
  type LegionConfig,
  lockfileCommand,
  mergeIntoTaskBranch,
  resetIntegration,
  resolveLockfileConflicts,
  squashMergeIntoIntegration,
  touchedPaths,
} from '../git';
import {
  buildResolverPrompt,
  coderEngineFor,
  decideAfterMerge,
  globMatchesPath,
  taskStatusPath,
  writeGlobs,
} from './core';
import type { AgentRun } from './live-session';
import { patchTaskMeta, taskMeta } from './meta';
import { AgentFailure, Closed, type Orchestrator, type ParkReason } from './orchestrator';
import { coderTurn } from './tasks';
import {
  ensureIntegrationWorktree,
  ensureWorktree,
  integrationKeep,
  provisionIntegration,
  runVerification,
  verifyCommands,
} from './worktrees';

type Outcome = 'done' | 'park' | 'resolved';

export async function mergeQueue(o: Orchestrator, runId: string): Promise<void> {
  for (;;) {
    o.assertOpen();
    const run = o.store.requireRun(runId);
    if (run.status !== 'executing') return;
    const tasks = o.store.listTasks(runId);
    const next =
      tasks.find((t) => t.status === 'merging') ??
      tasks.filter((t) => t.status === 'approved').sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!next) return;
    let task = next;
    if (next.status === 'approved') {
      try {
        task = o.store.transitionTask(next.id, 'approved', 'merging');
      } catch {
        continue; // a human moved it meanwhile (requestChanges / skip)
      }
    }
    let outcome: Outcome;
    try {
      outcome = await mergeTask(o, run, task);
    } catch (error) {
      if (o.closed || error instanceof Closed) throw new Closed('closed');
      o.log.error(`merge of task ${task.id} failed`, error);
      const current = o.store.requireTask(task.id);
      if (current.status !== 'merging' || o.store.requireRun(runId).status !== 'executing') continue;
      o.applyDecision(task.id, {
        action: 'escalate',
        path: taskStatusPath('merging', 'awaiting_human') ?? [],
        patch: {},
        escalation: 'other',
        reason: `merging failed: ${(error as Error).message}`,
        resume: 'merge',
      });
      outcome = 'done';
    }
    if (outcome === 'park') return;
  }
}

async function mergeTask(o: Orchestrator, run: Run, task: Task): Promise<Outcome> {
  const node = o.nodeOf(task);
  const config = await o.config(run);
  await provisionIntegration(o, run, config);
  const integration = await ensureIntegrationWorktree(o, run);
  const branch = task.branch;
  if (!branch) throw new Error(`task ${task.nodeId} has no branch`);
  const message = `${node.id}: ${node.title}`;
  const keep = integrationKeep(o, run);
  // A merge left pending by an earlier failure must be settled before anything is merged on top of it.
  await settlePendingMerges(o, run, integration);
  for (;;) {
    o.assertOpen();
    if (o.store.requireRun(run.id).status !== 'executing') return 'park';
    const preSha = await headSha(integration);
    const forecast = await forecastMerge(run.repoPath, preSha, branch);
    if (!forecast.clean) {
      const outcome = await resolveConflicts(o, run, node, task.id, config);
      if (outcome === 'resolved') continue;
      return outcome;
    }
    const merge = o.store.insertMerge({ runId: run.id, taskId: task.id, preSha });
    let result: Awaited<ReturnType<typeof squashMergeIntoIntegration>>;
    try {
      // Legion owns the integration worktree: leftovers of its own setup/verify commands are discarded.
      result = await squashMergeIntoIntegration(integration, branch, message, { cleanFirst: keep });
    } catch (error) {
      o.store.finishMerge(merge.id, 'conflict', { error: (error as Error).message });
      throw error;
    }
    if (!result.ok) {
      o.store.finishMerge(merge.id, 'conflict', { error: `conflicts in ${result.files.join(', ')}` });
      const outcome = await resolveConflicts(o, run, node, task.id, config);
      if (outcome === 'resolved') continue;
      return outcome;
    }

    if (!result.empty) o.store.recordMergeCommit(merge.id, result.mergedSha);
    // An empty re-merge after an unfinished earlier merge of this task means its content may already be in
    // integration without ever having passed verification: verify it anyway.
    const earlier = o.store
      .listMerges(run.id)
      .some((m) => m.taskId === task.id && m.id !== merge.id && m.status !== 'conflict');
    let failed: Awaited<ReturnType<typeof runVerification>>['results'] = [];
    try {
      if (!result.empty || earlier) {
        const changed = touchedPaths(await changedFiles(integration, preSha, result.mergedSha));
        const install = changed.some(isLockfilePath) ? await installCommand(integration, config) : null;
        const commands = [...(install ? [install] : []), ...verifyCommands(node, config)];
        const outcome = await runVerification(o, {
          run,
          task,
          attemptId: null,
          phase: 'post_merge',
          commands,
          cwd: integration,
        });
        failed = outcome.ok ? [] : outcome.results.filter((r) => r.exitCode !== 0);
        // Whatever the verify commands wrote must not wedge the next merge.
        if (failed.length === 0) await cleanWorktree(integration, keep);
      }
      o.assertOpen();
    } catch (error) {
      // Shutdown: the row stays pending and recovery rolls it back. Anything else: undo the squash now and
      // close the row, so nothing unverified stays on integration while the run goes on.
      if (o.closed || error instanceof Closed) throw error;
      await resetIntegration(integration, preSha, keep);
      o.store.finishMerge(merge.id, 'reverted', {
        error: `merge aborted (${(error as Error).message}); integration reset to the pre-merge sha`,
      });
      throw error;
    }
    const current = o.store.requireTask(task.id);
    const meta = taskMeta(o.store, task.id);
    if (failed.length === 0) {
      o.store.transaction(() => {
        o.store.finishMerge(merge.id, 'merged', { postSha: result.mergedSha });
        o.applyDecision(task.id, decideAfterMerge(current, 'merged', meta.resolverAttempts, o.limits()), {
          patch: { mergedSha: result.mergedSha },
        });
        patchTaskMeta(o.store, task.id, { resolverAttempts: 0, resolverFailure: null });
      });
      return 'done';
    }
    // The row stays pending until integration is back at preSha: a crash in between is rolled back by recovery.
    await resetIntegration(integration, preSha, keep);
    o.store.transaction(() => {
      o.store.finishMerge(merge.id, 'verify_failed', {
        postSha: result.mergedSha,
        error: `post-merge verification failed: ${failed.map((f) => f.command).join(', ')}`,
      });
      o.store.revertMerge(merge.id, 'post-merge verification failed; integration reset to the pre-merge sha');
    });
    const decision = decideAfterMerge(current, 'verify_failed', meta.resolverAttempts, o.limits());
    if (decision.action === 'fix' || decision.resume === 'fix') {
      patchTaskMeta(o.store, task.id, {
        fix: {
          findings: [],
          unmetCriteria: [],
          failedVerify: failed,
          humanNote: null,
          mergedIntegrationRef: integrationBranchName(run.id),
        },
      });
    }
    o.applyDecision(task.id, decision, {
      ...(decision.escalation ? { summary: `post-merge verification keeps failing for ${node.id}` } : {}),
    });
    return 'done';
  }
}

/**
 * Close the run's `pending` merge rows (a crash, or a failed rollback, cut them off). Only the newest one can
 * still be integration's HEAD: it is rolled back to its pre-merge sha when HEAD is its squash commit (the
 * recorded `postSha`, or a commit whose parent is `preSha`) and no later merge was completed on top of it.
 * Everything else is closed without touching git, so a later merge is never reset away.
 */
export async function settlePendingMerges(o: Orchestrator, run: Run, integration: string): Promise<void> {
  const merges = o.store.listMerges(run.id);
  const pending = merges.filter((m) => m.status === 'pending');
  const newest = pending.at(-1);
  if (!newest) return;
  for (const merge of pending.slice(0, -1)) {
    o.store.finishMerge(merge.id, 'reverted', { error: 'superseded by a later merge; not rolled back' });
  }
  const later = merges.slice(merges.indexOf(newest) + 1).some((m) => m.status === 'merged');
  const head = await headSha(integration);
  let ours = false;
  if (!later && head !== newest.preSha) {
    ours = newest.postSha
      ? head === newest.postSha
      : (await gitText(integration, ['rev-parse', '--verify', '-q', `${head}^1`]).catch(() => '')) === newest.preSha;
  }
  if (ours) await resetIntegration(integration, newest.preSha, integrationKeep(o, run));
  o.store.finishMerge(newest.id, 'reverted', {
    error: ours
      ? 'the merge did not finish; integration rolled back to the pre-merge sha'
      : head === newest.preSha
        ? 'the merge did not finish; nothing was committed'
        : 'the merge did not finish; integration moved on, not rolled back',
  });
}

/** Already merged nodes whose writes can touch the conflicted files (context for the resolver). */
function collidingNodes(o: Orchestrator, run: Run, files: readonly string[], self: string): TaskNode[] {
  const merged = new Set(
    o.store
      .listTasks(run.id)
      .filter((t) => t.status === 'merged')
      .map((t) => t.nodeId),
  );
  const nodes = o.approvedNodes(run.id).filter((n) => n.id !== self && merged.has(n.id));
  const hits = nodes.filter((n) => writeGlobs(n).some((g) => files.some((f) => globMatchesPath(g, f))));
  return (hits.length > 0 ? hits : nodes).slice(0, 6);
}

/**
 * Bring integration into the task branch and resolve the conflicts. `resolved` = the task branch now
 * contains integration (retry the squash merge); `done` = escalated to a human; `park` = wait.
 */
async function resolveConflicts(
  o: Orchestrator,
  run: Run,
  node: TaskNode,
  taskId: string,
  config: LegionConfig | null,
): Promise<Outcome> {
  const integrationRef = integrationBranchName(run.id);
  for (;;) {
    o.assertOpen();
    const task = o.store.requireTask(taskId);
    const meta = taskMeta(o.store, taskId);
    const decision = decideAfterMerge(task, 'conflict', meta.resolverAttempts, o.limits());
    if (decision.action === 'escalate') {
      const files = await conflictFilesOf(run, task);
      o.store.transaction(() => {
        o.applyDecision(taskId, { ...decision, escalation: null });
        o.dismissOpen(run.id, (item) => item.kind === 'conflict' && item.taskId === taskId, 'superseded');
        o.store.insertInboxItem({
          runId: run.id,
          taskId,
          attemptId: null,
          kind: 'conflict',
          payload: {
            files,
            summary: `${node.id} conflicts with the integration branch and ${meta.resolverAttempts} resolver attempt(s) failed${meta.resolverFailure ? `: ${meta.resolverFailure}` : '.'}`,
          },
        });
      });
      return 'done';
    }
    // A resolver session will be needed (the forecast has non-lockfile conflicts) but cannot start now:
    // park before touching git, and let the tick wake the queue when the gate opens.
    const engine = coderEngineFor(node, task);
    const forecastFiles = await conflictFilesOf(run, task);
    if (forecastFiles.some((f) => !isLockfilePath(f))) {
      const gate = o.gate(run.id, engine);
      if (gate) return parkQueue(o, run.id, gate);
    }
    const path = task.worktreePath ?? o.taskPath(run, taskId);
    if (task.branch) await ensureWorktree(run.repoPath, path, task.branch, null);
    if (await isMergeInProgress(path)) await abortMerge(path);
    const merged = await mergeIntoTaskBranch(path, integrationRef, meta.provisioned);
    if (merged.status !== 'conflict') return 'resolved';
    const locks = await resolveLockfileConflicts(path, merged.files, 'theirs');
    let commitMessage = `Merge ${integrationRef} into ${node.id}`;
    if (locks.remaining.length > 0) {
      const gate = o.gate(run.id, engine);
      if (gate) {
        await abortMerge(path);
        return parkQueue(o, run.id, gate);
      }
      const attempt = meta.resolverAttempts + 1;
      patchTaskMeta(o.store, taskId, { resolverAttempts: attempt });
      let session: AgentRun | null = null;
      try {
        session = await o.openSession({
          run,
          taskId,
          role: 'resolver',
          engine,
          model: task.modelOverride ?? node.agent.model ?? o.modelFor('resolver', engine),
          effort: task.effortOverride ?? node.agent.effort ?? o.settings().roles.resolver.effort,
          prompt: buildResolverPrompt({
            node,
            otherNodes: collidingNodes(o, run, locks.remaining, node.id),
            conflictFiles: locks.remaining,
            integrationRef,
            installCommand: config?.installCommand ?? null,
            attempt,
            previousFailure: meta.resolverFailure,
            tools: o.toolNames(engine),
            structuredReport: true,
          }),
          outputSchema: taskReportJsonSchema,
          cwd: path,
          allowedCommands: verifyCommands(node, config),
          parentAttemptId: o.leadAttemptId(run.id),
        });
        const report = await coderTurn(o, session);
        if (report?.status !== 'done') {
          throw new AgentFailure({
            kind: 'agent_error',
            message: report ? `resolver reported ${report.status}: ${report.summary}` : 'resolver gave no report',
          });
        }
        commitMessage = report.commitMessage.trim() || commitMessage;
        await o.finishAttempt(session, 'succeeded');
      } catch (error) {
        if (o.closed || error instanceof Closed) throw new Closed('closed');
        const failure =
          error instanceof AgentFailure ? error.failure : { kind: 'agent_error' as const, message: String(error) };
        if (session) await o.finishAttempt(session, 'failed', failure.message);
        await abortMerge(path);
        if (failure.kind === 'rate_limited') {
          patchTaskMeta(o.store, taskId, { resolverAttempts: meta.resolverAttempts });
          if (o.limitedUntil(engine) === null) o.registerRateLimit(engine, null);
          return parkQueue(o, run.id, { kind: 'rate', engine });
        }
        patchTaskMeta(o.store, taskId, { resolverFailure: failure.message });
        continue;
      }
    }
    try {
      await finishMerge(path, commitMessage, meta.provisioned);
    } catch (error) {
      await abortMerge(path);
      const message = (error as Error).message;
      patchTaskMeta(o.store, taskId, {
        resolverFailure: message,
        // Lockfile-only merges have no resolver session; count the failure anyway so this cannot loop.
        ...(locks.remaining.length === 0 ? { resolverAttempts: meta.resolverAttempts + 1 } : {}),
      });
      continue;
    }
    if (locks.resolved.length > 0) {
      const failure = await regenerateLockfiles(o, run, task, path, locks.resolved, config, integrationRef);
      if (failure) {
        o.applyDecision(taskId, {
          action: 'escalate',
          path: taskStatusPath(task.status, 'awaiting_human') ?? [],
          patch: {},
          escalation: 'other',
          resume: 'merge',
          reason: `${node.id}: regenerating the lockfile after merging ${integrationRef} failed (${failure})`,
        });
        return 'done';
      }
    }
    return 'resolved';
  }
}

/**
 * After lockfile conflicts were resolved by taking integration's side: regenerate each lockfile from the
 * merged manifest with a non-frozen command (`lockfileCommand`, per lockfile directory) and commit it.
 * Returns why it failed (non-zero exit), or null.
 */
async function regenerateLockfiles(
  o: Orchestrator,
  run: Run,
  task: Task,
  worktree: string,
  lockfiles: readonly string[],
  config: LegionConfig | null,
  integrationRef: string,
): Promise<string | null> {
  const dirs = [...new Set(lockfiles.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')))];
  for (const dir of dirs) {
    const cwd = dir ? join(worktree, dir) : worktree;
    const command = await lockfileCommand(cwd, config);
    if (!command) continue;
    const outcome = await runVerification(o, { run, task, attemptId: null, phase: 'setup', commands: [command], cwd });
    if (!outcome.ok) {
      const result = outcome.results.at(-1);
      return `\`${command}\` exited with ${result?.exitCode ?? 'no exit code'}`;
    }
  }
  await commitPaths(worktree, lockfiles, `Regenerate lockfile after merging ${integrationRef}`);
  return null;
}

/** Stop the queue until the gate opens; `tickRun` restarts it (and arms a wake timer for a rate limit). */
function parkQueue(o: Orchestrator, runId: string, reason: ParkReason): 'park' {
  o.mergeParked.set(runId, reason);
  return 'park';
}

async function conflictFilesOf(run: Run, task: Task): Promise<string[]> {
  if (!task.branch) return [];
  const forecast = await forecastMerge(run.repoPath, integrationBranchName(run.id), task.branch).catch(() => null);
  return forecast?.conflictFiles ?? [];
}
