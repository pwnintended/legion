/**
 * Agents mode: the run's route map. One trunk from Plan to Pull request on the left, tasks hanging off it in
 * waves (route.ts); the selected station fills the pane on the right (StationPane.tsx). The station you follow
 * stays lit while you change tabs; only the part of the run still moving is open. The run's layout tree is the
 * model (stations.ts): the focused tile is the pane, so jumps, approvals and ⌘⏎ keep working.
 */
import type { EngineKind, InboxItem } from '@shared/domain';
import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type CommandContext, registerCommands } from '../app/commands';
import { attemptsOfRun, latestPlan, messagesOfRun, openInbox, tasksOfRun } from '../app/data';
import { useData, useLayout, useUi } from '../app/hooks';
import { dataStore, uiStore } from '../app/store';
import { Icon } from '../chrome/icons';
import { displayEngine, ENGINE_LABEL, taskEngine } from '../layout/describe';
import { focusedTile, type Workspace } from '../layout/tree';
import { WorkspaceSkeleton } from '../layout/Workspace';
import {
  buildWaves,
  foldMap,
  type MapItem,
  type RouteCounts,
  type RouteRow,
  type RowState,
  routeCounts,
  rowOrder,
  type StationKey,
  stageWord,
  stationNode,
  taskStation,
  type Wave,
  waveLabel,
} from './route';
import { StationPane } from './StationPane';
import { activeTab, openTab, selectedStation, selectStation, stationTabs } from './stations';
import './route.css';

const URGENT_KINDS: readonly InboxItem['kind'][] = ['approval', 'question', 'escalation', 'conflict'];
/** Under this width the map folds into a bar above the pane. */
const NARROW_PX = 900;

interface Route {
  waves: Wave[];
  counts: RouteCounts;
  maxFix: number;
  engines: Map<string, { coder: EngineKind; reviewer: EngineKind | null }>;
  crew: { roles: string[]; messages: number } | null;
  planVersion: number | null;
}

function useRoute(runId: string): Route {
  const inputs = useData(
    useShallow((s) => [s.plans, s.tasks, s.inbox, s.attempts, s.messages, s.settings, s.runs[runId]]),
  );
  return useMemo(() => {
    void inputs;
    const data = dataStore.getState();
    const plan = latestPlan(data, runId);
    const tasks = tasksOfRun(data.tasks, runId);
    const nodeOfTask = new Map(tasks.map((t) => [t.id, t.nodeId]));
    const waiting = new Set<string>();
    for (const item of openInbox(data.inbox, runId)) {
      if (!item.taskId || !URGENT_KINDS.includes(item.kind)) continue;
      if (item.kind === 'question' && item.payload.source === 'clarify') continue;
      const nodeId = nodeOfTask.get(item.taskId);
      if (nodeId) waiting.add(nodeId);
    }
    const waves = buildWaves(
      plan?.dag.nodes ?? [],
      new Map(tasks.map((t) => [t.nodeId, { id: t.id, status: t.status, fixRounds: t.fixRounds }])),
      waiting,
    );
    const attempts = attemptsOfRun(data.attempts, runId);
    const engines = new Map<string, { coder: EngineKind; reviewer: EngineKind | null }>();
    for (const task of tasks) {
      const own = attempts.filter((a) => a.taskId === task.id);
      const coder = own.filter((a) => a.role === 'coder' || a.role === 'resolver').at(-1) ?? null;
      const reviewer = own.filter((a) => a.role === 'reviewer').at(-1) ?? null;
      engines.set(task.nodeId, {
        coder: taskEngine(data, coder),
        reviewer: reviewer ? displayEngine(data, reviewer) : null,
      });
    }
    const coordinators = attempts.filter((a) => a.taskId === null && a.role !== 'planner' && a.role !== 'finalizer');
    const roles = [...new Set(coordinators.map((a) => a.role))];
    return {
      waves,
      counts: routeCounts(waves),
      maxFix: data.settings?.limits.maxFixRounds ?? 2,
      engines,
      crew: roles.length ? { roles, messages: messagesOfRun(data.messages, runId).length } : null,
      planVersion: plan?.version ?? null,
    };
  }, [inputs, runId]);
}

/** Stations in map order, for ⌘⌥J / ⌘⌥K. */
function stationOrder(route: Route): StationKey[] {
  return [
    ...(route.crew ? (['crew'] as StationKey[]) : []),
    'plan',
    ...rowOrder(route.waves).map(taskStation),
    'integration',
    'pr',
  ];
}

/** Is the element (a callback ref's target) narrower than the map needs? */
function useNarrow(el: HTMLElement | null): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return narrow;
}

export function RouteMap({ runId }: { runId: string }) {
  const layout = useLayout(runId);
  const mapNode = useUi((s) => s.mapNode[runId] ?? null);
  const station = useData((s) => (layout ? selectedStation(s, layout, mapNode) : 'plan'));
  const route = useRoute(runId);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrow(root);
  const [mapOpen, setMapOpen] = useState(false);

  // Picking a station from the folded map closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every station change
  useEffect(() => setMapOpen(false), [station]);

  if (!layout) return <WorkspaceSkeleton />;
  const map = <MapPanel runId={runId} layout={layout} route={route} station={station} />;
  return (
    <div ref={setRoot} className="route" data-workspace={runId} data-narrow={narrow} data-testid="route-map">
      {narrow ? (
        <div className="rm-bar-wrap">
          <button
            type="button"
            className="rm-bar"
            aria-expanded={mapOpen}
            onClick={() => setMapOpen((o) => !o)}
            data-testid="route-bar"
          >
            <Icon name="dag" size={14} />
            <BarStation runId={runId} station={station} />
            <CountsLine counts={route.counts} />
            <Icon name="chevronDown" size={14} className="rm-bar-chevron" />
          </button>
          {mapOpen ? <div className="rm-pop">{map}</div> : null}
        </div>
      ) : (
        map
      )}
      <StationPane runId={runId} layout={layout} station={station} mapNode={mapNode} />
    </div>
  );
}

const STATION_LABEL = { crew: 'Crew', plan: 'Plan', integration: 'Integration', pr: 'Pull request' } as const;

/** The folded map's name for the station on screen: "T9 Tax rates sync", "Plan". */
function BarStation({ runId, station }: { runId: string; station: StationKey }) {
  const nodeId = stationNode(station);
  const title = useData((s) =>
    nodeId ? (latestPlan(s, runId)?.dag.nodes.find((n) => n.id === nodeId)?.title ?? null) : null,
  );
  return (
    <span className="rm-bar-station">
      {nodeId ? (
        <>
          <span className="mono">{nodeId}</span> {title}
        </>
      ) : (
        STATION_LABEL[station as keyof typeof STATION_LABEL]
      )}
    </span>
  );
}

function CountsLine({ counts, onJump }: { counts: RouteCounts; onJump?: (state: RowState) => void }) {
  if (counts.tasks === 0) return <span className="rm-counts-text">No tasks yet</span>;
  const parts: React.ReactNode[] = [<span key="n">{counts.tasks} tasks</span>];
  if (counts.working) parts.push(<span key="w">{counts.working} working</span>);
  const jump = (state: RowState, n: number, word: string, tone: string) =>
    onJump ? (
      <button
        key={state}
        type="button"
        className="rm-count-jump"
        data-tone={tone}
        onClick={() => onJump(state)}
        title={`Next ${word} task`}
      >
        {n} {word}
      </button>
    ) : (
      <span key={state} data-tone={tone} className="rm-count-jump">
        {n} {word}
      </span>
    );
  if (counts.waiting) parts.push(jump('waiting', counts.waiting, 'waiting', 'warn'));
  if (counts.failed) parts.push(jump('failed', counts.failed, 'failed', 'bad'));
  if (!counts.working && !counts.waiting && !counts.failed && counts.done === counts.tasks)
    parts.push(<span key="d">all merged</span>);
  return (
    <span className="rm-counts-text">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: separators between fixed parts
        <span key={i}>
          {i > 0 ? <span className="rm-sep"> · </span> : null}
          {p}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------

function MapPanel({
  runId,
  layout,
  route,
  station,
}: {
  runId: string;
  layout: Workspace;
  route: Route;
  station: StationKey;
}) {
  const run = useData((s) => s.runs[runId]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const selectedNode = stationNode(station);
  const items = useMemo(() => foldMap(route.waves, selectedNode, expanded), [route.waves, selectedNode, expanded]);
  const listRef = useRef<HTMLOListElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const overflow = useOverflow(scroller, listRef);
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const keepTab = () => {
    const tile = focusedTile(layout);
    const data = dataStore.getState();
    return activeTab(stationTabs(data, runId, station), tile)?.id ?? null;
  };
  const select = (next: StationKey) => selectStation(runId, next, keepTab());
  const jumpTo = (state: RowState) => {
    const rows = route.waves.flatMap((w) => w.rows).filter((r) => r.state === state);
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.nodeId === selectedNode);
    const next = rows[(at + 1) % rows.length] as RouteRow;
    select(taskStation(next.nodeId));
  };

  // Keyboard travel inside the map: ↑↓ / J K move between stops and rows and select the rows they land on.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };
    const step = keys[e.key];
    if (step === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
    const panel = (e.currentTarget as HTMLElement).closest('.rm-map');
    const focusables = [...(panel?.querySelectorAll<HTMLButtonElement>('[data-map-stop]') ?? [])];
    const at = focusables.indexOf(document.activeElement as HTMLButtonElement);
    const next = focusables[Math.max(0, Math.min(focusables.length - 1, (at === -1 ? 0 : at) + step))];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
    const target = next.dataset.station as StationKey | undefined;
    if (target) select(target);
  };

  if (!run) return null;
  const waiting = (s: StationKey) => station === s;
  return (
    <nav className="rm-map" aria-label="Route map" data-testid="route-panel" data-keeps-focus onKeyDown={onKeyDown}>
      <header className="rm-head">
        <h2 className="rm-title" title={run.title}>
          {run.title}
        </h2>
        <p className="rm-counts">
          <CountsLine counts={route.counts} onJump={jumpTo} />
        </p>
        {route.crew ? (
          <button
            type="button"
            className="rm-crew"
            aria-current={station === 'crew' || undefined}
            onClick={() => select('crew')}
            data-map-stop
            data-station="crew"
          >
            <Icon name="agents" size={13} />
            <span>{route.crew.roles.map((r) => ROLE_NAME[r] ?? r).join(', ')}</span>
            <span className="rm-sep">·</span>
            <span className="mono">{route.crew.messages}</span>
            <span>{route.crew.messages === 1 ? 'message' : 'messages'}</span>
            {station === 'crew' ? <motion.span layoutId={`rm-lit-${runId}`} className="rm-lit" /> : null}
          </button>
        ) : null}
      </header>
      <div className="rm-scroll" ref={setScroller} data-overflow={overflow || undefined}>
        <div className="rm-line-wrap">
          <ol className="rm-line" ref={listRef}>
            <Terminus runId={runId} station="plan" selected={waiting('plan')} onSelect={select} />
            {items.map((item) => (
              <MapEntry
                key={item.key}
                runId={runId}
                item={item}
                route={route}
                selectedNode={selectedNode}
                onSelect={select}
                onToggle={toggle}
              />
            ))}
            {route.waves.length === 0 ? (
              <li className="rm-item rm-note">The plan's tasks appear here once it is drafted.</li>
            ) : null}
          </ol>
          <DependencyLinks listRef={listRef} route={route} selectedNode={selectedNode} items={items} />
        </div>
      </div>
      {/* The run's last two stops stay in view however long the map is. */}
      <ol className="rm-line rm-line-end">
        <Terminus runId={runId} station="integration" selected={waiting('integration')} onSelect={select} />
        <Terminus runId={runId} station="pr" selected={waiting('pr')} onSelect={select} last />
      </ol>
    </nav>
  );
}

const ROLE_NAME: Record<string, string> = {
  assistant: 'Assistant',
  lead: 'Lead',
  research_lead: 'Research lead',
  researcher: 'Researchers',
  resolver: 'Resolver',
};

/** Does the scroller hold more than it shows? (Its edge then fades.) */
function useOverflow(scroller: HTMLElement | null, listRef: React.RefObject<HTMLElement | null>): boolean {
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () => setOverflow(scroller.scrollHeight > scroller.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(list);
    return () => observer.disconnect();
  }, [scroller, listRef]);
  return overflow;
}

function Marker({ state, size = 'row' }: { state: RowState | 'current' | 'wave-live'; size?: 'row' | 'stop' }) {
  return (
    <span className="rm-marker" data-state={state} data-size={size} aria-hidden="true">
      {state === 'done' ? <Icon name="check" size={size === 'stop' ? 12 : 10} strokeWidth={3} /> : null}
      {state === 'live' || state === 'current' ? <span className="rm-marker-core" /> : null}
    </span>
  );
}

function Terminus({
  runId,
  station,
  selected,
  onSelect,
  last,
}: {
  runId: string;
  station: 'plan' | 'integration' | 'pr';
  selected: boolean;
  onSelect: (s: StationKey) => void;
  last?: boolean;
}) {
  const info = useData(
    useShallow((s) => {
      const run = s.runs[runId];
      if (!run) return null;
      const plan = latestPlan(s, runId);
      const open = openInbox(s.inbox, runId);
      const status = run.status;
      if (station === 'plan') {
        const clarify = open.some((i) => i.kind === 'question' && i.payload.source === 'clarify');
        const signoff = open.some((i) => i.kind === 'plan_signoff');
        const early = ['chatting', 'draft', 'clarifying', 'planning'].includes(status);
        const state: RowState | 'current' = clarify || signoff ? 'waiting' : early ? 'current' : 'done';
        const title = plan ? `Plan · v${plan.version}` : 'Plan';
        const caption = clarify
          ? 'Questions for you'
          : signoff
            ? 'Waiting for your sign-off'
            : plan?.approvedAt
              ? `Signed off · ${plan.dag.nodes.length} tasks`
              : status === 'chatting'
                ? 'Not started'
                : 'Being drafted';
        return { state, title, caption };
      }
      if (station === 'integration') {
        const stuck = open.some((i) => i.taskId === null && (i.kind === 'escalation' || i.kind === 'conflict'));
        const state: RowState | 'current' = stuck
          ? 'waiting'
          : status === 'integrating' || status === 'finalizing'
            ? 'current'
            : status === 'pr_ready' || status === 'done'
              ? 'done'
              : 'pending';
        const caption =
          status === 'integrating'
            ? 'Running the checks'
            : status === 'finalizing'
              ? 'Final review'
              : state === 'done'
                ? 'Checks passed'
                : 'Checks on the merged branch';
        return { state, title: 'Integration', caption };
      }
      const ready = open.some((i) => i.kind === 'pr_ready');
      const state: RowState | 'current' = ready ? 'waiting' : status === 'done' ? 'done' : 'pending';
      const caption = ready
        ? 'Ready for you'
        : status === 'done'
          ? run.pr?.number
            ? `#${run.pr.number} ${run.pr.state}`
            : 'Opened'
          : 'A draft for your review';
      return { state, title: 'Pull request', caption };
    }),
  );
  if (!info) return null;
  return (
    <li className="rm-item rm-terminus" data-state={info.state} data-last={last || undefined}>
      <button
        type="button"
        className="rm-stop"
        aria-current={selected || undefined}
        onClick={() => onSelect(station)}
        data-map-stop
        data-station={station}
        data-testid={`route-${station}`}
      >
        <Marker state={info.state} size="stop" />
        <span className="rm-stop-text">
          <span className="rm-stop-title">{info.title}</span>
          <span className="rm-stop-caption" data-state={info.state}>
            {info.caption}
          </span>
        </span>
      </button>
      {selected ? <motion.span layoutId={`rm-lit-${runId}`} className="rm-lit" /> : null}
    </li>
  );
}

function MapEntry({
  runId,
  item,
  route,
  selectedNode,
  onSelect,
  onToggle,
}: {
  runId: string;
  item: MapItem;
  route: Route;
  selectedNode: string | null;
  onSelect: (s: StationKey) => void;
  onToggle: (key: string) => void;
}) {
  switch (item.kind) {
    case 'wave-folded': {
      const label = waveLabel(item.wave);
      return (
        <li className="rm-item rm-fold" data-holds={item.wave.rows.map((r) => r.nodeId).join(' ')}>
          <button
            type="button"
            className="rm-stop"
            aria-expanded={false}
            onClick={() => onToggle(`wave:${item.wave.index}`)}
            data-map-stop
          >
            <Marker state="done" size="stop" />
            <span className="rm-fold-text">
              <span className="rm-stop-title">{label.title}</span>
              <span className="rm-sep">·</span>
              <span className="rm-fold-detail">{label.detail}</span>
            </span>
            <Icon name="chevronRight" size={13} className="rm-chevron" />
          </button>
        </li>
      );
    }
    case 'wave-head': {
      const label = waveLabel(item.wave);
      const state = item.wave.phase === 'done' ? 'done' : item.wave.phase === 'active' ? 'wave-live' : 'pending';
      const content = (
        <>
          <Marker state={state} size="stop" />
          <span className="rm-fold-text">
            <span className="rm-stop-title">{label.title}</span>
            <span className="rm-sep">·</span>
            <span className="rm-fold-detail">{label.detail}</span>
          </span>
          {item.foldable ? <Icon name="chevronDown" size={13} className="rm-chevron" /> : null}
        </>
      );
      const key = item.wave.phase === 'ahead' ? `closed:wave:${item.wave.index}` : `wave:${item.wave.index}`;
      return (
        <li className="rm-item rm-wave-head" data-phase={item.wave.phase}>
          {item.foldable ? (
            <button type="button" className="rm-stop" aria-expanded onClick={() => onToggle(key)} data-map-stop>
              {content}
            </button>
          ) : (
            <div className="rm-stop rm-stop-static">{content}</div>
          )}
        </li>
      );
    }
    case 'merged-fold':
      return (
        <li
          className="rm-item rm-bus-item rm-merged"
          data-holds={item.rows.map((r) => r.nodeId).join(' ')}
          data-bus="first"
        >
          <button
            type="button"
            className="rm-row rm-merged-row"
            aria-expanded={false}
            onClick={() => onToggle(`merged:${item.wave.index}`)}
            data-map-stop
          >
            <Marker state="done" />
            <span className="rm-merged-text">{item.rows.length} merged</span>
            <Icon name="chevronRight" size={12} className="rm-chevron" />
          </button>
        </li>
      );
    case 'later': {
      const tasks = item.waves.reduce((n, w) => n + w.rows.length, 0);
      return (
        <li
          className="rm-item rm-fold rm-later"
          data-holds={item.waves.flatMap((w) => w.rows.map((r) => r.nodeId)).join(' ')}
        >
          <button
            type="button"
            className="rm-stop"
            aria-expanded={false}
            onClick={() => onToggle('later')}
            data-map-stop
          >
            <Marker state="pending" size="stop" />
            <span className="rm-fold-text">
              <span className="rm-stop-title">
                Then {item.waves.length} {item.waves.length === 1 ? 'wave' : 'waves'}
              </span>
              <span className="rm-sep">·</span>
              <span className="rm-fold-detail">
                {tasks} {tasks === 1 ? 'task' : 'tasks'}
              </span>
            </span>
            <Icon name="chevronRight" size={13} className="rm-chevron" />
          </button>
        </li>
      );
    }
    case 'row':
      return <RowEntry runId={runId} item={item} route={route} selectedNode={selectedNode} onSelect={onSelect} />;
  }
}

function RowEntry({
  runId,
  item,
  route,
  selectedNode,
  onSelect,
}: {
  runId: string;
  item: Extract<MapItem, { kind: 'row' }>;
  route: Route;
  selectedNode: string | null;
  onSelect: (s: StationKey) => void;
}) {
  const { row, solo, dim, dense } = item;
  const selected = row.nodeId === selectedNode;
  const selectedRow = selectedNode ? route.waves.flatMap((w) => w.rows).find((r) => r.nodeId === selectedNode) : null;
  const related = selectedRow && (selectedRow.deps.includes(row.nodeId) || selectedRow.dependents.includes(row.nodeId));
  const engines = route.engines.get(row.nodeId);
  const bus = solo ? undefined : busPosition(item);
  const stage = stageWord(row, route.maxFix);
  const dots =
    engines && row.task && row.state !== 'pending' ? (
      <>
        <span className="rm-edot" data-engine={engines.coder} title={`${ENGINE_LABEL[engines.coder]} codes`} />
        {engines.reviewer ? (
          <span
            className="rm-edot"
            data-engine={engines.reviewer}
            title={`${ENGINE_LABEL[engines.reviewer]} reviews`}
          />
        ) : null}
      </>
    ) : null;
  const shared = {
    'data-state': row.state,
    'aria-current': selected || undefined,
    'aria-label': `${row.nodeId} ${row.title}: ${stage}`,
    onClick: () => onSelect(taskStation(row.nodeId)),
    'data-map-stop': true,
    'data-station': taskStation(row.nodeId),
    'data-testid': `route-row-${row.nodeId}`,
  } as const;
  return (
    <li
      className={`rm-item ${solo ? 'rm-solo' : 'rm-bus-item'}`}
      data-bus={bus}
      data-dim={dim || undefined}
      data-dense={dense || undefined}
      data-critical={row.critical || undefined}
      data-related={related || undefined}
      data-node={row.nodeId}
    >
      {solo ? (
        // A wave of one task is a stop on the trunk: the task, and its wave under it.
        <button type="button" className="rm-stop rm-solo-stop" {...shared}>
          <Marker state={row.state} size="stop" />
          <span className="rm-stop-text">
            <span className="rm-stop-title">
              <span className="rm-id mono">{row.nodeId}</span>
              <span className="rm-name">{row.title}</span>
            </span>
            <span className="rm-stop-caption">
              Wave {item.wave.index}
              <span className="rm-sep"> · </span>
              <span className="rm-stage" data-state={row.state}>
                {stage}
              </span>
            </span>
          </span>
          <span className="rm-engines" aria-hidden="true">
            {dots}
          </span>
        </button>
      ) : (
        <button type="button" className="rm-row" {...shared}>
          <Marker state={row.state} />
          <span className="rm-id mono">{row.nodeId}</span>
          <span className="rm-name" title={row.title}>
            {row.title}
          </span>
          <span className="rm-stage" data-state={row.state}>
            {stage}
          </span>
          <span className="rm-engines" aria-hidden="true">
            {dots}
          </span>
        </button>
      )}
      {selected ? <motion.span layoutId={`rm-lit-${runId}`} className="rm-lit" transition={LIT_SPRING} /> : null}
    </li>
  );
}

const LIT_SPRING = { type: 'spring', stiffness: 800, damping: 2 * Math.sqrt(800) } as const;

/** Where a row sits among its wave's rows (the last one closes the branch group). */
function busPosition(item: Extract<MapItem, { kind: 'row' }>): 'mid' | 'last' {
  return item.wave.rows.at(-1)?.nodeId === item.row.nodeId ? 'last' : 'mid';
}

/** The gutter column the links run in (left of the trunk), and their corner radius. */
const LINK_X = 9;
const LINK_R = 6;

/** A straight link with rounded corners: left from one ring into the gutter, along it, and right to the other. */
function linkPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dir = to.y > from.y ? 1 : -1;
  const r = Math.min(LINK_R, Math.abs(to.y - from.y) / 2);
  return [
    `M ${from.x} ${from.y}`,
    `H ${LINK_X + r}`,
    `Q ${LINK_X} ${from.y} ${LINK_X} ${from.y + dir * r}`,
    `V ${to.y - dir * r}`,
    `Q ${LINK_X} ${to.y} ${LINK_X + r} ${to.y}`,
    `H ${to.x}`,
  ].join(' ');
}

/**
 * The selected task's real dependency edges, drawn only for it: straight links in the gutter to the rows it
 * waits on (solid) and the rows waiting on it (dashed), or to the folded line that holds them. Nothing else is
 * wired.
 */
function DependencyLinks({
  listRef,
  route,
  selectedNode,
  items,
}: {
  listRef: React.RefObject<HTMLOListElement | null>;
  route: Route;
  selectedNode: string | null;
  items: MapItem[];
}) {
  const [paths, setPaths] = useState<{ d: string; key: string; up: boolean }[]>([]);
  const [height, setHeight] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: folding (items) moves the rows the links end on
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = selectedNode ? route.waves.flatMap((w) => w.rows).find((r) => r.nodeId === selectedNode) : null;
    if (!list || !row) {
      setPaths([]);
      return;
    }
    const measure = () => {
      const base = list.getBoundingClientRect();
      /** The left edge and centre of the ring that stands for a node (its row, or the folded line holding it). */
      const ringOf = (nodeId: string): { x: number; y: number } | null => {
        const el =
          list.querySelector<HTMLElement>(`[data-node="${nodeId}"]`) ??
          [...list.querySelectorAll<HTMLElement>('[data-holds]')].find((h) =>
            h.dataset.holds?.split(' ').includes(nodeId),
          ) ??
          null;
        const ring = el?.querySelector<HTMLElement>('.rm-marker');
        if (!ring) return null;
        const box = ring.getBoundingClientRect();
        return { x: box.left - base.left - 1, y: box.top - base.top + box.height / 2 };
      };
      const from = ringOf(row.nodeId);
      if (!from) return setPaths([]);
      const seen = new Set<number>();
      const out: { d: string; key: string; up: boolean }[] = [];
      for (const [ids, up] of [
        [row.deps, true],
        [row.dependents, false],
      ] as const)
        for (const id of ids) {
          const to = ringOf(id);
          if (!to || seen.has(Math.round(to.y)) || Math.abs(to.y - from.y) < 1) continue;
          seen.add(Math.round(to.y));
          out.push({ key: `${up ? 'u' : 'd'}:${id}`, up, d: linkPath(from, to) });
        }
      setPaths(out);
      setHeight(list.scrollHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, route, selectedNode, items]);
  if (!paths.length) return null;
  return (
    <svg className="rm-links" width={60} height={height} aria-hidden="true">
      {paths.map((p) => (
        <path key={p.key} d={p.d} data-up={p.up} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Keyboard: ⌘⌥J/K walk the stations, ⌘⌥H/L the tabs (the agents view only; the code view's strip owns them)
// ---------------------------------------------------------------------------------------------

const onMap = (ctx: CommandContext) => ctx.ui.view === 'agents' && ctx.activeRunId !== null && ctx.ui.overlay === null;

function currentRoute(runId: string): { order: StationKey[]; station: StationKey } | null {
  const data = dataStore.getState();
  const ui = uiStore.getState();
  const layout = ui.layouts[runId];
  if (!layout) return null;
  const plan = latestPlan(data, runId);
  const tasks = tasksOfRun(data.tasks, runId);
  const waves = buildWaves(
    plan?.dag.nodes ?? [],
    new Map(tasks.map((t) => [t.nodeId, { id: t.id, status: t.status, fixRounds: t.fixRounds }])),
    new Set(),
  );
  const crew = attemptsOfRun(data.attempts, runId).some(
    (a) => a.taskId === null && a.role !== 'planner' && a.role !== 'finalizer',
  );
  const order = stationOrder({ waves, crew: crew ? { roles: [], messages: 0 } : null } as Route);
  return { order, station: selectedStation(data, layout, ui.mapNode[runId] ?? null) };
}

function stepStation(ctx: CommandContext, delta: number): void {
  const runId = ctx.activeRunId as string;
  const at = currentRoute(runId);
  if (!at) return;
  const index = at.order.indexOf(at.station);
  const next = at.order[Math.max(0, Math.min(at.order.length - 1, index + delta))];
  if (!next || next === at.station) return;
  const layout = ctx.ui.layouts[runId];
  const keep = layout ? activeTab(stationTabs(ctx.data, runId, at.station), focusedTile(layout))?.id : null;
  selectStation(runId, next, keep ?? null);
}

function stepTab(ctx: CommandContext, delta: number): void {
  const runId = ctx.activeRunId as string;
  const at = currentRoute(runId);
  const layout = ctx.ui.layouts[runId];
  if (!at || !layout) return;
  const tabs = stationTabs(ctx.data, runId, at.station);
  const current = activeTab(tabs, focusedTile(layout));
  const index = current ? tabs.indexOf(current) : -1;
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next) openTab(runId, next);
}

registerCommands([
  {
    id: 'map.next',
    title: 'Next station on the route map',
    category: 'Focus',
    keybinding: ['Mod+Alt+J', 'Mod+Alt+Down'],
    repeatable: true,
    when: onMap,
    run: (ctx) => stepStation(ctx, 1),
  },
  {
    id: 'map.prev',
    title: 'Previous station on the route map',
    category: 'Focus',
    keybinding: ['Mod+Alt+K', 'Mod+Alt+Up'],
    repeatable: true,
    when: onMap,
    run: (ctx) => stepStation(ctx, -1),
  },
  {
    id: 'map.tabNext',
    title: 'Next tab of the station',
    category: 'Focus',
    keybinding: ['Mod+Alt+L', 'Mod+Alt+Right'],
    when: onMap,
    run: (ctx) => stepTab(ctx, 1),
  },
  {
    id: 'map.tabPrev',
    title: 'Previous tab of the station',
    category: 'Focus',
    keybinding: ['Mod+Alt+H', 'Mod+Alt+Left'],
    when: onMap,
    run: (ctx) => stepTab(ctx, -1),
  },
]);
