/**
 * Integration tile: the run's integration branch. Tasks merged so far (in merge order, each with its
 * post-merge verification), the merge queue, tasks waiting for a human gate, conflicts being resolved and
 * the final verification on the integrated result.
 */
import type { Merge, Task, Verification } from '@shared/domain';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { mergesOfRun, openInbox, tasksOfRun, verificationsOfRun } from '../../app/data';
import { useData, useLatestPlan, useRun } from '../../app/hooks';
import { actions, dataStore } from '../../app/store';
import { Icon } from '../../chrome/icons';
import { Bar, Chip } from '../../chrome/ui';
import { formatClock } from '../../layout/describe';
import type { TileProps } from '../../layout/types';
import { Check, openTile, shortSha } from '../plan/kit';
import { commandLabel } from '../review/evidence';

interface Integration {
  tasks: Task[];
  merges: Merge[];
  merged: { merge: Merge; task: Task | null; verify: Verification | null }[];
  queue: Task[];
  waiting: Task[];
  inFlight: Task[];
  conflicts: { title: string; files: string[]; taskId: string | null }[];
  final: Verification[];
}

export function useIntegration(runId: string): Integration {
  const deps = useData(useShallow((s) => [s.tasks, s.merges, s.verifications, s.inbox]));
  return useMemo(() => {
    const state = dataStore.getState();
    const tasks = tasksOfRun(state.tasks, runId);
    const merges = mergesOfRun(state.merges, runId);
    const verifications = verificationsOfRun(state.verifications, runId);
    const merged = merges
      .filter((m) => m.status === 'merged')
      .map((merge) => ({
        merge,
        task: tasks.find((t) => t.id === merge.taskId) ?? null,
        verify:
          verifications
            .filter((v) => v.phase === 'post_merge' && v.taskId === merge.taskId && v.createdAt >= merge.createdAt)
            .at(0) ?? null,
      }));
    const conflicts = [
      ...merges
        .filter((m) => m.status === 'conflict')
        .map((m) => ({
          title: `${tasks.find((t) => t.id === m.taskId)?.nodeId ?? 'Task'} conflicts with the integration branch`,
          files: [],
          taskId: m.taskId,
        })),
      ...openInbox(state.inbox, runId)
        .filter((i) => i.kind === 'conflict')
        .map((i) => ({
          title: i.kind === 'conflict' ? i.payload.summary : '',
          files: i.kind === 'conflict' ? i.payload.files : [],
          taskId: i.taskId,
        })),
    ];
    return {
      tasks,
      merges,
      merged,
      queue: tasks.filter((t) => t.status === 'approved' || t.status === 'merging'),
      waiting: tasks.filter((t) => t.status === 'awaiting_human'),
      inFlight: tasks.filter((t) => ['provisioning', 'running', 'verifying', 'reviewing', 'fixing'].includes(t.status)),
      conflicts,
      final: verifications.filter((v) => v.phase === 'final'),
    };
  }, [runId, ...deps]);
}

export default function IntegrationTile({ runId }: TileProps<'integration'>) {
  const run = useRun(runId);
  const plan = useLatestPlan(runId);
  const data = useIntegration(runId);
  const title = (task: Task | null) => (task ? (plan?.dag.nodes.find((n) => n.id === task.nodeId)?.title ?? '') : '');
  if (!run) return null;
  const total = data.tasks.length;
  const mergedCount = data.tasks.filter((t) => t.status === 'merged').length;
  const lastVerify = data.merged.at(-1)?.verify ?? null;

  return (
    <div className="lg-col" data-testid="integration-tile">
      <div className="lg-bar">
        <Icon name="branch" size={13} style={{ color: 'var(--overlay2)' }} />
        <span className="mono min-w-0 truncate text-[12px]">
          {run.integrationBranch ?? 'integration branch not created yet'}
        </span>
        <span className="faint flex-none text-[12px]">from {run.baseRef}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={mergedCount === 0}
          onClick={() => openTile(runId, 'diff', { target: { kind: 'run', runId } })}
        >
          Run diff
        </button>
      </div>
      <div className="lg-scroll lg-pane">
        <div className="flex items-center gap-3">
          <span className="text-[22px] font-semibold tabular-nums leading-none">
            {mergedCount}
            <span className="faint text-[14px] font-normal">/{total}</span>
          </span>
          <span className="muted text-[12.5px]">merged</span>
          <Bar pct={total ? (mergedCount / total) * 100 : 0} color="var(--green)" width={90} />
          <span className="flex-1" />
          {lastVerify ? (
            <Chip tone={lastVerify.exitCode === 0 ? 'ok' : 'bad'}>
              post-merge verify {lastVerify.exitCode === 0 ? '✓' : '✕'}
            </Chip>
          ) : null}
        </div>

        {data.conflicts.length > 0 ? (
          <>
            <div className="lg-sec">Conflicts</div>
            <div className="flex flex-col gap-1.5">
              {data.conflicts.map((c) => (
                <div key={c.title} className="lg-callout" data-tone="bad">
                  <span className="text-red">Conflict</span>
                  <span className="muted flex-1">{c.title}</span>
                  {c.files.length ? <span className="mono text-[11.5px]">{c.files.join(', ')}</span> : null}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {data.waiting.length > 0 ? (
          <>
            <div className="lg-sec">Waiting for you</div>
            <div className="flex flex-col gap-1.5">
              {data.waiting.map((t) => (
                <div key={t.id} className="lg-callout" style={{ alignItems: 'center' }}>
                  <span className="mono text-[11.5px] text-peach">{t.nodeId}</span>
                  <span className="min-w-0 flex-1 truncate">{title(t)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => openTile(runId, 'review', { taskId: t.id })}
                    data-testid={`open-review-${t.nodeId}`}
                  >
                    Review →
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {data.queue.length > 0 || data.merges.some((m) => m.status === 'pending') ? (
          <>
            <div className="lg-sec">Merge queue</div>
            <div className="flex flex-col">
              {data.queue.map((t, i) => (
                <div key={t.id} className="lg-gate">
                  {t.status === 'merging' ? (
                    <span className="dot live" style={{ color: 'var(--blue)', margin: 3 }} />
                  ) : (
                    <span className="faint mono w-3.5 text-[11px]">{i + 1}</span>
                  )}
                  <span className="mono text-[11.5px] text-overlay2">{t.nodeId}</span>
                  <span className="min-w-0 flex-1 truncate">{title(t)}</span>
                  <span className="lg-gate-ev">{t.status === 'merging' ? 'merge-tree ✓ · merging' : 'queued'}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="lg-sec">
          Merged
          <span className="lg-sec-aside">squash-merged in this order</span>
        </div>
        {data.merged.length === 0 ? (
          <div className="faint text-[12.5px]">Nothing merged yet. Tasks merge as soon as review approves them.</div>
        ) : (
          <ol className="m-0 flex list-none flex-col p-0" data-testid="merged-list">
            {data.merged.map(({ merge, task, verify }, i) => (
              <li key={merge.id} className="relative flex gap-3 pb-3 pl-0.5">
                <span className="flex flex-none flex-col items-center">
                  <span className="mt-1 h-2 w-2 rounded-full bg-green" />
                  {i < data.merged.length - 1 ? <span className="mt-1 w-px flex-1 bg-surface1" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[12.5px]">
                    <span className="mono text-[11.5px] text-overlay2">{task?.nodeId}</span>
                    <span className="min-w-0 flex-1 truncate">{title(task)}</span>
                    <span className="mono faint flex-none text-[11px]">
                      {shortSha(merge.preSha)} → {shortSha(merge.postSha)}
                      {merge.endedAt ? ` · ${formatClock(merge.endedAt)}` : ''}
                    </span>
                  </span>
                  <span className="faint mt-0.5 flex items-center gap-1.5 text-[11.5px]">
                    {verify ? <Check ok={verify.exitCode === 0} size={11} /> : null}
                    {verify ? (
                      <span className="mono truncate">
                        {commandLabel(verify.command)} · {verify.outputTail.split('\n').filter(Boolean).at(-1)}
                      </span>
                    ) : (
                      <span>no post-merge verify recorded</span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}

        {data.inFlight.length > 0 ? (
          <>
            <div className="lg-sec">Still in flight</div>
            <div className="flex flex-wrap gap-1.5">
              {data.inFlight.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="lg-tag"
                  style={{ cursor: 'pointer', paddingRight: 7 }}
                  onClick={() => actions.revealTile(runId, `session:${t.nodeId}`)}
                >
                  {t.nodeId} <span className="faint font-sans">{t.status}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {data.final.length > 0 ? (
          <>
            <div className="lg-sec">Final verification</div>
            {data.final.map((v) => (
              <div key={v.id} className="lg-gate">
                <Check ok={v.exitCode === 0} />
                <span className="mono min-w-0 flex-1 truncate text-[11.5px]">{v.command}</span>
                <span className="lg-gate-ev">{v.outputTail.split('\n').filter(Boolean).at(-1)}</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
