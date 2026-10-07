/**
 * Project activity: this project's Legion runs (status, PR, cost, when; click to open the run), its open pull
 * requests (gh; open on GitHub) and its recent git history (subject, decorations, author, when; click to see
 * the commit's diff next to it). One keyboard list: ↑/↓ or j/k, ⏎ opens, ⌘⏎ opens a commit in a new column.
 */
import type { Run } from '@shared/domain';
import type { Commit, CommitRef, PullRequestSummary } from '@shared/rpc';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { runPr } from '../../app/compat';
import { openInboxCount, runCost, runningAttempts, taskCounts } from '../../app/data';
import { useData, useNow, useUi } from '../../app/hooks';
import { newRunInProject, openCommit } from '../../app/project-actions';
import { projectWorkspaceKey, selectRailGroups } from '../../app/projects';
import { actions } from '../../app/store';
import { Icon } from '../../chrome/icons';
import { runStatusLine } from '../../chrome/run-status';
import { CommandKbd, Dot, toneColor } from '../../chrome/ui';
import { formatCost } from '../../layout/describe';
import { previewTile } from '../../layout/project';
import type { TileProps } from '../../layout/types';
import { openUrl, relativeTime, SkeletonRows, useGitLog, useProjectInfo, usePrs } from '../project/kit';
import { useListNav } from '../project/list-nav';

const NO_RUNS: Run[] = [];

type Row =
  | { kind: 'run'; key: string; run: Run }
  | { kind: 'pr'; key: string; pr: PullRequestSummary }
  | { kind: 'commit'; key: string; commit: Commit };

function RunRow({ run, active, index, now }: { run: Run; active: boolean; index: number; now: number }) {
  const stats = useData(
    useShallow((s) => {
      const counts = taskCounts(s, run.id);
      return {
        agents: runningAttempts(s, run.id).length,
        merged: counts.merged ?? 0,
        total: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
        urgent: openInboxCount(s, run.id),
        cost: runCost(s, run.id),
      };
    }),
  );
  const line = runStatusLine(run, stats.agents, stats.merged, stats.total, stats.urgent);
  const pr = runPr(run);
  return (
    <button
      type="button"
      className="ac-row ac-run"
      data-row={index}
      data-active={active}
      data-testid="activity-run"
      onClick={() => actions.setActiveRun(run.id)}
      title={`Open the run “${run.title}”`}
    >
      <span className="ac-run-dot">
        <Dot color={toneColor(line.tone)} live={line.live} />
      </span>
      <span className="ac-main">
        <span className="ac-title">{run.title}</span>
        <span className="ac-sub" style={{ color: stats.urgent > 0 ? 'var(--peach)' : toneColor(line.tone) }}>
          {stats.urgent > 0 ? `${stats.urgent} waiting for you · ` : ''}
          {line.text}
        </span>
      </span>
      <span className="ac-meta">
        {pr ? (
          <span
            className={`chip ${pr.state === 'merged' ? 'chip-accent' : pr.state === 'closed' ? 'chip-idle' : 'chip-ok'}`}
          >
            #{pr.number ?? '?'}
          </span>
        ) : null}
        {stats.cost > 0 ? <span className="mono faint">{formatCost(stats.cost)}</span> : null}
        <span className="faint ac-when">{relativeTime(run.updatedAt, now)}</span>
      </span>
    </button>
  );
}

function RefChip({ r }: { r: CommitRef }) {
  return (
    <span className="ac-ref" data-kind={r.kind} title={r.kind === 'head' ? `HEAD → ${r.name}` : r.name}>
      {r.kind === 'tag' ? <Icon name="tag" size={10} /> : null}
      {r.name}
    </span>
  );
}

function CommitRow({
  commit,
  active,
  open,
  index,
  now,
  onOpen,
}: {
  commit: Commit;
  active: boolean;
  open: boolean;
  index: number;
  now: number;
  onOpen: (newColumn: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="ac-row ac-commit"
      data-row={index}
      data-active={active}
      data-open={open}
      data-testid="activity-commit"
      onClick={(event) => onOpen(event.metaKey || event.ctrlKey)}
      title={`${commit.subject}\n${commit.shortSha} · ${commit.author}`}
    >
      <span className="ac-node" aria-hidden="true" />
      <span className="ac-main">
        <span className="ac-title">
          <span className="ac-subject">{commit.subject}</span>
          {commit.refs.slice(0, 3).map((r) => (
            <RefChip key={`${r.kind}:${r.name}`} r={r} />
          ))}
        </span>
        <span className="ac-sub faint">
          <span className="mono">{commit.shortSha}</span> · {commit.author}
        </span>
      </span>
      <span className="ac-meta">
        <span className="faint ac-when">{relativeTime(commit.date, now)}</span>
      </span>
    </button>
  );
}

function PrRow({ pr, active, index, now }: { pr: PullRequestSummary; active: boolean; index: number; now: number }) {
  return (
    <button
      type="button"
      className="ac-row"
      data-row={index}
      data-active={active}
      data-testid="activity-pr"
      onClick={() => openUrl(pr.url)}
      title={`Open #${pr.number} on GitHub`}
    >
      <span className="ac-run-dot">
        <Icon name="pr" size={13} style={{ color: pr.isDraft ? 'var(--overlay2)' : 'var(--green)' }} />
      </span>
      <span className="ac-main">
        <span className="ac-title">
          <span className="mono faint">#{pr.number}</span> {pr.title}
        </span>
        <span className="ac-sub faint">
          <span className="mono">{pr.branch}</span>
          {pr.author ? ` · ${pr.author}` : ''}
          {pr.isDraft ? ' · draft' : ''}
        </span>
      </span>
      <span className="ac-meta">
        {pr.updatedAt ? <span className="faint ac-when">{relativeTime(pr.updatedAt, now)}</span> : null}
        <Icon name="external" size={11} className="faint" />
      </span>
    </button>
  );
}

function SectionHead({ title, count, children }: { title: string; count?: number | null; children?: React.ReactNode }) {
  return (
    <div className="ac-sec">
      <span className="sec">{title}</span>
      {count !== null && count !== undefined ? <span className="ac-count">{count}</span> : null}
      <span className="ac-sec-aside">{children}</span>
    </div>
  );
}

export default function ActivityTile({ params, tileId }: TileProps<'activity'>) {
  const { projectId } = params;
  const now = useNow(60_000);
  const runs = useData((s) => selectRailGroups(s).find((g) => g.key === projectId)?.runs ?? NO_RUNS);
  const log = useGitLog(projectId, 50);
  const prs = usePrs(projectId);
  // Pull requests only make sense for a GitHub remote.
  const onGithub = useProjectInfo(projectId).data?.github != null;
  const openSha = useUi((s) => {
    const layout = s.layouts[projectWorkspaceKey(projectId)];
    const tile = layout ? previewTile(layout, 'diff') : null;
    const target = (tile?.params as { target?: { kind: string; sha?: string } } | undefined)?.target;
    return target?.kind === 'commit' ? (target.sha ?? null) : null;
  });

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = runs.map((run) => ({ kind: 'run', key: run.id, run }));
    for (const pr of prs.data?.prs ?? []) out.push({ kind: 'pr', key: `pr:${pr.number}`, pr });
    for (const commit of log.data ?? []) out.push({ kind: 'commit', key: commit.sha, commit });
    return out;
  }, [runs, prs.data, log.data]);

  const open = (row: Row | undefined, newColumn: boolean) => {
    if (!row) return;
    if (row.kind === 'run') actions.setActiveRun(row.run.id);
    else if (row.kind === 'pr') openUrl(row.pr.url);
    else openCommit(projectId, row.commit.sha, { anchorTileId: tileId, newColumn });
  };
  const nav = useListNav(rows.length, (index, newColumn) => open(rows[index], newColumn));
  const indexOf = (key: string) => rows.findIndex((r) => r.key === key);

  const branch = log.data?.[0]?.refs.find((r) => r.kind === 'head')?.name ?? null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a keyboard-navigable list (rows are buttons)
    <div className="ac-scroll" ref={nav.ref} onKeyDown={nav.onKeyDown} data-testid="project-activity">
      <SectionHead title="Runs" count={runs.length || null}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => newRunInProject(projectId)}>
          <Icon name="plus" size={12} strokeWidth={2.4} />
          New run
        </button>
      </SectionHead>
      {runs.length === 0 ? (
        <div className="ac-empty">
          <span>No runs in this project yet.</span>
          <span className="faint">
            When you know what should change, <CommandKbd id="composer.open" /> plans it here.
          </span>
        </div>
      ) : (
        runs.map((run) => (
          <RunRow key={run.id} run={run} index={indexOf(run.id)} active={nav.active === indexOf(run.id)} now={now} />
        ))
      )}

      {onGithub &&
      prs.data &&
      (prs.data.available ? prs.data.prs.length > 0 : prs.data.reason !== 'no GitHub remote') ? (
        <>
          <SectionHead title="Pull requests" count={prs.data.available ? prs.data.prs.length : null} />
          {prs.data.available ? (
            prs.data.prs.map((pr) => (
              <PrRow
                key={pr.number}
                pr={pr}
                index={indexOf(`pr:${pr.number}`)}
                active={nav.active === indexOf(`pr:${pr.number}`)}
                now={now}
              />
            ))
          ) : (
            <div className="ac-empty ac-empty-inline faint">{prs.data.reason}</div>
          )}
        </>
      ) : null}

      <SectionHead title="History" count={null}>
        {branch ? (
          <span className="ac-branch mono" title={`HEAD → ${branch}`}>
            {branch}
          </span>
        ) : null}
      </SectionHead>
      {log.data ? (
        log.data.length === 0 ? (
          <div className="ac-empty faint">No commits yet.</div>
        ) : (
          <div className="ac-timeline">
            {log.data.map((commit) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                index={indexOf(commit.sha)}
                active={nav.active === indexOf(commit.sha)}
                open={commit.sha === openSha}
                now={now}
                onOpen={(newColumn) => open({ kind: 'commit', key: commit.sha, commit }, newColumn)}
              />
            ))}
          </div>
        )
      ) : log.error ? (
        <div className="ac-empty faint">Couldn't read the history: {log.error}</div>
      ) : (
        <SkeletonRows rows={6} />
      )}
    </div>
  );
}
