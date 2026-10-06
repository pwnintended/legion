/**
 * Plan sign-off actions (approve / ask for revision) and their tile-scoped ⌘⏎ command. Shared by the plan
 * and DAG tiles so either can approve while focused.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { type CommandContext, registerCommands } from '../../app/commands';
import { latestPlan } from '../../app/data';
import { rpc } from '../../app/hooks';
import { dataStore } from '../../app/store';
import { focusedTile } from '../../layout/tree';
import { flushPlan } from './draft';
import { errorText } from './kit';
import { analyzePlan } from './model';

interface SignoffState {
  pending: 'approve' | 'revise' | null;
  error: string | null;
}

const signoff = createStore<Record<string, SignoffState>>(() => ({}));
const IDLE: SignoffState = { pending: null, error: null };

export function useSignoff(runId: string): SignoffState {
  return useStore(signoff, (s) => s[runId] ?? IDLE);
}

function set(runId: string, state: SignoffState): void {
  signoff.setState({ ...signoff.getState(), [runId]: state });
}

/** Can the run's latest plan be approved right now? */
export function canApprove(runId: string): boolean {
  const data = dataStore.getState();
  const run = data.runs[runId];
  const plan = latestPlan(data, runId);
  return !!run && !!plan && run.status === 'awaiting_approval' && plan.approvedAt === null;
}

export async function approvePlan(runId: string): Promise<boolean> {
  if (signoff.getState()[runId]?.pending) return false;
  set(runId, { pending: 'approve', error: null });
  try {
    const planId = await flushPlan(runId);
    if (!planId) throw new Error('Your latest edits are not saved yet. Fix the problems above, then approve.');
    const plan = dataStore.getState().plans[planId] ?? latestPlan(dataStore.getState(), runId);
    if (plan && !analyzePlan(plan.dag, dataStore.getState().settings).validation.ok)
      throw new Error('The plan has problems the engine would reject. Fix them first.');
    await rpc('runs.approvePlan', { runId, planId });
    set(runId, IDLE);
    return true;
  } catch (error) {
    set(runId, { pending: null, error: errorText(error) });
    return false;
  }
}

export async function requestRevision(runId: string, feedback: string): Promise<void> {
  set(runId, { pending: 'revise', error: null });
  try {
    const plan = latestPlan(dataStore.getState(), runId);
    if (!plan) throw new Error('No plan to revise.');
    await rpc('runs.requestPlanRevision', { runId, planId: plan.id, feedback });
    set(runId, IDLE);
  } catch (error) {
    set(runId, { pending: null, error: errorText(error) });
    throw error;
  }
}

function focusedPlanTile(ctx: CommandContext): boolean {
  if (ctx.ui.overlay !== null || ctx.ui.layoutMode === 'overview' || ctx.ui.layoutMode === 'pipeline') return false;
  const tile = ctx.layout ? focusedTile(ctx.layout) : null;
  return !!tile && (tile.kind === 'plan' || tile.kind === 'dag');
}

let registered = false;
/** Register ⌘⏎ "Approve plan & start" (wins over the global ⌘⏎ while a plan or DAG tile is focused). */
export function registerPlanCommands(): void {
  if (registered) return;
  registered = true;
  registerCommands([
    {
      id: 'plan.approve',
      title: 'Approve plan & start',
      category: 'Run',
      keybinding: 'Mod+Enter',
      priority: 10,
      inInput: false,
      when: (ctx) => focusedPlanTile(ctx) && !!ctx.activeRunId && canApprove(ctx.activeRunId),
      run: (ctx) => approvePlan(ctx.activeRunId as string),
    },
  ]);
}
