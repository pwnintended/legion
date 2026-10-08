/** What the Code view calls a viewer tab, in its tab strip and in the palette's list of windows. */
import type { Commit } from '@shared/rpc';
import { type DataState, latestPlan } from '../app/data';
import { peekQuery } from '../app/query';
import type { ViewerTab } from './state';

export interface TabLabel {
  /** A mono id ahead of the title (a task id, a commit's short sha). */
  id: string | null;
  title: string;
  /** The whole name, for tooltips and the palette. */
  full: string;
}

/** A commit's subject, when the history has been read (the activity panel reads the latest 50). */
function commitSubject(projectId: string, sha: string): string | null {
  const log = peekQuery<Commit[]>(`log:${projectId}:50`)?.data;
  return log?.find((c) => c.sha === sha)?.subject ?? null;
}

export function tabLabel(state: DataState, tab: ViewerTab): TabLabel {
  if (tab.kind === 'code') {
    const path = tab.params.path;
    return { id: null, title: path.split('/').at(-1) ?? path, full: path };
  }
  const target = tab.params.target;
  switch (target.kind) {
    case 'commit': {
      const subject = commitSubject(target.projectId, target.sha) ?? 'Commit';
      return { id: target.sha.slice(0, 7), title: subject, full: `${target.sha.slice(0, 7)} ${subject}` };
    }
    case 'task': {
      const task = state.tasks[target.taskId];
      const node = task ? latestPlan(state, task.runId)?.dag.nodes.find((n) => n.id === task.nodeId) : undefined;
      const id = task?.nodeId ?? 'Task';
      const title = node?.title ?? 'changes';
      return { id, title, full: `${id} ${title}` };
    }
    case 'run':
      return { id: null, title: 'All changes', full: 'Everything the run changed' };
    case 'range':
      return { id: null, title: `${target.from}..${target.to}`, full: `Changes ${target.from}..${target.to}` };
  }
}
