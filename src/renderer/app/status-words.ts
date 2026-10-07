/**
 * The words Legion uses for a task's state, in one place, so the progress strip, the palette, the pipeline and
 * the tiles describe the same thing the same way. `TASK_WORD` is the sentence form (tooltips, labels read
 * aloud), `TASK_SHORT` the chip form. A run "works" when its tasks are in a live state; a task the human must
 * answer is "waiting for you", whatever its own status says.
 */
import type { TaskStatus } from '@shared/domain';

export const TASK_WORD: Record<TaskStatus, string> = {
  blocked: 'waiting for its dependencies',
  queued: 'queued',
  provisioning: 'setting up its worktree',
  running: 'coding',
  verifying: 'running its checks',
  reviewing: 'in review',
  fixing: 'fixing review findings',
  approved: 'approved, waiting to merge',
  merging: 'merging',
  merged: 'merged',
  awaiting_human: 'waiting for you',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
};

export const TASK_SHORT: Record<TaskStatus, string> = {
  blocked: 'waiting',
  queued: 'queued',
  provisioning: 'setting up',
  running: 'coding',
  verifying: 'checking',
  reviewing: 'in review',
  fixing: 'fixing',
  approved: 'approved',
  merging: 'merging',
  merged: 'merged',
  awaiting_human: 'waiting for you',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
};

/** "3 agents working" / "1 agent working": the count of agent sessions running right now. */
export function agentsWorking(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'} working`;
}
