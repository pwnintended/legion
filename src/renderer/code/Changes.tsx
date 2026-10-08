/**
 * What a run changed, as a list to open from: the whole run (base…integration), then each task's own diff in
 * plan order, with its state and its +/− so far. A task with a worktree also opens a terminal there (in the
 * workspace on that worktree). The Changes section of a run workspace's side panel.
 */
import type { TaskStatus } from '@shared/domain';
import { useShallow } from 'zustand/react/shallow';
import { latestPlan, tasksOfRun } from '../app/data';
import { useData } from '../app/hooks';
import { TASK_SHORT } from '../app/status-words';
import { Icon } from '../chrome/icons';
import { Dot, toneColor } from '../chrome/ui';
import { type Tone, taskDiffStat } from '../layout/describe';
import { useListNav } from '../tiles/project/list-nav';
import { openDiff, openTerminal } from './actions';
import { useShownTab } from './hooks';

const TONE: Record<TaskStatus, Tone> = {
  blocked: 'idle',
  queued: 'idle',
  provisioning: 'run',
  running: 'run',
  verifying: 'run',
  reviewing: 'run',
  fixing: 'run',
  approved: 'ok',
  merging: 'run',
  merged: 'ok',
  awaiting_human: 'warn',
  failed: 'bad',
  skipped: 'idle',
  cancelled: 'idle',
};
const LIVE = new Set<TaskStatus>(['provisioning', 'running', 'verifying', 'reviewing', 'fixing', 'merging']);

interface Row {
  taskId: string;
  nodeId: string;
  title: string;
  status: TaskStatus;
  added: number;
  removed: number;
  files: number;
  worktree: string | null;
}

export function Changes({ projectId, runId }: { projectId: string; runId: string }) {
  const run = useData((s) => s.runs[runId] ?? null);
  const rows = useData(
    useShallow((s) => {
      const plan = latestPlan(s, runId);
      const order = new Map(plan?.dag.nodes.map((n, i) => [n.id, i]) ?? []);
      return tasksOfRun(s.tasks, runId)
        .slice()
        .sort((a, b) => (order.get(a.nodeId) ?? 1e9) - (order.get(b.nodeId) ?? 1e9) || a.nodeId.localeCompare(b.nodeId))
        .map((task) => {
          const stat = taskDiffStat(s, task);
          const title = plan?.dag.nodes.find((n) => n.id === task.nodeId)?.title ?? task.nodeId;
          return JSON.stringify({
            taskId: task.id,
            nodeId: task.nodeId,
            title,
            status: task.status,
            added: stat?.added ?? 0,
            removed: stat?.removed ?? 0,
            files: stat?.files ?? 0,
            worktree: task.worktreePath ?? null,
          } satisfies Row);
        });
    }),
  ).map((r) => JSON.parse(r) as Row);
  const shown = useShownTab(projectId, (tab) =>
    tab.kind === 'diff'
      ? tab.params.target.kind === 'task'
        ? tab.params.target.taskId
        : tab.params.target.kind === 'run'
          ? 'run'
          : null
      : null,
  );
  const integration = run?.integrationBranch ?? null;

  const open = (index: number, pinned: boolean) => {
    if (index === 0) {
      if (integration) openDiff(projectId, { kind: 'run', runId }, { pinned });
      return;
    }
    const row = rows[index - 1];
    if (row) openDiff(projectId, { kind: 'task', taskId: row.taskId }, { pinned });
  };
  const nav = useListNav(rows.length + 1, open);

  if (!run) return <div className="ac-empty">This run is gone.</div>;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a keyboard-navigable list (rows are buttons)
    <div className="cg" ref={nav.ref} onKeyDown={nav.onKeyDown} data-testid="code-changes">
      <button
        type="button"
        className="ac-row cg-row"
        data-row={0}
        data-active={nav.active === 0}
        data-open={shown === 'run'}
        disabled={!integration}
        onClick={(event) => open(0, event.metaKey || event.ctrlKey)}
        title={integration ? 'Everything the run merged so far, against its base' : undefined}
        data-testid="changes-run"
      >
        <span className="ac-run-dot">
          <Icon name="merge" size={13} className="cg-icon" />
        </span>
        <span className="ac-main">
          <span className="ac-title">All changes</span>
          <span className="ac-sub">
            {integration ? (
              <span className="mono faint">{integration}</span>
            ) : (
              <span className="faint">once the first task merges</span>
            )}
          </span>
        </span>
      </button>
      {rows.length === 0 ? (
        <div className="ac-empty cg-empty">
          <span>No tasks yet.</span>
          <span className="faint">Each task's diff shows up here once the plan is signed off.</span>
        </div>
      ) : (
        rows.map((row, i) => {
          const index = i + 1;
          const tone = TONE[row.status];
          return (
            <div key={row.taskId} className="cg-line">
              <button
                type="button"
                className="ac-row cg-row"
                data-row={index}
                data-active={nav.active === index}
                data-open={shown === row.taskId}
                onClick={(event) => {
                  nav.setActive(index);
                  open(index, event.metaKey || event.ctrlKey);
                }}
                title={`${row.nodeId} ${row.title}`}
                data-testid="changes-task"
              >
                <span className="ac-run-dot">
                  <Dot color={toneColor(tone)} live={LIVE.has(row.status)} />
                </span>
                <span className="ac-main">
                  <span className="ac-title">
                    <span className="cg-id mono">{row.nodeId}</span>
                    <span className="cg-name">{row.title}</span>
                  </span>
                  <span className="ac-sub" style={{ color: toneColor(tone) }}>
                    {TASK_SHORT[row.status]}
                  </span>
                </span>
                {row.added || row.removed ? (
                  <span className="ac-meta cg-stat mono" title={`${row.files} file${row.files === 1 ? '' : 's'}`}>
                    <span className="cg-add">+{row.added}</span>
                    <span className="cg-del">−{row.removed}</span>
                  </span>
                ) : null}
              </button>
              {row.worktree ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon cg-shell"
                  aria-label={`Open a terminal in ${row.nodeId}'s worktree`}
                  title={`Open a terminal in ${row.nodeId}'s worktree`}
                  onClick={() => openTerminal({ terminalId: null, cwd: row.worktree, attemptId: null }, runId)}
                >
                  <Icon name="terminal" size={13} />
                </button>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
