/**
 * The run at a glance, pinned above the conversation: where it is (plan › execute n/m › integrate › PR) and one
 * dot per task. Hovering a dot says what that agent is doing; clicking it opens the task among the agents. Once
 * there are agents, the strip's end is the way in to them (⌘E on the focused tile).
 */
import type { InboxItem, Run, Task, TaskNode, TaskStatus } from '@shared/domain';
import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { hasAgents, latestPlan, tasksOfRun } from '../app/data';
import { useData, useNow } from '../app/hooks';
import { TASK_WORD } from '../app/status-words';
import { actions, uiStore } from '../app/store';
import { Icon } from '../chrome/icons';
import { CommandKbd, commandTooltip } from '../chrome/ui';
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

/** The run's unanswered inbox items. */
function openItemsOf(inbox: Record<string, InboxItem>, runId: string): InboxItem[] {
  return Object.values(inbox).filter((i) => i.runId === runId && i.resolvedAt === null);
}

export type StepState = 'done' | 'current' | 'attention' | 'todo';

export function steps(
  run: Run,
  merged: number,
  total: number,
  waiting: boolean,
): { label: string; state: StepState }[] {
  const order = ['Plan', `Execute${total ? ` ${merged}/${total}` : ''}`, 'Integrate', 'Pull request'];
  const at = (index: number, attention = false) =>
    order.map((label, i) => ({
      label,
      state: (i < index
        ? 'done'
        : i === index
          ? attention || waiting
            ? 'attention'
            : 'current'
          : 'todo') as StepState,
    }));
  switch (run.status) {
    case 'chatting':
    case 'session':
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
function planningLine(run: Run, waiting: boolean): string | null {
  switch (run.status) {
    case 'clarifying':
      return waiting ? 'The planner has questions for you' : 'The planner is reading the request';
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
  const open = useData(useShallow((s) => openItemsOf(s.inbox, run.id)));
  const now = useNow(15_000, run.status === 'planning' || run.status === 'clarifying');
  const agents = useData((s) => hasAgents(s, run.id));
  if (run.status === 'chatting') return null;
  // What waits on the human outranks what the agents are doing: a task with an open item is the human's, and a
  // budget stop (or a pause) means nothing is working, whatever the task statuses say.
  const waitingTasks = new Set(open.flatMap((i) => (i.taskId ? [i.taskId] : [])));
  const halted = run.paused || open.some((i) => i.kind === 'budget');
  const merged = tasks.filter((t) => t.status === 'merged').length;
  const line = planningLine(run, open.length > 0);
  const sorted = [...tasks].sort((a, b) => Number(a.nodeId.slice(1)) - Number(b.nodeId.slice(1)));
  const working = halted ? 0 : tasks.filter((t) => TASK_TONE[t.status] === 'live' && !waitingTasks.has(t.id)).length;
  const lineTone = open.length > 0 || run.status === 'awaiting_approval' ? 'attention' : 'live';
  return (
    <div className="ch-progress" data-testid="chat-progress" data-status={run.status}>
      <div className="ch-progress-inner">
        <ol className="ch-steps" aria-label="Run progress">
          {steps(run, merged, tasks.length, open.length > 0).map((step, i) => (
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
              <TaskDot
                key={task.id}
                task={task}
                node={nodes?.find((n) => n.id === task.nodeId) ?? null}
                waiting={waitingTasks.has(task.id)}
              />
            ))}
          </ul>
        ) : line ? (
          <span className="ch-progress-line" data-tone={lineTone}>
            <span className={lineTone === 'live' ? 'dot live' : 'dot'} aria-hidden="true" />
            {line}
            {/* How long the planner has been at it; once it waits on the human, the clock is theirs, not its. */}
            {(run.status === 'planning' || run.status === 'clarifying') && lineTone === 'live' ? (
              <span className="ch-dim"> · {formatDuration(now - run.updatedAt)}</span>
            ) : null}
          </span>
        ) : null}
        <div className="ch-progress-end">
          {halted && open.length ? (
            <span className="ch-working-count" data-tone="attention">
              Paused · waiting for you
            </span>
          ) : working ? (
            <span className="ch-working-count" title="Tasks with an agent on them right now">
              {working} task{working === 1 ? '' : 's'} in progress
            </span>
          ) : sorted.length && open.length ? (
            <span className="ch-working-count" data-tone="attention">
              Waiting for you
            </span>
          ) : sorted.length && line ? (
            <span className="ch-working-count">{line}</span>
          ) : null}
          {agents ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm ch-agents-door"
              title={commandTooltip('view.agents', "Show this conversation's agents")}
              onClick={() => openAgents(run.id)}
              data-testid="chat-agents-door"
            >
              <Icon name="agents" size={13} />
              <span className="ch-agents-door-label">Agents</span>
              <CommandKbd id="view.agents" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function openAgents(runId: string): void {
  actions.setActiveRun(runId);
  actions.setView('agents');
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

function TaskDot({ task, node, waiting }: { task: Task; node: TaskNode | null; waiting: boolean }) {
  const tone: Tone = waiting && TASK_TONE[task.status] !== 'bad' ? 'attention' : TASK_TONE[task.status];
  const word = tone === 'attention' ? TASK_WORD.awaiting_human : TASK_WORD[task.status];
  const title = node ? node.title : task.nodeId;
  const detail = task.status === 'failed' ? (task.error ?? task.progress) : task.progress;
  return (
    <li className="ch-dot-item">
      <button
        type="button"
        className="ch-dot"
        data-tone={tone}
        aria-label={`${task.nodeId} ${title}: ${word}. Open among the agents.`}
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
          {word}
        </span>
        {detail && tone !== 'done' ? <span className="ch-dot-tip-line">{detail}</span> : null}
      </span>
    </li>
  );
}
