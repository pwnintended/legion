/**
 * The run at a glance, pinned above the conversation: where it is (plan › execute n/m › integrate › PR) and one
 * dot per task. Hovering a dot says what that agent is doing; clicking it opens the task among the agents.
 */
import type { Run, Task, TaskNode, TaskStatus } from '@shared/domain';
import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { latestPlan, tasksOfRun } from '../app/data';
import { useData, useNow } from '../app/hooks';
import { actions, uiStore } from '../app/store';
import { Icon } from '../chrome/icons';
import { formatDuration } from '../layout/describe';
import { sessionTileOf } from '../tiles/session/actions';

type Tone = 'done' | 'live' | 'attention' | 'bad' | 'idle' | 'gone';

const TASK_TONE: Record<TaskStatus, Tone> = {
  blocked: 'idle',
  queued: 'idle',
  provisioning: 'live',
  running: 'live',
  verifying: 'live',
  reviewing: 'live',
  fixing: 'live',
  approved: 'live',
  merging: 'live',
  merged: 'done',
  awaiting_human: 'attention',
  failed: 'bad',
  skipped: 'gone',
  cancelled: 'gone',
};

const TASK_WORD: Record<TaskStatus, string> = {
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

type StepState = 'done' | 'current' | 'attention' | 'todo';

function steps(run: Run, merged: number, total: number): { label: string; state: StepState }[] {
  const order = ['Plan', `Execute${total ? ` ${merged}/${total}` : ''}`, 'Integrate', 'Pull request'];
  const at = (index: number, attention = false) =>
    order.map((label, i) => ({
      label,
      state: (i < index ? 'done' : i === index ? (attention ? 'attention' : 'current') : 'todo') as StepState,
    }));
  switch (run.status) {
    case 'chatting':
    case 'draft':
    case 'clarifying':
    case 'planning':
      return at(0);
    case 'awaiting_approval':
      return at(0, true);
    case 'executing':
      return at(1);
    case 'integrating':
    case 'finalizing':
      return at(2);
    case 'pr_ready':
      return at(3, true);
    case 'done':
      return at(4);
    default:
      return order.map((label) => ({ label, state: 'todo' as StepState }));
  }
}

/** What the run is doing when no task is running yet (the planner's phase). */
function planningLine(run: Run): string | null {
  switch (run.status) {
    case 'clarifying':
      return 'The planner is reading the request';
    case 'planning':
      return 'The planner is exploring the repository and drafting a plan';
    case 'awaiting_approval':
      return 'The plan waits for your sign-off';
    case 'integrating':
      return 'Verifying the integration branch';
    case 'finalizing':
      return 'Final review of the whole change';
    default:
      return null;
  }
}

export function Progress({ run }: { run: Run }) {
  const { tasks, nodes } = useData(
    useShallow((s) => ({ tasks: tasksOfRun(s.tasks, run.id), nodes: latestPlan(s, run.id)?.dag.nodes ?? null })),
  );
  const now = useNow(15_000, run.status === 'planning' || run.status === 'clarifying');
  if (run.status === 'chatting') return null;
  const merged = tasks.filter((t) => t.status === 'merged').length;
  const line = planningLine(run);
  const sorted = [...tasks].sort((a, b) => Number(a.nodeId.slice(1)) - Number(b.nodeId.slice(1)));
  const working = tasks.filter((t) => TASK_TONE[t.status] === 'live').length;
  return (
    <div className="ch-progress" data-testid="chat-progress" data-status={run.status}>
      <div className="ch-progress-inner">
        <ol className="ch-steps" aria-label="Run progress">
          {steps(run, merged, tasks.length).map((step, i) => (
            <Fragment key={step.label}>
              {i > 0 ? (
                <li className="ch-step-sep" aria-hidden="true">
                  <Icon name="chevronRight" size={11} />
                </li>
              ) : null}
              <li
                className="ch-step"
                data-state={step.state}
                aria-current={step.state === 'current' ? 'step' : undefined}
              >
                {step.state === 'done' ? <Icon name="check" size={11} strokeWidth={2.6} /> : null}
                {step.label}
              </li>
            </Fragment>
          ))}
        </ol>
        {sorted.length ? (
          <ul className="ch-dots" aria-label="Tasks">
            {sorted.map((task) => (
              <TaskDot key={task.id} task={task} node={nodes?.find((n) => n.id === task.nodeId) ?? null} />
            ))}
          </ul>
        ) : line ? (
          <span className="ch-progress-line">
            <span className="dot live" aria-hidden="true" />
            {line}
            {run.status === 'planning' || run.status === 'clarifying' ? (
              <span className="ch-dim"> · {formatDuration(now - run.updatedAt)}</span>
            ) : null}
          </span>
        ) : null}
        {working ? (
          <span className="ch-working-count" title="Agents working on tasks right now">
            {working} working
          </span>
        ) : sorted.length && line ? (
          <span className="ch-working-count">{line}</span>
        ) : null}
      </div>
    </div>
  );
}

function openTask(task: Task): void {
  const layout = uiStore.getState().layouts[task.runId];
  const tileId = sessionTileOf(layout, task.id);
  if (tileId) actions.revealTile(task.runId, tileId);
  else {
    actions.setActiveRun(task.runId);
    actions.setView('agents');
  }
}

function TaskDot({ task, node }: { task: Task; node: TaskNode | null }) {
  const tone = TASK_TONE[task.status];
  const title = node ? node.title : task.nodeId;
  const detail = task.status === 'failed' ? (task.error ?? task.progress) : task.progress;
  return (
    <li className="ch-dot-item">
      <button
        type="button"
        className="ch-dot"
        data-tone={tone}
        aria-label={`${task.nodeId} ${title}: ${TASK_WORD[task.status]}. Open among the agents.`}
        onClick={() => openTask(task)}
        data-testid="chat-task-dot"
      >
        <span className="ch-dot-mark" aria-hidden="true" />
      </button>
      <span className="ch-dot-tip" role="tooltip">
        <span className="ch-dot-tip-head">
          <span className="mono">{task.nodeId}</span> {title}
        </span>
        <span className="ch-dot-tip-status" data-tone={tone}>
          {TASK_WORD[task.status]}
        </span>
        {detail && tone !== 'done' ? <span className="ch-dot-tip-line">{detail}</span> : null}
      </span>
    </li>
  );
}
