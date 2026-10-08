/**
 * A project's other checkouts: its git worktrees, each matched to the Legion run and task it belongs to (a task's
 * worktree by path, a run's integration worktree by branch). Browsing a checkout is confined to this list, so a
 * renderer can never read an arbitrary folder by naming it.
 */
import { realpath } from 'node:fs/promises';
import type { Run, Task } from '@shared/domain';
import type { Checkout } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { listWorktrees } from '../git/worktrees';

const canonical = (path: string) => realpath(path).catch(() => path);

export interface CheckoutSources {
  runs: readonly Run[];
  tasksOf: (runId: string) => readonly Task[];
}

export async function listCheckouts(root: string, sources: CheckoutSources): Promise<Checkout[]> {
  const main = await canonical(root);
  const worktrees = await listWorktrees(root);
  const taskByPath = new Map<string, Task>();
  for (const run of sources.runs) {
    for (const task of sources.tasksOf(run.id)) {
      if (task.worktreePath) taskByPath.set(await canonical(task.worktreePath), task);
    }
  }
  const out: Checkout[] = [];
  for (const w of worktrees) {
    if (w.bare || w.prunable) continue;
    const path = await canonical(w.path);
    if (path === main) continue;
    const task = taskByPath.get(path);
    const run = task
      ? sources.runs.find((r) => r.id === task.runId)
      : sources.runs.find((r) => r.integrationBranch !== null && r.integrationBranch === w.branch);
    out.push({
      path,
      branch: w.branch,
      kind: task ? 'task' : run ? 'integration' : 'other',
      runId: run?.id ?? null,
      taskId: task?.id ?? null,
    });
  }
  return out;
}

/** The root to browse: the main checkout, or one of the project's worktrees (refused otherwise). */
export async function checkoutRoot(root: string, checkout: string | null | undefined): Promise<string> {
  if (!checkout) return root;
  const wanted = await canonical(checkout);
  for (const w of await listWorktrees(root)) {
    if (!w.bare && (await canonical(w.path)) === wanted) return wanted;
  }
  throw new RpcError('bad_request', 'not a checkout of this project');
}
