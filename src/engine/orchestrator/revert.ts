/**
 * `tasks.revertHunk`: take one hunk of a task's diff back out of its worktree (the user reviewing in the Code
 * view). The hunk is applied in reverse (`git apply -R`) and refused when it no longer matches what is there.
 * With the task's coder at work, the revert stays in the worktree and goes in with its next commit; otherwise it
 * is committed on the task branch at once, so a merge takes it.
 */
import type { DiffHunk, DiffLine } from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { commitPaths, GitError, git } from '../git';
import type { Orchestrator } from './orchestrator';

/** A unified diff of one hunk of `path` (both sides the same path), as git would write it. */
export function hunkPatch(path: string, hunk: DiffHunk): string {
  const body = hunk.lines.map((line: DiffLine) => {
    switch (line.kind) {
      case 'add':
        return `+${line.text}`;
      case 'del':
        return `-${line.text}`;
      case 'no_newline':
        return '\\ No newline at end of file';
      default:
        return ` ${line.text}`;
    }
  });
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...body,
    '',
  ].join('\n');
}

const CLOSED = new Set(['merging', 'merged', 'skipped', 'cancelled']);

export async function revertHunk(
  o: Orchestrator,
  taskId: string,
  path: string,
  hunk: DiffHunk,
): Promise<{ committed: boolean }> {
  const task = o.store.requireTask(taskId);
  if (CLOSED.has(task.status)) throw new RpcError('conflict', `task ${task.nodeId} is ${task.status}`);
  const worktree = task.worktreePath;
  if (!worktree) throw new RpcError('failed_precondition', `task ${task.nodeId} has no worktree`);
  if (path.startsWith('/') || path.split('/').some((s) => s === '..' || s.toLowerCase() === '.git'))
    throw new RpcError('bad_request', 'invalid path');
  try {
    await git(worktree, ['apply', '-R', '--whitespace=nowarn', '-'], { input: hunkPatch(path, hunk) });
  } catch (error) {
    if (error instanceof GitError)
      throw new RpcError('conflict', `that change in ${path} no longer matches the worktree; refresh the diff`);
    throw error;
  }
  const coding = o.store
    .listAttempts(task.runId)
    .some((a) => a.taskId === task.id && a.status === 'running' && (a.role === 'coder' || a.role === 'resolver'));
  if (coding) return { committed: false };
  const result = await commitPaths(worktree, [path], `Revert a change to ${path} (by you, in review)`);
  return { committed: result.committed };
}
