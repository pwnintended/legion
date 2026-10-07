/**
 * What the generic tile frame, thin columns, overview cards, the minimap and the pipeline show about a tile:
 * id, title, engine chip, status chip, urgency. Pure: derived from the client data store.
 */
import type { Attempt, EngineKind, InboxItem, Plan, Task, TaskNode, TaskStatus } from '@shared/domain';
import { type PullRequestInfo, runPr } from '../app/compat';
import {
  attemptsOfRun,
  type DataState,
  latestAttempt,
  latestPlan,
  latestReview,
  mergesOfRun,
  messagesOfRun,
  openInbox,
  tasksOfRun,
  verificationsOfRun,
} from '../app/data';
import type { LayoutTile } from './tree';
import type { TileKind } from './types';

export type Tone = 'claude' | 'codex' | 'ok' | 'run' | 'warn' | 'bad' | 'idle' | 'accent';

export interface StatusChip {
  label: string;
  tone: Tone;
  /** Something is happening right now (breathing dot). */
  live: boolean;
}

export interface TileMeta {
  /** Short id shown in mono before the title (`T2`), or null. */
  label: string | null;
  title: string;
  engine: { kind: EngineKind; text: string } | null;
  status: StatusChip | null;
  /** Open inbox items that point at this tile (oldest first). */
  urgent: InboxItem[];
  /** One-line note for thin columns and card footers (`merged · +212 −8`, `waits on T2 T3`). */
  note: string;
  /** Not started yet / no longer relevant: rendered faded when thin. */
  quiet: boolean;
  /** Minimap / pipeline colour. */
  tone: Tone;
  task: Task | null;
  node: TaskNode | null;
  /** Latest attempt relevant to the tile (coder for sessions, reviewer for reviews). */
  attempt: Attempt | null;
}

export const ENGINE_LABEL: Record<EngineKind, string> = { claude: 'claude', codex: 'codex', fake: 'fake' };
export const ENGINE_NAME: Record<EngineKind, string> = { claude: 'Claude Code', codex: 'Codex', fake: 'Fake engine' };
export const engineTone = (engine: EngineKind): Tone => (engine === 'codex' ? 'codex' : 'claude');
export const otherEngine = (engine: EngineKind): EngineKind => (engine === 'claude' ? 'codex' : 'claude');

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatCost(usd: number): string {
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
}

const DONE: readonly TaskStatus[] = ['merged', 'skipped', 'cancelled'];
const URGENT_TASK_KINDS: readonly InboxItem['kind'][] = ['approval', 'question', 'escalation', 'conflict'];

export function taskNode(plan: Plan | null, nodeId: string): TaskNode | null {
  return plan?.dag.nodes.find((n) => n.id === nodeId) ?? null;
}

/**
 * The engine to show for a task. In fake mode (`LEGION_FAKE_ENGINES=1`) attempts record engine `fake`; the UI
 * shows the engine the plan (or an override) assigned instead.
 */
/** `draft PR #412 open`, `PR #398 merged`, ... */
export function prLabel(pr: PullRequestInfo): string {
  const n = pr.number ? ` #${pr.number}` : '';
  if (pr.state === 'open') return `${pr.isDraft ? 'draft PR' : 'PR'}${n} open`;
  return `PR${n} ${pr.state}`;
}

export function taskEngine(task: Task, node: TaskNode | null, attempt: Attempt | null): EngineKind {
  const real = (e: EngineKind | null | undefined) => (e && e !== 'fake' ? e : null);
  return real(attempt?.engine) ?? real(task.engineOverride) ?? node?.agent.engine ?? 'claude';
}

/** Display engine of any attempt (see `taskEngine`): fake-mode attempts show the engine their role implies. */
export function displayEngine(
  state: DataState,
  attempt: Attempt | null | undefined,
  fallback: EngineKind = 'claude',
): EngineKind {
  if (!attempt) return fallback;
  if (attempt.engine !== 'fake') return attempt.engine;
  const task = attempt.taskId ? state.tasks[attempt.taskId] : null;
  const node = task ? (taskNode(latestPlan(state, attempt.runId), task.nodeId) ?? null) : null;
  const planned = task ? taskEngine(task, node, null) : null;
  const configured = (role: 'planner' | 'finalizer' | 'researcher' | 'research_lead', otherwise: EngineKind) => {
    const engine = state.settings?.roles[role].engine;
    return engine && engine !== 'fake' ? engine : otherwise;
  };
  switch (attempt.role) {
    case 'coder':
    case 'resolver':
      return planned ?? fallback;
    case 'reviewer':
      return otherEngine(planned ?? fallback);
    case 'planner':
    case 'lead':
    case 'assistant': {
      const engine = state.runs[attempt.runId]?.plannerEngine;
      return engine && engine !== 'fake' ? engine : configured('planner', 'claude');
    }
    case 'finalizer':
      return configured('finalizer', 'codex');
    case 'researcher':
    case 'research_lead':
      return configured(attempt.role, 'claude');
  }
}

/** Does an open inbox item belong to this tile? */
export function itemTargetsTile(item: InboxItem, tile: LayoutTile, taskIdOfTile: string | null): boolean {
  switch (tile.kind) {
    case 'session':
      return taskIdOfTile !== null && item.taskId === taskIdOfTile && URGENT_TASK_KINDS.includes(item.kind)
        ? !(item.kind === 'question' && item.payload.source === 'clarify')
        : false;
    case 'clarify':
      return item.kind === 'question' && item.payload.source === 'clarify';
    case 'plan':
      return item.kind === 'plan_signoff';
    case 'pr':
      return item.kind === 'pr_ready';
    case 'integration':
      return item.taskId === null && (item.kind === 'escalation' || item.kind === 'conflict');
    default:
      return false;
  }
}

export function tileTaskId(tile: LayoutTile): string | null {
  if (tile.kind === 'session') return (tile.params as { taskId: string | null }).taskId;
  if (tile.kind === 'review') return (tile.params as { taskId: string | null }).taskId;
  return null;
}

function taskStatusChip(
  state: DataState,
  task: Task,
  coder: Attempt | null,
  reviewer: Attempt | null,
  deps: string[],
  now: number,
): StatusChip {
  const since = coder?.startedAt ?? task.updatedAt;
  switch (task.status) {
    case 'blocked':
      return { label: deps.length ? `waits ${deps.join(' ')}` : 'blocked', tone: 'idle', live: false };
    case 'queued':
      return { label: 'queued', tone: 'idle', live: false };
    case 'provisioning':
      return { label: 'provisioning', tone: 'run', live: true };
    case 'running':
      return { label: `running ${formatDuration(now - since)}`, tone: 'run', live: true };
    case 'verifying':
      return { label: 'verifying', tone: 'run', live: true };
    case 'reviewing': {
      const engine = reviewer ? displayEngine(state, reviewer) : otherEngine(taskEngine(task, null, coder));
      return { label: `${ENGINE_LABEL[engine]} reviewing`, tone: engineTone(engine), live: true };
    }
    case 'fixing':
      return { label: `fixing ${task.fixRounds}/2`, tone: engineTone(taskEngine(task, null, coder)), live: true };
    case 'approved':
      return { label: 'approved', tone: 'ok', live: false };
    case 'awaiting_human':
      return { label: 'needs you', tone: 'warn', live: false };
    case 'merging':
      return { label: 'merging', tone: 'run', live: true };
    case 'merged':
      return { label: 'merged', tone: 'ok', live: false };
    case 'failed':
      return { label: 'failed', tone: 'bad', live: false };
    case 'skipped':
      return { label: 'skipped', tone: 'idle', live: false };
    case 'cancelled':
      return { label: 'cancelled', tone: 'idle', live: false };
  }
}

const TONE_FOR_STATUS: Partial<Record<TaskStatus, Tone>> = {
  running: 'run',
  provisioning: 'run',
  verifying: 'run',
  merging: 'run',
  approved: 'ok',
  merged: 'ok',
  failed: 'bad',
  awaiting_human: 'warn',
};

/** Lines added/removed over all coder attempts of a task (from live `file_change` events). */
export function taskDiffStat(state: DataState, task: Task): { added: number; removed: number; files: number } | null {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  for (const attempt of attemptsOfRun(state.attempts, task.runId)) {
    if (attempt.taskId !== task.id || attempt.role === 'reviewer') continue;
    const stat = state.diffstats[attempt.id];
    if (!stat) continue;
    added += stat.added;
    removed += stat.removed;
    for (const f of stat.files) files.add(f);
  }
  return added || removed ? { added, removed, files: files.size } : null;
}

/**
 * The part of the diff stats a tile's meta depends on, as a primitive (for selectors): the `+/−` of a merged
 * task's session/review tile, '' otherwise. A `file_change` elsewhere leaves it unchanged, so it doesn't
 * re-render every tile.
 */
export function tileDiffStatKey(state: DataState, tile: LayoutTile): string {
  const taskId = tileTaskId(tile);
  const task = taskId ? state.tasks[taskId] : undefined;
  if (task?.status !== 'merged') return '';
  const stat = taskDiffStat(state, task);
  return stat ? `${stat.added}:${stat.removed}:${stat.files}` : '-';
}

export function describeTile(state: DataState, runId: string, tile: LayoutTile, now: number = Date.now()): TileMeta {
  const plan = latestPlan(state, runId);
  const run = state.runs[runId] ?? null;
  const inbox = openInbox(state.inbox, runId);
  const taskId = tileTaskId(tile);
  const task = taskId ? (state.tasks[taskId] ?? null) : null;
  const urgent = inbox.filter((item) => itemTargetsTile(item, tile, taskId));
  const pr = runPr(run);
  const base: TileMeta = {
    label: null,
    title: TITLES[tile.kind],
    engine: null,
    status: null,
    urgent,
    note: '',
    quiet: false,
    tone: 'idle',
    task,
    node: null,
    attempt: null,
  };

  switch (tile.kind) {
    case 'session':
    case 'review': {
      if (!task) return { ...base, title: tile.kind === 'review' ? 'Review' : 'Session', note: 'task not loaded' };
      const node = taskNode(plan, task.nodeId);
      const coder = latestAttempt(state, task, 'coder');
      const reviewer = latestAttempt(state, task, 'reviewer');
      const engine = taskEngine(task, node, coder);
      const tasks = tasksOfRun(state.tasks, runId);
      const pendingDeps = (node?.dependsOn ?? []).filter(
        (dep) => tasks.find((t) => t.nodeId === dep)?.status !== 'merged',
      );
      let status = taskStatusChip(state, task, coder, reviewer, pendingDeps, now);
      if (urgent.length > 0 && tile.kind === 'session') status = { label: 'needs you', tone: 'warn', live: false };
      let note = status.label;
      // Diff stats only show on merged tasks (keep `tileDiffStatKey` in step with this).
      if (task.status === 'merged') {
        const stat = taskDiffStat(state, task);
        note = stat ? `merged · +${stat.added} −${stat.removed}` : 'merged';
      } else if (task.status === 'blocked' && pendingDeps.length) note = `waits on ${pendingDeps.join(' ')}`;
      else if (task.progress) note = task.progress;
      const effort = task.effortOverride ?? coder?.effort ?? node?.agent.effort ?? null;
      if (tile.kind === 'review') {
        const review = latestReview(state, task.id, runId);
        const reviewerEngine = reviewer ? displayEngine(state, reviewer) : otherEngine(engine);
        let reviewStatus: StatusChip;
        if (reviewer?.status === 'running' || task.status === 'reviewing')
          reviewStatus = {
            label: `${ENGINE_LABEL[reviewerEngine]} reviewing`,
            tone: engineTone(reviewerEngine),
            live: true,
          };
        else if (review?.verdict === 'approve') reviewStatus = { label: 'approved', tone: 'ok', live: false };
        else if (review?.verdict === 'request_changes')
          reviewStatus = { label: 'changes requested', tone: 'warn', live: false };
        else if (review?.verdict === 'reject_replan') reviewStatus = { label: 'rejected', tone: 'bad', live: false };
        else reviewStatus = { label: 'pending', tone: 'idle', live: false };
        return {
          ...base,
          label: null,
          title: `Review · ${task.nodeId}`,
          engine: { kind: reviewerEngine, text: ENGINE_LABEL[reviewerEngine] },
          status: reviewStatus,
          note: review?.summary ?? reviewStatus.label,
          tone: engineTone(reviewerEngine),
          task,
          node,
          attempt: reviewer,
        };
      }
      return {
        ...base,
        label: task.nodeId,
        title: node?.title ?? task.nodeId,
        engine: { kind: engine, text: effort ? `${ENGINE_LABEL[engine]} · ${effort}` : ENGINE_LABEL[engine] },
        status,
        note,
        quiet: task.status === 'blocked' || task.status === 'queued' || DONE.includes(task.status),
        tone:
          urgent.length > 0
            ? 'warn'
            : task.status === 'reviewing' || task.status === 'fixing'
              ? engineTone(engine)
              : (TONE_FOR_STATUS[task.status] ?? 'idle'),
        task,
        node,
        attempt: coder,
      };
    }
    case 'plan': {
      if (!plan) {
        const drafting = run?.status === 'planning' || run?.status === 'clarifying' || run?.status === 'draft';
        return {
          ...base,
          status: drafting ? { label: 'drafting', tone: 'run', live: true } : null,
          note: drafting ? 'planner is reading the repo' : 'no plan yet',
          tone: drafting ? 'run' : 'idle',
        };
      }
      const status: StatusChip = plan.approvedAt
        ? { label: `v${plan.version} · approved ${formatClock(plan.approvedAt)}`, tone: 'ok', live: false }
        : urgent.length > 0
          ? { label: `v${plan.version} · needs sign-off`, tone: 'warn', live: false }
          : run?.status === 'planning'
            ? { label: `v${plan.version} · revising`, tone: 'run', live: true }
            : { label: `v${plan.version}`, tone: 'idle', live: false };
      return {
        ...base,
        title: 'Plan',
        status,
        note: plan.approvedAt
          ? `drafted by ${run?.plannerEngine ?? 'planner'} · ${plan.source === 'user' ? 'edited by you' : 'as proposed'}`
          : 'waiting for your sign-off',
        tone: urgent.length > 0 ? 'warn' : 'accent',
      };
    }
    case 'dag':
      return {
        ...base,
        status: plan ? { label: `${plan.dag.nodes.length} tasks`, tone: 'idle', live: false } : null,
        note: plan ? `${plan.dag.nodes.length} tasks · ${plan.dag.annotations.length} notes` : 'no plan yet',
        tone: 'accent',
      };
    case 'integration': {
      const tasks = tasksOfRun(state.tasks, runId);
      const merged = tasks.filter((t) => t.status === 'merged').length;
      const merges = mergesOfRun(state.merges, runId);
      const failedVerify = verificationsOfRun(state.verifications, runId)
        .filter((v) => v.phase === 'post_merge' || v.phase === 'final')
        .at(-1);
      const red = failedVerify ? failedVerify.exitCode !== 0 : false;
      const merging = merges.some((m) => m.status === 'pending');
      const status: StatusChip = red
        ? { label: 'verify failed', tone: 'bad', live: false }
        : merging
          ? { label: 'merging', tone: 'run', live: true }
          : { label: `${merged}/${tasks.length} merged`, tone: merged > 0 ? 'ok' : 'idle', live: false };
      return { ...base, status, note: pr ? prLabel(pr) : 'PR: not yet', tone: status.tone };
    }
    case 'pr': {
      const status: StatusChip = pr
        ? {
            label: prLabel(pr),
            tone: pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'idle' : 'ok',
            live: false,
          }
        : urgent.length > 0
          ? { label: 'ready for you', tone: 'warn', live: false }
          : run?.status === 'finalizing'
            ? { label: 'final review', tone: 'run', live: true }
            : { label: 'not yet', tone: 'idle', live: false };
      return { ...base, status, note: pr?.url ?? status.label, tone: status.tone };
    }
    case 'clarify':
      return {
        ...base,
        status:
          urgent.length > 0
            ? { label: 'needs you', tone: 'warn', live: false }
            : { label: 'answered', tone: 'ok', live: false },
        note: 'planner questions',
        tone: urgent.length > 0 ? 'warn' : 'idle',
      };
    case 'agents': {
      const agents = attemptsOfRun(state.attempts, runId);
      const live = agents.filter((a) => a.status === 'running').length;
      return {
        ...base,
        status: { label: `${live} live`, tone: live > 0 ? 'run' : 'idle', live: live > 0 },
        note: `${agents.length} agent${agents.length === 1 ? '' : 's'}`,
        tone: live > 0 ? 'run' : 'idle',
      };
    }
    case 'messages': {
      const all = messagesOfRun(state.messages, runId);
      const queued = all.filter((m) => m.deliveredAt === null).length;
      return {
        ...base,
        status: { label: `${all.length}`, tone: queued > 0 ? 'warn' : 'idle', live: false },
        note: queued > 0 ? `${queued} queued` : 'between agents',
        tone: queued > 0 ? 'warn' : 'idle',
      };
    }
    case 'terminal': {
      const params = tile.params as { cwd: string | null; attemptId: string | null };
      const cwd = params.cwd?.split('/').filter(Boolean).at(-1) ?? null;
      return { ...base, title: params.attemptId ? 'Takeover' : 'Terminal', note: cwd ?? 'shell', label: null };
    }
    case 'diff': {
      const target = (tile.params as { target: { kind: string; sha?: string } }).target;
      if (target.kind === 'commit' && target.sha)
        return { ...base, title: `Commit ${target.sha.slice(0, 7)}`, note: 'commit diff' };
      return { ...base, note: 'changes' };
    }
    case 'project':
    case 'activity':
    case 'files':
      return { ...base, note: state.projects[(tile.params as { projectId: string }).projectId]?.name ?? '' };
    case 'code': {
      const params = tile.params as { path: string; line: number | null; endLine: number | null };
      const slash = params.path.lastIndexOf('/');
      return {
        ...base,
        title: params.path.slice(slash + 1) || params.path,
        note: slash === -1 ? '' : params.path.slice(0, slash),
      };
    }
    case 'search': {
      const query = (tile.params as { query: string }).query;
      return { ...base, note: query ? `“${query}”` : 'search the project' };
    }
  }
}

export const TITLES: Record<TileKind, string> = {
  plan: 'Plan',
  dag: 'DAG',
  session: 'Session',
  review: 'Review',
  diff: 'Diff',
  terminal: 'Terminal',
  pr: 'Pull request',
  integration: 'Integration',
  clarify: 'Clarify',
  agents: 'Agents',
  messages: 'Messages',
  project: 'Overview',
  activity: 'Activity',
  files: 'Files',
  code: 'File',
  search: 'Search',
};
