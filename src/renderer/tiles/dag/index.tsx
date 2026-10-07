/**
 * DAG tile: the plan's task graph with React Flow + dagre (left→right by depth). While the plan awaits
 * sign-off it is the editor: drag from a node's right handle to another node to add a dependency, ⌫ removes
 * the selected edge or task, E edits the selected task in the inspector. Overlapping writes show up as
 * auto-added serializing edges (dashed peach) with Undo / "give it to T<n>". After approval the graph is
 * read-only with live task status, critical path and active hand-offs.
 */
import '@xyflow/react/dist/base.css';
import { criticalPath as weightedCriticalPath } from '@engine/orchestrator/core/graph';
import type { PlanDag, Task, TaskNode } from '@shared/domain';
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { openInbox, tasksOfRun } from '../../app/data';
import { useData, useLatestPlan, useNow, useRun, useUi } from '../../app/hooks';
import { actions, dataStore } from '../../app/store';
import { Chip, Kbd, StatusChipView } from '../../chrome/ui';
import { describeTile, type StatusChip } from '../../layout/describe';
import type { LayoutTile } from '../../layout/tree';
import type { TileCardProps, TileProps } from '../../layout/types';
import { registerPlanCommands } from '../plan/actions';
import { editPlan, useAnalysis, usePlanDraft } from '../plan/draft';
import { useTileKeys } from '../plan/kit';
import {
  addDependency,
  addNode,
  giveOverlapTo,
  isAutoEdge,
  type Overlap,
  type PlanAnalysis,
  removeDependency,
  removeNode,
} from '../plan/model';
import { DagInspector } from './Inspector';
import { type Arrow, layoutDag, NODE_H, NODE_W, neighbour } from './layout';

registerPlanCommands();

type EdgeKind = 'normal' | 'critical' | 'active' | 'merged' | 'auto';

interface TaskNodeData extends Record<string, unknown> {
  node: TaskNode;
  status: StatusChip | null;
  tone: string | null;
  urgent: boolean;
  pulse: boolean;
  error: boolean;
  editable: boolean;
}
type FlowNode = Node<TaskNodeData, 'task'>;

interface DepEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  from: string;
  to: string;
  editable: boolean;
  onUndo: (from: string, to: string) => void;
}
type FlowEdge = Edge<DepEdgeData, 'dep'>;

const ACTIVE: readonly Task['status'][] = [
  'provisioning',
  'running',
  'verifying',
  'reviewing',
  'fixing',
  'approved',
  'awaiting_human',
  'merging',
];
const URGENT_KINDS = new Set(['approval', 'question', 'escalation', 'conflict']);

export default function DagTile(props: TileProps<'dag'>) {
  return (
    <ReactFlowProvider>
      <DagEditor {...props} />
    </ReactFlowProvider>
  );
}

function DagEditor({ runId, focused, visible }: TileProps<'dag'>) {
  const run = useRun(runId);
  const plan = useLatestPlan(runId);
  const draft = usePlanDraft(runId);
  const editable = !!plan && run?.status === 'awaiting_approval' && plan.approvedAt === null && draft !== null;
  const source: PlanDag | null = editable && draft ? draft.dag : (plan?.dag ?? null);
  const analysis = useAnalysis(source);
  const dag = analysis?.dag ?? source;
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const inspectorTitle = useRef<HTMLInputElement>(null);
  const flow = useReactFlow<FlowNode, FlowEdge>();

  const edit = useCallback(
    (label: string, fn: (dag: PlanDag) => PlanDag) => editPlan(runId, label, (d) => ({ dag: fn(d.dag) })),
    [runId],
  );

  // Flash messages (rejected edges, removals) fade on their own.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4200);
    return () => clearTimeout(t);
  }, [flash]);

  const nodes = dag?.nodes ?? [];
  const shapeKey = nodes.map((n) => `${n.id}<${n.dependsOn.join(',')}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-layout only when the graph's shape changes.
  const positions = useMemo(() => layoutDag(nodes), [shapeKey]);
  const live = useLiveState(runId, nodes, editable);

  // Default selection: the first node, so the inspector is never empty.
  useEffect(() => {
    if (selected && nodes.some((n) => n.id === selected)) return;
    setSelected(nodes[0]?.id ?? null);
  }, [nodes, selected]);

  const critical = useMemo(() => {
    if (!dag) return new Set<string>();
    const done = new Set(
      live.tasks.filter((t) => t.status === 'merged' || t.status === 'skipped').map((t) => t.nodeId),
    );
    const path =
      editable || live.tasks.length === 0
        ? (analysis?.estimate?.criticalPath ?? [])
        : weightedCriticalPath(dag.nodes, (n) => (done.has(n.id) ? 0 : n.size === 'L' ? 4 : n.size === 'M' ? 2 : 1))
            .path;
    const edges = new Set<string>();
    for (let i = 1; i < path.length; i++) edges.add(`${path[i - 1]}->${path[i]}`);
    return edges;
  }, [dag, analysis, editable, live.tasks]);

  const errorNodes = useMemo(() => new Set(analysis?.validation.errors.flatMap((e) => e.nodeIds) ?? []), [analysis]);

  const undoOverlap = useCallback(
    (from: string, to: string) => {
      edit(`undo ${from}→${to}`, (d) => removeDependency(d, from, to));
      setFlash(`${to} no longer waits for ${from}. They may conflict on merge; Legion will resolve or ask you.`);
    },
    [edit],
  );

  const flowNodes: FlowNode[] = useMemo(
    () =>
      nodes.map((node) => {
        const p = positions.get(node.id) ?? { x: 0, y: 0 };
        const s = live.byNode.get(node.id);
        return {
          id: node.id,
          type: 'task',
          position: p,
          width: NODE_W,
          height: NODE_H,
          selected: node.id === selected,
          connectable: editable,
          data: {
            node,
            status: s?.status ?? null,
            tone: s?.tone ?? null,
            urgent: s?.urgent ?? false,
            pulse: s?.pulse ?? false,
            error: errorNodes.has(node.id),
            editable,
          },
        };
      }),
    [nodes, positions, live, selected, editable, errorNodes],
  );

  const flowEdges: FlowEdge[] = useMemo(() => {
    if (!dag) return [];
    const status = (id: string) => live.tasks.find((t) => t.nodeId === id)?.status ?? null;
    return dag.nodes.flatMap((node) =>
      node.dependsOn.map((dep) => {
        const id = `${dep}->${node.id}`;
        const depMerged = status(dep) === 'merged';
        const target = status(node.id);
        let kind: EdgeKind = 'normal';
        if (isAutoEdge(dag, dep, node.id) && (editable || target === null || target === 'blocked')) kind = 'auto';
        else if (depMerged && target !== null && ACTIVE.includes(target)) kind = 'active';
        else if (critical.has(id) && target !== 'merged') kind = 'critical';
        else if (depMerged) kind = 'merged';
        return {
          id,
          source: dep,
          target: node.id,
          type: 'dep',
          selected: id === selectedEdge,
          focusable: editable,
          data: { kind, from: dep, to: node.id, editable, onUndo: undoOverlap },
        };
      }),
    );
  }, [dag, live.tasks, critical, selectedEdge, editable, undoOverlap]);

  // Fit on open, when the graph changes shape, and when the tile resizes.
  const container = useRef<HTMLDivElement>(null);
  const hasGraph = !!run && !!dag;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit on shape changes.
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.08, duration: 260, maxZoom: 1.15 }), 30);
    return () => clearTimeout(t);
  }, [shapeKey, flow, hasGraph]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach once the graph container exists.
  useEffect(() => {
    const el = container.current;
    if (!el || !visible) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flow.fitView({ padding: 0.08, duration: 200, maxZoom: 1.15 }), 120);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [flow, visible, hasGraph]);

  const removeSelected = () => {
    if (!editable || !dag) return false;
    if (selectedEdge) {
      const [from, to] = selectedEdge.split('->') as [string, string];
      edit(`remove ${from}→${to}`, (d) => removeDependency(d, from, to));
      setFlash(`${to} no longer depends on ${from}.`);
      setSelectedEdge(null);
      return true;
    }
    if (selected) {
      const id = selected;
      edit(`remove ${id}`, (d) => removeNode(d, id));
      setFlash(`Removed ${id}. Undo from the plan header.`);
      setSelected(null);
      return true;
    }
    return false;
  };

  useTileKeys(root, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key.startsWith('Arrow')) {
      if (!selected) {
        setSelected(nodes[0]?.id ?? null);
        return true;
      }
      const next = neighbour(positions, selected, e.key as Arrow);
      if (next) {
        setSelected(next);
        setSelectedEdge(null);
      }
      return true;
    }
    if ((e.key === 'e' || e.key === 'E') && selected) {
      inspectorTitle.current?.focus();
      inspectorTitle.current?.select();
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') return removeSelected();
    if (e.key === 'Enter' && selected && !editable) {
      actions.revealTile(runId, `session:${selected}`, null);
      return true;
    }
    if (e.key === 'Escape' && (selected || selectedEdge)) {
      setSelectedEdge(null);
      return false;
    }
    return false;
  });

  if (!run || !dag) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-subtext0">
        The task graph appears once the planner has drafted a plan.
      </div>
    );
  }
  const selectedNode = nodes.find((n) => n.id === selected) ?? null;

  return (
    <div ref={root} className="lg-col" data-testid="dag-tile">
      <ValidationStrip
        analysis={analysis}
        editable={editable}
        focused={focused}
        onAdd={() => {
          const result = addNode(dag, { agent: { engine: 'codex', model: null, effort: null } });
          edit(`add ${result.id}`, () => result.dag);
          setSelected(result.id);
          setTimeout(() => inspectorTitle.current?.focus(), 60);
        }}
      />
      {analysis && analysis.overlaps.length > 0 ? (
        <div className="flex flex-none flex-col gap-1.5 border-b border-[var(--hairline)] px-3.5 py-2">
          {analysis.overlaps.map((o) => (
            <OverlapCallout
              key={`${o.from}-${o.to}`}
              overlap={o}
              editable={editable}
              onUndo={() => undoOverlap(o.from, o.to)}
              onGive={(owner) => {
                edit(`give overlap to ${owner}`, (d) => giveOverlapTo(d, o.from, o.to, owner));
                setFlash(`${owner} now owns ${o.paths.join(', ')}; ${o.to} no longer waits for ${o.from}.`);
              }}
            />
          ))}
        </div>
      ) : null}
      <div ref={container} className="relative min-h-[180px] flex-1">
        <Legend editable={editable} />
        {flash ? (
          <div className="lg-callout absolute right-3 bottom-3 z-10 max-w-[70%]" data-tone="info" role="status">
            <span className="muted">{flash}</span>
          </div>
        ) : null}
        <ReactFlow<FlowNode, FlowEdge>
          className="lg-flow"
          data-editable={editable}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          nodesDraggable={false}
          nodesConnectable={editable}
          elementsSelectable
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnDoubleClick={false}
          panOnScroll
          minZoom={0.35}
          maxZoom={1.6}
          fitView
          fitViewOptions={{ padding: 0.08, maxZoom: 1.15 }}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            setSelected(node.id);
            setSelectedEdge(null);
          }}
          onNodeDoubleClick={(_, node) => {
            if (!editable) actions.revealTile(runId, `session:${node.id}`, null);
            else inspectorTitle.current?.focus();
          }}
          onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
          onPaneClick={() => setSelectedEdge(null)}
          isValidConnection={(c) => c.source !== c.target}
          onConnect={(c) => {
            if (!c.source || !c.target) return;
            const result = addDependency(dag, c.source, c.target);
            if (!result.ok) {
              setFlash(result.reason);
              return;
            }
            edit(`add ${c.source}→${c.target}`, () => result.dag);
            setFlash(`${c.target} now waits for ${c.source}.`);
          }}
        />
      </div>
      {selectedNode ? (
        <DagInspector
          runId={runId}
          dag={dag}
          node={selectedNode}
          editable={editable}
          analysis={analysis}
          titleRef={inspectorTitle}
          onSelect={setSelected}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Live state per node
// ---------------------------------------------------------------------------------------------

interface NodeLive {
  status: StatusChip | null;
  tone: string | null;
  urgent: boolean;
  pulse: boolean;
}

function useLiveState(runId: string, nodes: readonly TaskNode[], editable: boolean) {
  const deps = useData(useShallow((s) => [s.tasks, s.attempts, s.reviews, s.inbox, s.plans, s.diffstats]));
  const acknowledged = useUi((s) => s.acknowledged);
  const now = useNow(15_000, !editable);
  return useMemo(() => {
    const state = dataStore.getState();
    const tasks = tasksOfRun(state.tasks, runId);
    const urgentByTask = new Map<string, string[]>();
    for (const item of openInbox(state.inbox, runId)) {
      if (!item.taskId || !URGENT_KINDS.has(item.kind)) continue;
      urgentByTask.set(item.taskId, [...(urgentByTask.get(item.taskId) ?? []), item.id]);
    }
    const byNode = new Map<string, NodeLive>();
    for (const node of nodes) {
      const task = tasks.find((t) => t.nodeId === node.id);
      if (!task) continue;
      const tile: LayoutTile = {
        id: `session:${node.id}`,
        kind: 'session',
        params: { taskId: task.id, attemptId: null },
        auto: true,
      };
      const meta = describeTile(state, runId, tile, now);
      const urgentIds = urgentByTask.get(task.id) ?? [];
      byNode.set(node.id, {
        status: meta.status,
        tone: meta.tone,
        urgent: urgentIds.length > 0,
        pulse: urgentIds.some((id) => !acknowledged[id]),
      });
    }
    return { tasks, byNode };
  }, [runId, nodes, now, acknowledged, ...deps]);
}

// ---------------------------------------------------------------------------------------------
// Graph parts
// ---------------------------------------------------------------------------------------------

const TaskCard = memo(function TaskCard({ data, selected }: NodeProps<FlowNode>) {
  const { node, status, tone, urgent, pulse, error, editable } = data;
  return (
    <div
      className="lg-node"
      data-selected={selected}
      data-tone={tone === 'ok' || tone === 'run' || tone === 'bad' ? tone : undefined}
      data-urgent={urgent}
      data-pulse={pulse}
      data-error={error}
      data-testid={`dag-node-${node.id}`}
      title={`${node.id} ${node.title}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={editable} />
      <span className="flex items-center gap-1.5">
        <span className="tile-id">{node.id}</span>
        <span
          className="dot"
          style={{ background: node.agent.engine === 'codex' ? 'var(--teal)' : 'var(--mauve)' }}
          title={node.agent.engine}
        />
        {node.risk === 'high' ? (
          <span className="text-[10.5px]" style={{ color: 'var(--peach)' }} title="high risk: waits for you">
            risk
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 justify-end">
          {status ? (
            <StatusChipView status={status} />
          ) : (
            <span className="faint text-[10.5px]">{node.kind === 'feature' ? node.size : node.kind}</span>
          )}
        </span>
      </span>
      <span className="lg-node-title">{node.title}</span>
      <Handle type="source" position={Position.Right} isConnectable={editable} />
    </div>
  );
});

const EDGE_STYLE: Record<EdgeKind, { stroke: string; width: number; dash?: string; opacity?: number }> = {
  normal: { stroke: 'var(--surface2)', width: 2 },
  critical: { stroke: 'var(--lavender)', width: 2.5 },
  active: { stroke: 'var(--blue)', width: 2, dash: '4 6' },
  merged: { stroke: 'var(--green)', width: 2, opacity: 0.55 },
  auto: { stroke: 'var(--peach)', width: 2, dash: '4 4' },
};

function DepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  });
  const kind = data?.kind ?? 'normal';
  const style = EDGE_STYLE[kind];
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={kind === 'active' ? 'flow' : undefined}
        interactionWidth={18}
        style={{
          stroke: selected ? 'var(--mauve)' : style.stroke,
          strokeWidth: selected ? 2.5 : style.width,
          strokeDasharray: style.dash,
          strokeOpacity: style.opacity ?? 1,
        }}
      />
      {kind === 'auto' && data?.editable ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="lg-edge-badge nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={`Added so ${data.to} runs after ${data.from}. Click to undo.`}
            onClick={() => data.onUndo(data.from, data.to)}
          >
            overlap
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const NODE_TYPES = { task: TaskCard };
const EDGE_TYPES = { dep: DepEdge };

function Legend({ editable }: { editable: boolean }) {
  return (
    <div className="faint pointer-events-none absolute top-2.5 left-3.5 z-10 flex gap-3.5 text-[11.5px]">
      <span className="inline-flex items-center gap-1.5">
        <span className="dot" style={{ background: 'var(--mauve)' }} />
        claude
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="dot" style={{ background: 'var(--teal)' }} />
        codex
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block w-4 border-t-2" style={{ borderColor: 'var(--lavender)' }} />
        critical path
      </span>
      {editable ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--peach)' }} />
          added to avoid a conflict
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--blue)' }} />
          active
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Validation strip & overlap callouts
// ---------------------------------------------------------------------------------------------

function ValidationStrip({
  analysis,
  editable,
  focused,
  onAdd,
}: {
  analysis: PlanAnalysis | null;
  editable: boolean;
  focused: boolean;
  onAdd: () => void;
}) {
  if (!analysis) return null;
  const { errors, warnings } = analysis.validation;
  const nodes = analysis.dag.nodes;
  const cycle = errors.find((e) => e.code === 'cycle');
  const missingAc = errors.filter(
    (e) => e.code === 'no_acceptance_criteria' || e.code === 'invalid_acceptance_criterion',
  );
  const missingVerify = errors.filter((e) => e.code === 'no_verify_command');
  const otherErrors = errors.filter((e) => e !== cycle && !missingAc.includes(e) && !missingVerify.includes(e));
  const criteria = nodes.reduce((n, node) => n + node.acceptanceCriteria.length, 0);
  const covered = nodes.filter((n) => n.acceptanceCriteria.length > 0).length;
  const hot = analysis.validation.annotations.filter((a) => a.kind === 'hot_file');
  return (
    <div className="lg-bar flex-wrap" style={{ paddingTop: 9, paddingBottom: 9 }} data-testid="dag-validation">
      {cycle ? (
        <Chip tone="bad" title={cycle.message}>
          ✕ cycle
        </Chip>
      ) : (
        <Chip tone="ok">✓ acyclic</Chip>
      )}
      <Chip
        tone={missingAc.length ? 'bad' : 'ok'}
        title={missingAc.map((e) => e.message).join('\n') || `${criteria} acceptance criteria`}
      >
        {missingAc.length ? '✕' : '✓'} {covered}/{nodes.length} tasks have acceptance criteria
      </Chip>
      <Chip tone={missingVerify.length ? 'bad' : 'ok'} title={missingVerify.map((e) => e.message).join('\n')}>
        {missingVerify.length ? `✕ ${missingVerify.length} without verify` : '✓ every task has a verify command'}
      </Chip>
      {otherErrors.length ? (
        <Chip tone="bad" title={otherErrors.map((e) => e.message).join('\n')}>
          {otherErrors.length} error{otherErrors.length === 1 ? '' : 's'}
        </Chip>
      ) : null}
      {hot.length ? (
        <Chip tone="warn" title={hot.map((h) => ('reason' in h ? h.reason : '')).join('\n')}>
          {hot.length} hot file{hot.length === 1 ? '' : 's'}
        </Chip>
      ) : null}
      {warnings.length ? (
        <Chip tone="idle" title={warnings.map((w) => w.message).join('\n')}>
          {warnings.length} warning{warnings.length === 1 ? '' : 's'}
        </Chip>
      ) : null}
      <span className="flex-1" />
      {editable ? (
        <>
          <span className="faint hidden items-center gap-1.5 text-[11.5px] @[560px]:inline-flex">
            drag to rewire · <Kbd>E</Kbd> edit · <Kbd>⌫</Kbd> remove
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onAdd} title="Add a task">
            + Task
          </button>
        </>
      ) : (
        <span className="faint text-[11.5px]">{focused ? '←→ select · ⏎ open session' : 'read-only · approved'}</span>
      )}
    </div>
  );
}

function OverlapCallout({
  overlap,
  editable,
  onUndo,
  onGive,
}: {
  overlap: Overlap;
  editable: boolean;
  onUndo: () => void;
  onGive: (owner: string) => void;
}) {
  const paths = overlap.paths.slice(0, 2);
  return (
    <div className="lg-callout" data-testid="overlap-callout">
      <span style={{ color: 'var(--peach)' }}>Overlap</span>
      <span className="muted min-w-0 flex-1">
        {overlap.from} and {overlap.to} both write{' '}
        {paths.map((p, i) => (
          <span key={p}>
            {i > 0 ? ', ' : ''}
            <span className="mono text-[11.5px] text-text">{p}</span>
          </span>
        ))}
        {overlap.paths.length > 2 ? ` +${overlap.paths.length - 2}` : ''}, so {overlap.to} now runs after {overlap.from}
      </span>
      {editable ? (
        <>
          <button type="button" className="btn btn-ghost" onClick={onUndo} title="Run them in parallel anyway">
            Undo
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onGive(overlap.giveTo ?? overlap.from)}
            title="Move the shared files to one task so both can run in parallel"
          >
            Give it to {overlap.giveTo ?? overlap.from}
          </button>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------------------------

export function Card({ runId }: TileCardProps<'dag'>) {
  const plan = useLatestPlan(runId);
  const analysis = useAnalysis(plan?.dag ?? null);
  if (!plan || !analysis) return <div>no plan yet</div>;
  const layers = analysis.validation.layers?.length ?? 0;
  return (
    <>
      <div>
        {plan.dag.nodes.length} tasks · {layers} layers
      </div>
      <div>critical path {(analysis.estimate?.criticalPath ?? []).join(' → ')}</div>
      <div>
        {analysis.overlaps.length
          ? `${analysis.overlaps.length} edge${analysis.overlaps.length === 1 ? '' : 's'} added for overlaps`
          : analysis.validation.ok
            ? 'valid · no overlaps'
            : `${analysis.validation.errors.length} problems`}
      </div>
    </>
  );
}
