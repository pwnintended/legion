/**
 * The deep pane of the route map: the selected station's header (id, title, engines, status, goal), its stage
 * track, its tabs, and the focused tile of the run's tree as the body. One pane, never two: the map is how you
 * move. A plan node with no task yet shows its brief instead of a tile.
 */
import type { Run, Task, TaskNode } from '@shared/domain';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { attemptsOfTask, latestPlan, latestReview, openInbox, taskByNode, tasksOfRun } from '../app/data';
import { useData, useNow } from '../app/hooks';
import { dataStore } from '../app/store';
import { steps as runSteps, type StepState } from '../chat/Progress';
import { Icon, type IconName } from '../chrome/icons';
import { Chip, StatusChipView } from '../chrome/ui';
import {
  describeTile,
  displayEngine,
  ENGINE_LABEL,
  engineTone,
  otherEngine,
  taskDiffStat,
  taskEngine,
} from '../layout/describe';
import { TileBody, useTakeFocus } from '../layout/TileFrame';
import { focusedTile, type LayoutTile, type Workspace } from '../layout/tree';
import { type StationKey, stationNode, taskStation } from './route';
import { activeTab, openTab, selectStation, stationTabs, type TabSpec } from './stations';

type TrackState = StepState | 'bad';
interface TrackStep {
  label: string;
  state: TrackState;
}

/**
 * Where a task stands. A first pass reads Code › Check › Review › Merge; once a review sent it back, the loop
 * shows: Code › Review › Fix n/m › Re-review › Merge (the checks run inside each step). A task the human must
 * answer, or that failed, marks the step it stopped at.
 */
export function taskTrack(task: Task, maxFixRounds: number, reviewed: boolean, checked: boolean): TrackStep[] {
  const looped = task.fixRounds > 0;
  const labels = looped
    ? ['Code', 'Review', `Fix ${task.fixRounds}/${maxFixRounds}`, 'Re-review', 'Merge']
    : ['Code', 'Check', 'Review', 'Merge'];
  const merge = labels.length - 1;
  const at = (index: number, state: TrackState): TrackStep[] =>
    labels.map((label, i) => ({ label, state: i < index ? 'done' : i === index ? state : 'todo' }));
  switch (task.status) {
    case 'blocked':
    case 'queued':
    case 'skipped':
    case 'cancelled':
      return labels.map((label) => ({ label, state: 'todo' }));
    case 'provisioning':
    case 'running':
      return at(0, 'current');
    case 'fixing':
      return at(2, 'current');
    case 'verifying':
      return at(looped ? 3 : 1, 'current');
    case 'reviewing':
      return at(looped ? 3 : 2, 'current');
    case 'approved':
    case 'merging':
      return at(merge, 'current');
    case 'merged':
      return at(merge + 1, 'done');
    default: {
      // awaiting_human / failed: the step it reached.
      const reached = looped ? 3 : reviewed ? 2 : checked ? 1 : 0;
      return at(reached, task.status === 'failed' ? 'bad' : 'attention');
    }
  }
}

function StageTrack({ steps }: { steps: TrackStep[] }) {
  return (
    <ol className="rm-track" aria-label="Stages">
      {steps.map((step, i) => (
        <li key={step.label} className="rm-step" data-state={step.state} data-first={i === 0 || undefined}>
          <span className="rm-step-ring" aria-hidden="true">
            {step.state === 'done' ? <Icon name="check" size={11} strokeWidth={3} /> : null}
          </span>
          <span className="rm-step-label">{step.label}</span>
          {step.state === 'current' || step.state === 'attention' || step.state === 'bad' ? (
            <span className="sr-only"> (now)</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

const STATION_ICON: Record<'plan' | 'integration' | 'pr' | 'crew', IconName> = {
  plan: 'list',
  integration: 'merge',
  pr: 'pr',
  crew: 'agents',
};

const STATION_TITLE = { integration: 'Integration', pr: 'Pull request', crew: 'Crew' } as const;

/** The synthetic tile whose meta describes a run-level station (status chip, urgency). */
function stationTile(station: StationKey): LayoutTile {
  switch (station) {
    case 'plan':
      return { id: 'plan', kind: 'plan', params: { planId: null }, auto: true } as LayoutTile;
    case 'integration':
      return { id: 'integration', kind: 'integration', params: {}, auto: true } as LayoutTile;
    case 'pr':
      return { id: 'pr', kind: 'pr', params: {}, auto: true } as LayoutTile;
    default:
      return { id: 'agents', kind: 'agents', params: {}, auto: true } as LayoutTile;
  }
}

function runCaption(station: StationKey, run: Run, plan: ReturnType<typeof latestPlan>): string {
  switch (station) {
    case 'plan':
      if (!plan)
        return run.status === 'chatting' ? 'The run is still a conversation.' : 'The planner is working on it.';
      return plan.approvedAt
        ? `Version ${plan.version}, signed off. ${plan.dag.nodes.length} tasks.`
        : `Version ${plan.version}, waiting for your sign-off.`;
    case 'integration':
      if (run.status === 'integrating') return 'Every task merged; running the checks on the integration branch.';
      if (run.status === 'finalizing') return 'Checks passed; the final review reads the whole change.';
      if (run.status === 'pr_ready' || run.status === 'done') return 'Every task merged and the checks passed.';
      return 'Runs once every task has merged into the integration branch.';
    case 'pr':
      if (run.status === 'pr_ready') return 'Ready for you: open a draft pull request, or merge it locally.';
      if (run.status === 'done')
        return run.merged ? `Merged into ${run.merged.into} locally.` : (run.pr?.url ?? 'Opened.');
      return 'One draft pull request (or a local merge), after integration and the final review.';
    default:
      return 'The agents that coordinate the run, and the messages between them.';
  }
}

export function StationPane({
  runId,
  layout,
  station,
  mapNode,
}: {
  runId: string;
  layout: Workspace;
  station: StationKey;
  mapNode: string | null;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const now = useNow(15_000);
  const inputs = useData(
    useShallow((s) => [
      s.tasks,
      s.plans,
      s.inbox,
      s.attempts,
      s.reviews,
      s.verifications,
      s.settings,
      s.runs[runId],
      s.diffstats,
    ]),
  );
  const tile = mapNode ? null : focusedTile(layout);

  const view = useMemo(() => {
    void inputs;
    const data = dataStore.getState();
    const run = data.runs[runId];
    const plan = latestPlan(data, runId);
    const nodeId = stationNode(station);
    const node = nodeId ? (plan?.dag.nodes.find((n) => n.id === nodeId) ?? null) : null;
    const task = nodeId ? taskByNode(data, runId, nodeId) : null;
    const tabs = stationTabs(data, runId, station);
    const maxFix = data.settings?.limits.maxFixRounds ?? 2;
    let meta: ReturnType<typeof describeTile> | null = null;
    let track: TrackStep[] | null = null;
    let engines: { coder: ReturnType<typeof taskEngine>; reviewer: ReturnType<typeof taskEngine> | null } | null = null;
    let diff: ReturnType<typeof taskDiffStat> = null;
    let findings: number | null = null;
    if (task) {
      meta = describeTile(
        data,
        runId,
        {
          id: `session:${task.nodeId}`,
          kind: 'session',
          params: { taskId: task.id, attemptId: null },
          auto: true,
        } as LayoutTile,
        now,
      );
      const attempts = attemptsOfTask(data, task);
      const coder = attempts.filter((a) => a.role === 'coder' || a.role === 'resolver').at(-1) ?? null;
      const reviewer = attempts.filter((a) => a.role === 'reviewer').at(-1) ?? null;
      const coderEngine = taskEngine(data, coder);
      // The reviewer shows once there is one, or once the task reached review.
      const reviewed = ['reviewing', 'fixing', 'approved', 'merging', 'merged'].includes(task.status);
      engines = {
        coder: coderEngine,
        reviewer: reviewer ? displayEngine(data, reviewer) : reviewed ? otherEngine(coderEngine) : null,
      };
      // A failed task reads as failed, even while its escalation waits on you (the map says the same).
      if (task.status === 'failed' && meta.status)
        meta = { ...meta, status: { label: 'failed', tone: 'bad', live: false } };
      const review = latestReview(data, task.id, runId);
      const checked = Object.values(data.verifications).some((v) => v.taskId === task.id);
      track = taskTrack(task, maxFix, review !== null, checked);
      diff = taskDiffStat(data, task);
      findings = review ? review.findings.length : null;
    } else if (!nodeId && run) {
      meta = describeTile(data, runId, stationTile(station), now);
      const tasks = tasksOfRun(data.tasks, runId);
      const merged = tasks.filter((t) => t.status === 'merged').length;
      const waiting = openInbox(data.inbox, runId).length > 0;
      if (station !== 'crew')
        track = runSteps(
          run,
          merged,
          tasks.length,
          waiting &&
            (station === 'plan' ? run.status === 'awaiting_approval' : station === 'pr' && run.status === 'pr_ready'),
        ).map((s) => ({ label: s.label, state: s.state }));
    }
    const caption = node?.goal ?? (run && !nodeId ? runCaption(station, run, plan) : '');
    const deps = node ? node.dependsOn.filter((d) => taskByNode(data, runId, d)?.status !== 'merged') : [];
    return { run, plan, node, task, tabs, meta, track, engines, caption, diff, findings, deps };
  }, [inputs, runId, station, now]);

  const { node, task, tabs, meta, track, engines, caption, diff, findings } = view;
  const current = activeTab(tabs, tile);
  // A tile of the station that is none of its tabs (an agent's own session, a range diff) shows as an extra tab.
  const extra = tile && !current && !mapNode ? tile : null;
  const nodeId = stationNode(station);
  const runLevel = nodeId === null ? (station as 'plan' | 'integration' | 'pr' | 'crew') : null;
  const title =
    node?.title ??
    nodeId ??
    (runLevel === 'plan'
      ? view.plan
        ? `Plan · v${view.plan.version}`
        : 'Plan'
      : STATION_TITLE[runLevel as 'integration' | 'pr' | 'crew']);

  return (
    <section
      className="rm-pane"
      aria-label={nodeId ? `${nodeId} ${title}` : title}
      data-testid="station-pane"
      data-station={station}
    >
      <header className="rm-pane-head">
        <div className="rm-pane-titlerow">
          {nodeId ? (
            <span className="rm-idchip mono">{nodeId}</span>
          ) : (
            <span className="rm-idchip" aria-hidden="true">
              <Icon name={STATION_ICON[runLevel ?? 'crew']} size={14} />
            </span>
          )}
          <h2 className="rm-pane-title">{title}</h2>
          <span className="flex-1" />
          {engines ? (
            <span className="rm-pane-chips">
              <Chip tone={engineTone(engines.coder)} live={task?.status === 'running' || task?.status === 'fixing'}>
                {ENGINE_LABEL[engines.coder]} <span className="rm-chip-role">coder</span>
              </Chip>
              {engines.reviewer ? (
                <Chip tone={engineTone(engines.reviewer)} live={task?.status === 'reviewing'}>
                  {ENGINE_LABEL[engines.reviewer]} <span className="rm-chip-role">reviewer</span>
                </Chip>
              ) : null}
            </span>
          ) : null}
          {meta?.status ? <StatusChipView status={meta.status} /> : null}
          <div className="rm-pane-actions tile-actions" ref={setSlot} />
        </div>
        {caption ? <p className="rm-pane-caption">{caption}</p> : null}
        {node ? <DependencyLine runId={runId} node={node} /> : null}
      </header>
      {track ? <StageTrack steps={track} /> : null}
      {tabs.length > 0 || extra ? (
        <div className="rm-tabs" role="tablist" aria-label={`${title} views`}>
          {tabs.map((spec) => (
            <button
              key={spec.id}
              type="button"
              role="tab"
              className="rm-tab"
              aria-selected={current?.id === spec.id}
              onClick={() => openTab(runId, spec)}
              data-testid={`station-tab-${spec.id}`}
            >
              {spec.label}
              <TabBadge spec={spec} diff={diff} findings={findings} task={task} />
            </button>
          ))}
          {extra ? (
            <button type="button" role="tab" className="rm-tab" aria-selected="true">
              <ExtraLabel runId={runId} tile={extra} />
            </button>
          ) : null}
        </div>
      ) : null}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={mapNode ? `node:${mapNode}` : (tile?.id ?? 'none')}
          className="rm-pane-body"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          {mapNode && node ? (
            <NodeBrief runId={runId} node={node} />
          ) : tile ? (
            <PaneTile runId={runId} tile={tile} label={`${nodeId ? `${nodeId} ` : ''}${title}`} slot={slot} />
          ) : (
            <p className="rm-empty-pane">Pick a station on the map.</p>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

function TabBadge({
  spec,
  diff,
  findings,
  task,
}: {
  spec: TabSpec;
  diff: { added: number; removed: number } | null;
  findings: number | null;
  task: Task | null;
}) {
  if (spec.id === 'transcript' && task && ['running', 'fixing', 'provisioning', 'verifying'].includes(task.status))
    return <span className="dot live rm-tab-live" style={{ color: 'var(--blue)' }} role="img" aria-label="live" />;
  if (spec.id === 'changes' && diff)
    return (
      <span className="rm-tab-badge mono">
        <span className="text-green">+{diff.added}</span> <span className="text-red">−{diff.removed}</span>
      </span>
    );
  if (spec.id === 'review' && findings !== null) return <span className="rm-tab-badge mono">{findings}</span>;
  return null;
}

function ExtraLabel({ runId, tile }: { runId: string; tile: LayoutTile }) {
  const meta = useData((s) => describeTile(s, runId, tile).title);
  return <>{meta}</>;
}

/** The focused tile, framed for the pane: the attributes and focus behaviour tiles and commands rely on. */
function PaneTile({
  runId,
  tile,
  label,
  slot,
}: {
  runId: string;
  tile: LayoutTile;
  label: string;
  slot: HTMLElement | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const urgent = useData((s) => describeTile(s, runId, tile).urgent.length > 0);
  // A tile animating out of the pane is no longer the focused one.
  const present = useIsPresent();
  useTakeFocus(ref, present);
  return (
    <section
      ref={ref}
      className="rm-pane-tile"
      tabIndex={-1}
      aria-label={label}
      data-tile-id={tile.id}
      data-tile-kind={tile.kind}
      data-focused={present}
      data-urgent={urgent}
    >
      <div className="tile-body" data-tile-body>
        <TileBody runId={runId} tile={tile} focused visible actionsSlot={slot} />
      </div>
    </section>
  );
}

/** A plan node before execution: what it is for, how it is judged, what it touches, what it waits on. */
function NodeBrief({ runId, node }: { runId: string; node: TaskNode }) {
  return (
    <div className="rm-brief" data-testid="node-brief">
      <p className="rm-brief-note">This task has not started. The plan describes it as follows.</p>
      {node.acceptanceCriteria.length ? (
        <section>
          <h3>Done when</h3>
          <ul className="rm-brief-list">
            {node.acceptanceCriteria.map((c) => (
              <li key={c.id}>
                <span className="mono faint">{c.id}</span> {c.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {node.touches.length ? (
        <section>
          <h3>Touches</h3>
          <ul className="rm-brief-list mono">
            {node.touches.map((t) => (
              <li key={`${t.mode}:${t.glob}`}>
                <span className="faint">{t.mode}</span> {t.glob}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {node.dependsOn.length ? (
        <section>
          <h3>Waits on</h3>
          <p className="rm-brief-deps">
            {node.dependsOn.map((dep) => (
              <button
                key={dep}
                type="button"
                className="btn btn-sm"
                onClick={() => selectStation(runId, taskStation(dep))}
              >
                <span className="mono">{dep}</span>
              </button>
            ))}
          </p>
        </section>
      ) : null}
      <p className="rm-brief-facts">
        Size <span className="mono">{node.size}</span> · risk {node.risk} · {node.kind}
      </p>
    </div>
  );
}

/** What the selected task waits on and what waits on it: the map's lavender links, named. */
function DependencyLine({ runId, node }: { runId: string; node: TaskNode }) {
  const dependents = useData(
    useShallow((s) =>
      (latestPlan(s, runId)?.dag.nodes ?? []).filter((n) => n.dependsOn.includes(node.id)).map((n) => n.id),
    ),
  );
  if (!node.dependsOn.length && !dependents.length) return null;
  const ids = (list: readonly string[]) => (
    <span className="rm-dep-ids">
      {list.map((id, i) => (
        <span key={id}>
          {i > 0 ? ', ' : null}
          <button type="button" className="rm-dep" onClick={() => selectStation(runId, taskStation(id))}>
            {id}
          </button>
        </span>
      ))}
    </span>
  );
  return (
    <p className="rm-pane-links" data-testid="station-deps">
      {node.dependsOn.length ? (
        <span>
          <span className="rm-link-glyph" data-kind="up" aria-hidden="true" />
          Waits on {ids(node.dependsOn)}
        </span>
      ) : null}
      {dependents.length ? (
        <span>
          <span className="rm-link-glyph" data-kind="down" aria-hidden="true" />
          Unblocks {ids(dependents)}
        </span>
      ) : null}
    </p>
  );
}
