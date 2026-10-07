/**
 * Research agents through the lifecycle service: a lead spawns a researcher and gets its report on the next
 * wake; a research lead spawns researchers, collects their reports and delivers its own; caps and depth hold.
 */
import type { Attempt } from '@shared/domain';
import type { ResearchReport } from '@shared/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpBinding } from '../mcp';
import { runMeta } from './meta';
import { approve, type Harness, node, planOutput, report, type Script, startHarness, taskIdIn } from './test-harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const binding = (attempt: Attempt): McpBinding => ({
  runId: attempt.runId,
  taskId: attempt.taskId,
  attemptId: attempt.id,
  role: attempt.role,
  parentAttemptId: attempt.parentAttemptId ?? null,
});

/** One task whose coder waits `coderDelayMs` first, so the run stays `executing` while research happens. */
const scriptWith =
  (coderDelayMs: number): Script =>
  (ctx) => {
    if (ctx.opts.role === 'planner') return [planOutput([node('T1')])];
    if (ctx.opts.role === 'reviewer' || ctx.opts.role === 'finalizer') return [approve(ctx)];
    const id = taskIdIn(ctx.message);
    return [
      { kind: 'delay', ms: coderDelayMs },
      { kind: 'write_file', path: `src/${id.toLowerCase()}.txt`, content: `${id}\n` },
      report(`Implement ${id}`),
    ];
  };
const script = scriptWith(2_500);

const researchReport = (summary: string): ResearchReport => ({
  summary,
  findings: [{ claim: 'The repo has a README.', evidence: 'README.md exists.', sources: ['README.md'] }],
  openQuestions: [],
  confidence: 'high',
});

async function executingRun(harness: Harness) {
  const run = await harness.client.call('runs.create', {
    repoPath: harness.repo.path,
    baseRef: 'main',
    title: 'Research run',
    issueText: 'Do the thing.',
    issueUrl: null,
    plannerEngine: 'claude',
    plannerModel: null,
    skipClarify: true,
  });
  await harness.waitFor(() => harness.engine.store.requireRun(run.id).status === 'awaiting_approval', 'plan');
  const plan = harness.engine.store.latestPlan(run.id);
  await harness.client.call('runs.approvePlan', { runId: run.id, planId: plan?.id as string });
  const lead = await harness.waitFor(() => {
    const id = runMeta(harness.engine.store, run.id).leadAttemptId;
    return id ? harness.engine.store.getAttempt(id) : null;
  }, 'lead');
  return { run, lead };
}

describe('research agents', () => {
  it('a lead spawns a researcher and reads its report on the next wake', async () => {
    const leadMessages: string[] = [];
    h = await startHarness({
      script,
      lead: (ctx) => {
        leadMessages.push(ctx.message);
        return [{ kind: 'text', text: 'ok' }];
      },
      research: (ctx) => {
        expect(ctx.opts.role).toBe('researcher');
        expect(ctx.opts.permission).toMatchObject({ mode: 'read_only', web: true });
        expect(ctx.opts.untrustedWorkdir).toBe(true);
        expect(ctx.opts.prompt).toContain('Research brief: Auth.');
        expect(ctx.opts.systemPrompt).toContain('implementation lead asked you');
        return [{ kind: 'output', value: researchReport('Cookie sessions.') }];
      },
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, lead } = await executingRun(harness);
    const spawned = await orchestrator.mcpHost.spawnResearch(binding(store.requireAttempt(lead.id)), {
      title: 'Auth',
      brief: 'How is auth done?',
      mode: 'single',
    });
    expect(spawned.role).toBe('researcher');
    expect(store.requireAttempt(spawned.attemptId).parentAttemptId).toBe(lead.id);
    await harness.waitFor(() => leadMessages.some((m) => m.includes('Cookie sessions.')), 'report delivered');
    const wake = leadMessages.find((m) => m.includes('Cookie sessions.')) as string;
    expect(wake).toContain(`### Report from researcher (${spawned.attemptId})`);
    expect(wake).toContain('**Research: Auth** (confidence high)');
    expect(store.requireAttempt(spawned.attemptId).status).toBe('succeeded');
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
  }, 60_000);

  it('a research lead collects its researchers and reports to the lead; caps and depth hold', async () => {
    const leadMessages: string[] = [];
    h = await startHarness({
      script,
      lead: (ctx) => {
        leadMessages.push(ctx.message);
        return [{ kind: 'text', text: 'ok' }];
      },
      research: (ctx) =>
        ctx.opts.role === 'research_lead'
          ? [
              { kind: 'delay', ms: 400 },
              { kind: 'output', value: researchReport('Synthesis.') },
            ]
          : [{ kind: 'output', value: researchReport(`Part ${ctx.opts.prompt.includes('A.') ? 'A' : 'B'}.`) }],
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, lead } = await executingRun(harness);
    const host = orchestrator.mcpHost;
    const team = await host.spawnResearch(binding(store.requireAttempt(lead.id)), {
      title: 'All',
      brief: 'Everything.',
      mode: 'team',
    });
    expect(team.role).toBe('research_lead');
    const rl = store.requireAttempt(team.attemptId);
    expect(rl.parentAttemptId).toBe(lead.id);
    expect(harness.claude.sessions.find((s) => s.opts.role === 'research_lead')?.opts.permission).toMatchObject({
      mode: 'coordinate',
      web: true,
    });

    // As the research lead: spawn two researchers, collect both reports.
    const a = await host.spawnResearch(binding(rl), { title: 'A', brief: 'Part A.', mode: 'single' });
    const b = await host.spawnResearch(binding(rl), { title: 'B', brief: 'Part B.', mode: 'single' });
    expect(store.requireAttempt(a.attemptId).parentAttemptId).toBe(rl.id);
    await expect(host.spawnResearch(binding(rl), { title: 'C', brief: 'x', mode: 'team' })).rejects.toThrow(
      /researchers only/,
    );
    const first = await host.awaitMessage(binding(rl), { replyTo: null, timeoutMs: 5_000 });
    const second = await host.awaitMessage(binding(rl), { replyTo: null, timeoutMs: 5_000 });
    const bodies = [first?.body, second?.body].join('\n');
    expect(bodies).toContain('Part A.');
    expect(bodies).toContain('Part B.');
    expect(new Set([first?.fromAttemptId, second?.fromAttemptId])).toEqual(new Set([a.attemptId, b.attemptId]));

    // The research lead's own report reaches the lead.
    await harness.waitFor(() => leadMessages.some((m) => m.includes('Synthesis.')), 'synthesis delivered');
    expect(leadMessages.find((m) => m.includes('Synthesis.'))).toContain(`### Report from research_lead (${rl.id})`);
    await harness.waitFor(() => store.requireAttempt(rl.id).status === 'succeeded', 'research lead done');
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
  }, 60_000);

  it('enforces the cap and tells the parent when research fails', async () => {
    const leadMessages: string[] = [];
    h = await startHarness({
      script: scriptWith(8_000),
      lead: (ctx) => {
        leadMessages.push(ctx.message);
        return [{ kind: 'text', text: 'ok' }];
      },
      research: (ctx) =>
        ctx.opts.prompt.includes('Broken')
          ? [{ kind: 'fail', message: 'no network', exitCode: 1 }]
          : [
              { kind: 'delay', ms: 1_500 },
              { kind: 'output', value: researchReport('Slow.') },
            ],
    });
    const harness = h;
    const { orchestrator, store } = harness.engine;
    const { run, lead } = await executingRun(harness);
    const host = orchestrator.mcpHost;
    const asLead = binding(store.requireAttempt(lead.id));
    for (const title of ['One', 'Two', 'Three'])
      await host.spawnResearch(asLead, { title, brief: 'slow', mode: 'single' });
    await expect(host.spawnResearch(asLead, { title: 'Four', brief: 'slow', mode: 'single' })).rejects.toThrow(/cap 3/);
    await harness.waitFor(() => leadMessages.filter((m) => m.includes('Slow.')).length > 0, 'reports', 20_000);
    await harness.waitFor(
      () => store.listAttempts(run.id).filter((a) => a.role === 'researcher' && a.status === 'succeeded').length === 3,
      'all three done',
      20_000,
    );
    const broken = await host.spawnResearch(asLead, { title: 'Broken', brief: 'Broken', mode: 'single' });
    await harness.waitFor(
      () => leadMessages.some((m) => m.includes('Research "Broken" failed: no network')),
      'failure reported',
    );
    expect(store.requireAttempt(broken.attemptId).status).toBe('failed');
    const failure = store.listMessages(run.id).find((m) => m.fromAttemptId === broken.attemptId);
    expect(failure?.kind).toBe('status');
    await harness.waitFor(() => store.requireRun(run.id).status === 'pr_ready', 'pr_ready', 30_000);
  }, 60_000);
});
