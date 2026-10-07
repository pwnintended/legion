/**
 * Waybar-style status bar: key mode pill, layout mode, pipeline phase progress, agents N/M, "needs you"
 * counter (jumps to the oldest urgent tile), cost, and per-engine rate-limit bars.
 */
import type { Run } from '@shared/domain';
import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip, executeCommand } from '../app/commands';
import { latestPlan, tasksOfRun } from '../app/data';
import { useActiveRun, useAgentsRunning, useData, useInbox, useRateLimits, useRunCost, useUi } from '../app/hooks';
import { formatCost } from '../layout/describe';
import { Icon } from './icons';
import { Bar, CommandKbd, Dot } from './ui';

type PhaseState = 'done' | 'current' | 'attention' | 'todo';
interface Phase {
  label: string;
  state: PhaseState;
  progress?: { done: number; total: number };
}

const ORDER = ['plan', 'dag', 'execute', 'integrate', 'PR'] as const;

function phases(run: Run, merged: number, total: number, planExists: boolean): Phase[] {
  const at = (index: number, attention = false): Phase[] =>
    ORDER.map((label, i) => ({
      label,
      state: i < index ? 'done' : i === index ? (attention ? 'attention' : 'current') : 'todo',
    }));
  let list: Phase[];
  switch (run.status) {
    case 'chatting':
    case 'draft':
    case 'clarifying':
    case 'planning':
      list = at(0);
      break;
    case 'awaiting_approval':
      list = at(planExists ? 1 : 0, true);
      break;
    case 'executing':
      list = at(2);
      break;
    case 'integrating':
      list = at(3);
      break;
    case 'finalizing':
      list = at(4);
      break;
    case 'pr_ready':
      list = at(4, true);
      break;
    default:
      list = at(5);
  }
  const execute = list[2];
  if (execute && execute.state !== 'todo') execute.progress = { done: merged, total };
  if (run.status === 'awaiting_approval' && list[1]) list[1].label = 'dag: sign-off';
  if (run.status === 'pr_ready' && list[4]) list[4].label = 'PR: ready';
  return list;
}

const PHASE_COLOR: Record<PhaseState, string> = {
  done: 'var(--green)',
  current: 'var(--blue)',
  attention: 'var(--peach)',
  todo: 'var(--overlay2)',
};

const MODE_PILL = {
  normal: { label: 'NORMAL', bg: 'var(--mauve)' },
  resize: { label: 'RESIZE', bg: 'var(--peach)' },
  move: { label: 'MOVE', bg: 'var(--blue)' },
  locked: { label: 'LOCKED', bg: 'var(--surface2)' },
} as const;

const HINTS = {
  resize: 'h/l narrower·wider  f full  t thin  esc done',
  move: 'h/j/k/l move  esc done',
} as const;

export function StatusBar() {
  const run = useActiveRun();
  const keyMode = useUi((s) => s.keyMode);
  const locked = useUi((s) => s.terminalLocked);
  const layoutMode = useUi((s) => s.layoutMode);
  const agents = useAgentsRunning();
  const urgent = useInbox(null);
  const cost = useRunCost(run?.id);
  const limits = useRateLimits();
  const progress = useData(
    useShallow((s) => {
      if (!run) return { merged: 0, total: 0, planExists: false };
      const tasks = tasksOfRun(s.tasks, run.id);
      return {
        merged: tasks.filter((t) => t.status === 'merged').length,
        total: tasks.length || (latestPlan(s, run.id)?.dag.nodes.length ?? 0),
        planExists: latestPlan(s, run.id) !== null,
      };
    }),
  );
  const pill = MODE_PILL[keyMode === 'normal' && locked ? 'locked' : keyMode];

  return (
    <footer
      className="mono flex h-[30px] flex-none items-center gap-3.5 overflow-hidden border-t border-[var(--chrome-line)] bg-mantle px-2.5 text-[11.5px] whitespace-nowrap"
      data-testid="statusbar"
    >
      <span
        className="rounded px-2 py-0.5 font-semibold tracking-[0.04em] text-crust transition-colors"
        style={{ background: pill.bg }}
        data-testid="mode-pill"
      >
        {pill.label}
      </span>
      {keyMode !== 'normal' ? (
        <span className="faint">{HINTS[keyMode]}</span>
      ) : (
        <span className="faint">{layoutMode}</span>
      )}

      {run && keyMode === 'normal' ? (
        <span className="inline-flex items-center gap-2" data-testid="phases">
          {phases(run, progress.merged, progress.total, progress.planExists).map((phase, i) => (
            <Fragment key={phase.label}>
              {i > 0 ? <span className="faint">›</span> : null}
              <span style={{ color: PHASE_COLOR[phase.state] }}>
                {phase.label}
                {phase.state === 'done' ? ' ✓' : ''}
              </span>
              {phase.progress && phase.progress.total > 0 ? (
                <>
                  <Bar pct={(phase.progress.done / phase.progress.total) * 100} color="var(--blue)" width={60} />
                  <span className="muted">
                    {phase.progress.done}/{phase.progress.total}
                  </span>
                </>
              ) : null}
            </Fragment>
          ))}
          {run.paused ? <span className="text-peach">paused</span> : null}
        </span>
      ) : null}

      <span className="flex-1" />

      <span className="inline-flex items-center gap-1.5" title="Agents running / concurrency limit">
        <Dot color={agents.running > 0 ? 'var(--blue)' : 'var(--overlay0)'} live={agents.running > 0} />
        {agents.running}/{agents.max} agents
      </span>
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 hover:bg-surface0"
        style={{ color: urgent.length ? 'var(--peach)' : 'var(--overlay2)' }}
        onClick={() => void executeCommand('focus.nextUrgent')}
        title={commandTooltip('focus.nextUrgent')}
        data-testid="needs-you"
      >
        <Icon name="alert" size={12} strokeWidth={2.2} />
        needs you {urgent.length}
        <CommandKbd id="focus.nextUrgent" />
      </button>
      {run ? <span title="Spend on this run">{formatCost(cost)}</span> : null}
      {limits.map((limit) => (
        <span
          key={`${limit.engine}:${limit.window}`}
          className="hidden items-center gap-1.5 md:inline-flex"
          title={limit.resetsAt ? `resets ${new Date(limit.resetsAt).toLocaleString()}` : undefined}
        >
          <span style={{ color: limit.engine === 'codex' ? 'var(--teal)' : 'var(--mauve)' }}>{limit.engine}</span>
          {shortWindow(limit.window)}
          <Bar
            pct={limit.usedPct}
            color={
              limit.usedPct >= 90
                ? 'var(--red)'
                : limit.usedPct >= 75
                  ? 'var(--peach)'
                  : limit.engine === 'codex'
                    ? 'var(--teal)'
                    : 'var(--mauve)'
            }
          />
          {Math.round(limit.usedPct)}%
        </span>
      ))}
    </footer>
  );
}

function shortWindow(window: string): string {
  if (window === 'weekly') return 'wk';
  return window;
}
