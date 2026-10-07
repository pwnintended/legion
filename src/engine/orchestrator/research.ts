/**
 * Research agents (architecture §8.5): a coordinator's `spawn_research` opens a researcher (read-only + web)
 * or a research lead (coordinate + web) as its child; the driver below waits for the agent's structured
 * `ResearchReport`, posts it to the parent as a `report` message and closes the agent. A failure posts a
 * `status` message instead, so the parent never waits on a dead child.
 */
import type { Attempt, Role, Run } from '@shared/domain';
import { ResearchReportSchema, researchReportJsonSchema } from '@shared/schemas';
import type { McpBinding, SpawnResearchRequest } from '../mcp';
import {
  buildResearcherPrompt,
  buildResearchLeadPrompt,
  formatResearchReport,
  RESEARCH_CAPS,
  RESEARCH_ROLES,
} from './core';
import type { AgentRun } from './live-session';
import { AgentFailure, Closed, type Orchestrator } from './orchestrator';
import { ensureIntegrationWorktree } from './worktrees';

const REQUESTER_LABEL: Partial<Record<Role, string>> = {
  lead: 'implementation lead',
  research_lead: 'research lead',
};

export async function spawnResearch(
  o: Orchestrator,
  binding: McpBinding,
  request: SpawnResearchRequest,
): Promise<{ attemptId: string; role: Role }> {
  o.assertOpen();
  const parent = o.store.requireAttempt(binding.attemptId);
  const run = o.store.requireRun(parent.runId);
  const cap = RESEARCH_CAPS[parent.role];
  if (cap === undefined) throw new Error(`a ${parent.role} cannot spawn research`);
  const role: Role = request.mode === 'team' ? 'research_lead' : 'researcher';
  if (role === 'research_lead' && parent.role === 'research_lead')
    throw new Error('a research lead spawns researchers only');
  const running = o.store
    .listChildAttempts(parent.id)
    .filter((a) => RESEARCH_ROLES.has(a.role) && (a.status === 'running' || a.status === 'pending')).length;
  if (running >= cap) {
    throw new Error(`you already have ${running} research agents running (cap ${cap}); wait for a report first`);
  }
  const settings = o.settings();
  const engine = settings.roles[role].engine;
  await o.waitForEngine(engine);
  const config = await o.config(run);
  const repo = o.repoInput(run, config);
  const requester = REQUESTER_LABEL[parent.role] ?? parent.role;
  const tools = o.toolNames(engine);
  const prompt =
    role === 'research_lead'
      ? buildResearchLeadPrompt({
          ...request,
          repo,
          requester,
          tools,
          maxResearchers: RESEARCH_CAPS.research_lead ?? 4,
        })
      : buildResearcherPrompt({ ...request, repo, requester, tools });
  const session = await o.openSession({
    run,
    taskId: null,
    role,
    engine,
    model: o.modelFor(role, engine),
    effort: settings.roles[role].effort,
    prompt,
    outputSchema: researchReportJsonSchema,
    cwd: await researchCwd(o, run),
    parentAttemptId: parent.id,
    attachments: o.runAttachments(run),
  });
  o.background(`research ${session.attempt.id}`, () => driveResearch(o, session, parent, request.title));
  return { attemptId: session.attempt.id, role };
}

/** Where research reads: the integration worktree once it exists (the run's state), else the repository. */
async function researchCwd(o: Orchestrator, run: Run): Promise<string> {
  try {
    return await ensureIntegrationWorktree(o, run);
  } catch {
    return run.repoPath;
  }
}

async function driveResearch(o: Orchestrator, session: AgentRun, parent: Attempt, title: string): Promise<void> {
  try {
    const report = await o.structuredTurn(session, ResearchReportSchema, 1);
    await o.finishAttempt(session, 'succeeded');
    o.postMessage({
      runId: parent.runId,
      fromAttemptId: session.attempt.id,
      toAttemptId: parent.id,
      kind: 'report',
      body: formatResearchReport(title, report),
      replyTo: null,
    });
  } catch (error) {
    if (o.closed || error instanceof Closed) return;
    const message = error instanceof AgentFailure ? error.failure.message : (error as Error).message;
    await o.finishAttempt(session, 'failed', message);
    if (o.store.getAttempt(parent.id)?.status !== 'running') return;
    o.postMessage({
      runId: parent.runId,
      fromAttemptId: session.attempt.id,
      toAttemptId: parent.id,
      kind: 'status',
      body: `Research "${title}" failed: ${message}`,
      replyTo: null,
    });
  }
}
