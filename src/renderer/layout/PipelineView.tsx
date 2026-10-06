/**
 * Pipeline mode: the run's DAG laid out in columns by depth, with positioned cards and SVG edges.
 * Critical path (remaining work) in lavender, active hand-offs as flowing dashes, the PR as the sink.
 * (The editable React Flow DAG lives in tiles/dag; this is the read-only bird's-eye view.)
 */
import type { TaskNode } from '@shared/domain';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mergesOfRun, tasksOfRun, verificationsOfRun } from '../app/data';
import { useAcknowledged, useData, useLatestPlan, useRun, useTileMeta } from '../app/hooks';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { Chip, EngineChip, StatusChipView } from '../chrome/ui';
import { compareNodeIds, criticalPath, depths } from './dag';
import { allTiles, type LayoutTile, type Workspace } from './tree';

const MAX_NODE_W = 220;
const NODE_H = 84;
const MAX_COL_W = 280;
const MIN_COL_W = 236;
const ROW_H = 158;
const PAD_X = 40;
const PAD_Y = 24;
const PR_W = 110;

interface Placed {
  node: TaskNode;
  x: number;
  y: number;
}

function place(
  nodes: readonly TaskNode[],
  COL_W: number,
): {
  placed: Map<string, Placed>;
  width: number;
  height: number;
  maxDepth: number;
} {
  const depth = depths(nodes);
  const maxDepth = Math.max(0, ...depth.values());
  const byDepth: TaskNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const node of nodes) byDepth[depth.get(node.id) ?? 0]?.push(node);
  const maxRows = Math.max(1, ...byDepth.map((c) => c.length));
  const placed = new Map<string, Placed>();
  byDepth.forEach((column, d) => {
    // Order by the average row of dependencies (fewer crossings), then by id.
    const rowOf = (n: TaskNode) => {
      const ys = n.dependsOn.map((dep) => placed.get(dep)?.y).filter((y): y is number => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    };
    column.sort((a, b) => rowOf(a) - rowOf(b) || compareNodeIds(a.id, b.id));
    const offset = ((maxRows - column.length) * ROW_H) / 2;
    column.forEach((node, i) => {
      placed.set(node.id, { node, x: PAD_X + d * COL_W, y: PAD_Y + offset + i * ROW_H });
    });
  });
  return {
    placed,
    width: PAD_X + (maxDepth + 1) * COL_W + PR_W,
    height: PAD_Y * 2 + maxRows * ROW_H - (ROW_H - NODE_H),
    maxDepth,
  };
}

export function PipelineView({ layout }: { layout: Workspace }) {
  const plan = useLatestPlan(layout.runId);
  const run = useRun(layout.runId);
  const tasks = useData((s) => tasksOfRun(s.tasks, layout.runId));
  const nodes = plan?.dag.nodes ?? [];
  // Fit the columns to the available width (between MIN and MAX column pitch).
  const container = useRef<HTMLDivElement>(null);
  const hasPlan = plan !== null;
  const [available, setAvailable] = useState(1200);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when the container element changes.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth - 36);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasPlan]);
  const depthCount = useMemo(() => Math.max(0, ...depths(nodes).values()) + 1, [nodes]);
  const COL_W = Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.floor((available - PAD_X - PR_W - 8) / depthCount)));
  const NODE_W = Math.min(MAX_NODE_W, COL_W - 56);
  const geometry = useMemo(() => place(nodes, COL_W), [nodes, COL_W]);
  const statusOf = (nodeId: string) => tasks.find((t) => t.nodeId === nodeId)?.status ?? null;
  const remainingCritical = useMemo(() => {
    const done = new Set(tasks.filter((t) => t.status === 'merged' || t.status === 'skipped').map((t) => t.nodeId));
    return criticalPath(nodes, (id) => (done.has(id) ? 0 : 1));
  }, [nodes, tasks]);
  const critEdges = new Set(remainingCritical.slice(1).map((id, i) => `${remainingCritical[i]}→${id}`));
  const sinks = nodes.filter((n) => !nodes.some((m) => m.dependsOn.includes(n.id)));
  const tileFor = (nodeId: string): LayoutTile =>
    allTiles(layout).find(({ tile }) => tile.id === `session:${nodeId}`)?.tile ?? {
      id: `session:${nodeId}`,
      kind: 'session',
      params: { taskId: tasks.find((t) => t.nodeId === nodeId)?.id ?? null, attemptId: null },
      auto: true,
    };
  const prX = PAD_X + (geometry.maxDepth + 1) * COL_W;
  const prY = geometry.height / 2 - 28;
  const runDone = run?.status === 'done' || run?.prUrl;

  if (!plan) {
    return (
      <div ref={container} className="flex flex-1 items-center justify-center text-subtext0" data-testid="pipeline">
        The pipeline appears once the planner has drafted a DAG.
      </div>
    );
  }

  return (
    <div ref={container} className="min-h-0 flex-1 overflow-auto p-[18px]" data-testid="pipeline">
      <div className="mx-1 mb-2.5 flex flex-wrap items-center gap-4">
        <span className="text-[15px] font-semibold">Pipeline</span>
        <span className="muted">Columns by DAG depth · plan v{plan.version}</span>
        <span className="muted inline-flex items-center gap-1.5 text-xs">
          <span className="inline-block h-0.5 w-[18px] bg-lavender" />
          critical path
        </span>
        <span className="muted inline-flex items-center gap-1.5 text-xs">
          <span className="inline-block w-[18px] border-t-2 border-dashed border-blue" />
          active
        </span>
        <span className="muted inline-flex items-center gap-1.5 text-xs">
          <span className="inline-block h-0.5 w-[18px] bg-green/60" />
          merged
        </span>
      </div>
      <div className="relative" style={{ width: geometry.width, height: geometry.height }}>
        <svg
          width={geometry.width}
          height={geometry.height}
          className="absolute inset-0"
          fill="none"
          aria-hidden="true"
        >
          {nodes.flatMap((node) =>
            node.dependsOn.map((dep) => {
              const from = geometry.placed.get(dep);
              const to = geometry.placed.get(node.id);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              const depMerged = statusOf(dep) === 'merged';
              const target = statusOf(node.id);
              const active =
                depMerged &&
                target !== null &&
                !['blocked', 'queued', 'merged', 'skipped', 'cancelled'].includes(target);
              const crit = critEdges.has(`${dep}→${node.id}`);
              const stroke = active
                ? 'var(--blue)'
                : crit
                  ? 'var(--lavender)'
                  : depMerged
                    ? 'var(--green)'
                    : 'var(--surface2)';
              return (
                <path
                  key={`${dep}-${node.id}`}
                  d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`}
                  stroke={stroke}
                  strokeOpacity={depMerged && !active && !crit ? 0.55 : 1}
                  strokeWidth={crit ? 2.5 : 2}
                  className={active ? 'flow' : undefined}
                />
              );
            }),
          )}
          {sinks.map((node) => {
            const from = geometry.placed.get(node.id);
            if (!from) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const y2 = prY + 28;
            const mx = (x1 + prX) / 2;
            const crit = remainingCritical.at(-1) === node.id;
            return (
              <path
                key={`${node.id}-pr`}
                d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${prX} ${y2}`}
                stroke={crit ? 'var(--lavender)' : 'var(--surface2)'}
                strokeWidth={crit ? 2.5 : 2}
              />
            );
          })}
        </svg>
        {[...geometry.placed.values()].map(({ node, x, y }) => (
          <PipelineNode
            key={node.id}
            runId={layout.runId}
            node={node}
            tile={tileFor(node.id)}
            x={x}
            y={y}
            width={NODE_W}
            critical={remainingCritical.includes(node.id)}
            hasTask={statusOf(node.id) !== null}
            inLayout={allTiles(layout).some(({ tile }) => tile.id === `session:${node.id}`)}
          />
        ))}
        <div
          className="absolute box-border flex items-center justify-center gap-2 rounded-[28px] border-[1.5px] font-semibold"
          style={{
            left: prX,
            top: prY,
            width: PR_W,
            height: 56,
            borderStyle: runDone ? 'solid' : 'dashed',
            borderColor: runDone ? 'var(--green)' : 'var(--lavender)',
            color: runDone ? 'var(--green)' : 'var(--lavender)',
          }}
        >
          <Icon name="pr" />
          PR
        </div>
      </div>
      <IntegrationStrip runId={layout.runId} />
    </div>
  );
}

function PipelineNode({
  runId,
  node,
  tile,
  x,
  y,
  width,
  critical,
  hasTask,
  inLayout,
}: {
  runId: string;
  node: TaskNode;
  tile: LayoutTile;
  x: number;
  y: number;
  width: number;
  critical: boolean;
  hasTask: boolean;
  inLayout: boolean;
}) {
  const meta = useTileMeta(runId, tile);
  const acknowledged = useAcknowledged(meta.urgent.map((i) => i.id));
  const urgent = meta.urgent.length > 0;
  const engine = meta.engine?.kind ?? node.agent.engine;
  const tone = meta.task?.status === 'merged' ? 'ok' : meta.status?.tone === 'run' ? 'run' : undefined;
  return (
    <button
      type="button"
      className="pnode"
      style={{ left: x, top: y, width }}
      data-tone={tone}
      data-crit={critical && !urgent && tone === undefined}
      data-urgent={urgent}
      data-pulse={urgent && !acknowledged}
      data-quiet={meta.quiet && tone !== 'ok'}
      disabled={!inLayout}
      onClick={() => actions.revealTile(runId, tile.id)}
      aria-label={`${node.id} ${node.title}`}
    >
      <span className="flex items-center gap-2">
        <span className="tile-id">{node.id}</span>
        <EngineChip engine={engine} />
        <span className="ml-auto">
          {hasTask && meta.status ? <StatusChipView status={meta.status} /> : <Chip tone="idle">planned</Chip>}
        </span>
      </span>
      <span className="tile-title">{node.title}</span>
    </button>
  );
}

function IntegrationStrip({ runId }: { runId: string }) {
  const tasks = useData((s) => tasksOfRun(s.tasks, runId));
  const merges = useData((s) => mergesOfRun(s.merges, runId));
  const verify = useData((s) =>
    verificationsOfRun(s.verifications, runId)
      .filter((v) => v.phase === 'post_merge' || v.phase === 'final')
      .at(-1),
  );
  if (tasks.length === 0) return null;
  const merged = tasks.filter((t) => t.status === 'merged');
  const waiting = tasks.filter((t) => ['approved', 'merging', 'reviewing', 'fixing'].includes(t.status));
  return (
    <div className="mono mx-1 mt-1 flex max-w-[1300px] flex-wrap items-center gap-[18px] rounded-[10px] border border-[var(--hairline)] bg-mantle px-3.5 py-2.5 text-xs">
      <span className="faint">integration</span>
      {merged.map((t) => (
        <span key={t.id} className="text-green">
          ● {t.nodeId} merged
        </span>
      ))}
      {waiting.map((t) => (
        <span key={t.id} className="muted">
          ○ {t.nodeId}{' '}
          {t.status === 'merging' ? 'merging' : t.status === 'approved' ? 'in merge queue' : 'waits on review'}
        </span>
      ))}
      {merges.some((m) => m.status === 'conflict') ? <span className="text-red">conflict</span> : null}
      <span
        className="ml-auto"
        style={{ color: verify ? (verify.exitCode === 0 ? 'var(--green)' : 'var(--red)') : 'var(--overlay2)' }}
      >
        {verify ? `post-merge verify ${verify.exitCode === 0 ? '✓' : '✕'}` : 'no merges yet'}
      </span>
    </div>
  );
}
