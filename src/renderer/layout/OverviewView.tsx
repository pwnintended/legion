/**
 * Overview mode (niri overview / Exposé): every tile of the run as a card, in strip order. Card chrome comes
 * from here; the middle "mini" area is the tile kind's optional `Card` export (tiles/<kind>/index.tsx), or a
 * generic body built from run data.
 */
import { type ComponentType, lazy, Suspense } from 'react';
import type { DataState } from '../app/data';
import { latestPlan, latestReview, mergesOfRun, tasksOfRun, verificationsOfRun } from '../app/data';
import { useAcknowledged, useActivity, useData, useRun, useTileMeta } from '../app/hooks';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { EngineChip, StatusChipView } from '../chrome/ui';
import { criticalPath, depths } from './dag';
import { formatCost, formatDuration, formatTokens, type TileMeta, taskDiffStat } from './describe';
import { KIND_ICON } from './TileFrame';
import { allTiles, type LayoutTile, type Workspace } from './tree';
import type { TileCardProps, TileKind } from './types';

type CardModule = { Card?: ComponentType<TileCardProps> };
const tileModules = import.meta.glob<CardModule>('../tiles/*/index.tsx');
const cardCache = new Map<TileKind, ComponentType<TileCardProps> | null>();

/** The kind's `Card` export (lazy), or null when the tile module has none. */
function cardFor(kind: TileKind): ComponentType<TileCardProps> | null {
  if (cardCache.has(kind)) return cardCache.get(kind) ?? null;
  const loader = tileModules[`../tiles/${kind}/index.tsx`];
  const card = loader
    ? lazy(async () => {
        const mod = await loader();
        return { default: mod.Card ?? GenericCardBody };
      })
    : null;
  cardCache.set(kind, card as ComponentType<TileCardProps> | null);
  return card as ComponentType<TileCardProps> | null;
}

export function OverviewView({ layout }: { layout: Workspace }) {
  const run = useRun(layout.runId);
  const tiles = allTiles(layout);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-[18px]" data-testid="overview">
      <div className="mx-1 mb-3.5 flex items-baseline gap-2.5">
        <span className="text-[15px] font-semibold">{run?.title ?? 'Run'}</span>
        <span className="muted">{tiles.length} tiles · click one to jump there</span>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
        {tiles.map(({ tile }, i) => (
          <OverviewCard
            key={tile.id}
            runId={layout.runId}
            tile={tile}
            focused={layout.focus?.tile === tile.id}
            index={i}
          />
        ))}
      </div>
    </div>
  );
}

function OverviewCard({
  runId,
  tile,
  focused,
  index,
}: {
  runId: string;
  tile: LayoutTile;
  focused: boolean;
  index: number;
}) {
  const meta = useTileMeta(runId, tile);
  const acknowledged = useAcknowledged(meta.urgent.map((i) => i.id));
  const urgent = meta.urgent.length > 0;
  const Card = cardFor(tile.kind);
  return (
    <button
      type="button"
      className="card"
      data-urgent={urgent}
      data-pulse={urgent && !acknowledged}
      data-focused={focused}
      data-quiet={meta.quiet && !urgent}
      style={{ animation: `lg-rise 0.24s var(--ease-out) ${Math.min(index, 12) * 18}ms both` }}
      onClick={() => actions.revealTile(runId, tile.id)}
    >
      <span className="flex min-w-0 items-center gap-2">
        {meta.label ? (
          <span className="tile-id">{meta.label}</span>
        ) : (
          <Icon name={KIND_ICON[tile.kind]} style={{ color: 'var(--subtext0)' }} className="flex-none" />
        )}
        <span className="tile-title flex-1">{meta.title}</span>
        {meta.status ? <StatusChipView status={meta.status} /> : null}
      </span>
      <span className="mini block">
        {Card ? (
          <Suspense fallback={<GenericCardBody tileId={tile.id} kind={tile.kind} runId={runId} params={tile.params} />}>
            <Card tileId={tile.id} kind={tile.kind} runId={runId} params={tile.params} />
          </Suspense>
        ) : (
          <GenericCardBody tileId={tile.id} kind={tile.kind} runId={runId} params={tile.params} />
        )}
      </span>
      <CardFooter meta={meta} />
    </button>
  );
}

function CardFooter({ meta }: { meta: TileMeta }) {
  const a = meta.attempt;
  const stat = useData((s) => {
    const d = meta.task && meta.task.status === 'merged' ? taskDiffStat(s, meta.task) : null;
    return d ? `+${d.added} −${d.removed} · ${d.files} file${d.files === 1 ? '' : 's'}` : null;
  });
  const parts: string[] = stat ? [stat] : [];
  if (a) {
    if (a.status === 'running') parts.push(formatDuration(Date.now() - a.startedAt));
    if (a.costUsd) parts.push(formatCost(a.costUsd));
    else if (a.inputTokens) parts.push(formatTokens(a.inputTokens + (a.outputTokens ?? 0)));
  }
  return (
    <span className="faint flex items-center gap-2 text-[11.5px]">
      {meta.engine ? <EngineChip engine={meta.engine.kind} text={meta.engine.text} /> : null}
      <span className="truncate">{parts.length ? parts.join(' · ') : meta.note}</span>
    </span>
  );
}

/** Generic card body: recent activity for sessions, derived facts for everything else. */
export function GenericCardBody({ tileId, kind, runId, params }: TileCardProps) {
  const tile = { id: tileId, kind, params, auto: true } as LayoutTile;
  const meta = useTileMeta(runId, tile);
  const activity = useActivity(meta.attempt?.id);
  const facts = useData((s) => runFacts(s, runId, kind, meta.task?.id ?? null));
  const lines = kind === 'session' ? sessionLines(meta, activity) : facts.split('\n');
  return (
    <>
      {lines
        .filter(Boolean)
        .slice(0, 3)
        .map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static lines
          <div key={i}>{line}</div>
        ))}
    </>
  );
}

function sessionLines(meta: TileMeta, activity: readonly string[]): string[] {
  if (activity.length > 0) return activity.slice(-3);
  const node = meta.node;
  if (!node) return [meta.note];
  return [
    node.dependsOn.length ? `depends on ${node.dependsOn.join(', ')}` : 'no dependencies',
    node.touches.length ? `touches ${node.touches.map((t) => t.glob).join(', ')}` : node.goal,
    node.verify.commands.length ? `verify: ${node.verify.commands.join(' && ')}` : '',
  ];
}

/** Facts for non-session cards, as one newline-joined string (a stable selector result). */
function runFacts(s: DataState, runId: string, kind: TileKind, taskId: string | null): string {
  const run = s.runs[runId];
  switch (kind) {
    case 'plan':
    case 'dag': {
      const plan = latestPlan(s, runId);
      if (!plan) return 'planner is drafting the DAG';
      const nodes = plan.dag.nodes;
      const perDepth = new Map<number, number>();
      for (const d of depths(nodes).values()) perDepth.set(d, (perDepth.get(d) ?? 0) + 1);
      const parallel = Math.max(0, ...perDepth.values());
      const estimate = plan.dag.annotations.find((a) => a.kind === 'cost_estimate')?.message;
      return [
        `${nodes.length} tasks · ${parallel} parallel max`,
        `critical path ${criticalPath(nodes).join(' → ')}`,
        estimate ?? `${plan.dag.annotations.length} annotations`,
      ].join('\n');
    }
    case 'integration': {
      const merged = tasksOfRun(s.tasks, runId)
        .filter((t) => t.status === 'merged')
        .map((t) => t.nodeId);
      const verify = verificationsOfRun(s.verifications, runId)
        .filter((v) => v.phase === 'post_merge')
        .at(-1);
      const pending = mergesOfRun(s.merges, runId).filter((m) => m.status === 'pending').length;
      return [
        run?.integrationBranch ?? 'integration branch not created yet',
        `merged: ${merged.length ? merged.join(', ') : 'none yet'}${pending ? ` · queue: ${pending}` : ''}`,
        verify
          ? `post-merge verify ${verify.exitCode === 0 ? '✓' : '✕'} ${verify.command}`
          : 'no post-merge verify yet',
      ].join('\n');
    }
    case 'pr': {
      const tasks = tasksOfRun(s.tasks, runId);
      const merged = tasks.filter((t) => t.status === 'merged').length;
      const final = latestReview(s, null, runId);
      return [
        run?.prUrl ?? 'draft PR not opened yet',
        `${merged}/${tasks.length} tasks merged`,
        final ? `final review: ${final.verdict.replace('_', ' ')}` : 'final review pending',
      ].join('\n');
    }
    case 'review': {
      const review = taskId ? latestReview(s, taskId, runId) : null;
      if (!review) return 'waiting for the reviewer';
      const met = review.criteria.filter((c) => c.status === 'met').length;
      const top = review.findings[0];
      return [
        `criteria ${met}/${review.criteria.length} met`,
        top ? `${top.severity}: ${top.title}` : 'no findings',
        review.summary,
      ].join('\n');
    }
    case 'clarify':
      return 'planner has questions before drafting';
    case 'terminal':
      return 'interactive shell';
    default:
      return '';
  }
}
