/**
 * Inbox ordering (pure): what a decision unblocks. Approvals first (an agent is idle until you answer), then
 * questions, plan sign-offs, conflicts/escalations, PRs ready, budget. Within a kind, items that unblock more
 * downstream tasks come first, then the oldest.
 */
import type { InboxItem, InboxKind, TaskNode } from '@shared/domain';
import { type DataState, latestPlan, tasksOfRun } from '../app/data';

export const KIND_RANK: Record<InboxKind, number> = {
  approval: 0,
  question: 1,
  plan_signoff: 2,
  conflict: 3,
  escalation: 3,
  pr_ready: 4,
  budget: 5,
};

export interface RankedItem {
  item: InboxItem;
  /** Node ids (not yet merged) that transitively wait on this item. */
  blocks: string[];
  /** Short "blocks …" label, or null. */
  blocksLabel: string | null;
}

/** Transitive dependents of `nodeId` in a DAG. */
export function dependentsOf(nodes: readonly Pick<TaskNode, 'id' | 'dependsOn'>[], nodeId: string): string[] {
  const out = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const n of nodes) {
      if (n.dependsOn.includes(current) && !out.has(n.id)) {
        out.add(n.id);
        queue.push(n.id);
      }
    }
  }
  return [...out].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b));
}

function blocksOf(state: DataState, item: InboxItem): { blocks: string[]; label: string | null } {
  const plan = latestPlan(state, item.runId);
  const nodes = plan?.dag.nodes ?? [];
  if (item.kind === 'plan_signoff') {
    const n = nodes.length;
    return { blocks: nodes.map((x) => x.id), label: n ? `blocks ${n} task${n === 1 ? '' : 's'}` : null };
  }
  if (item.kind === 'question' && item.payload.source === 'clarify') return { blocks: [], label: 'blocks the plan' };
  if (item.kind === 'pr_ready' || item.kind === 'budget') return { blocks: [], label: null };
  const task = item.taskId ? state.tasks[item.taskId] : null;
  if (!task) return { blocks: [], label: null };
  const merged = new Set(
    tasksOfRun(state.tasks, item.runId)
      .filter((t) => t.status === 'merged' || t.status === 'skipped')
      .map((t) => t.nodeId),
  );
  const blocks = dependentsOf(nodes, task.nodeId).filter((id) => !merged.has(id));
  if (blocks.length === 0) return { blocks, label: null };
  const label = blocks.length <= 3 ? `blocks ${blocks.join(', ')}` : `blocks ${blocks.length} tasks`;
  return { blocks, label };
}

export function rankInbox(state: DataState, items: readonly InboxItem[]): RankedItem[] {
  return items
    .map((item) => {
      const { blocks, label } = blocksOf(state, item);
      return { item, blocks, blocksLabel: label };
    })
    .sort(
      (a, b) =>
        KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] ||
        b.blocks.length - a.blocks.length ||
        a.item.createdAt - b.item.createdAt,
    );
}

/** A short run label for item context lines: the slug-ish first words of the title. */
export function runLabel(title: string): string {
  const words = title
    .replace(/\(.*?\)/g, '')
    .split(/\s+/)
    .filter(Boolean);
  let short = words[0] ?? '';
  let used = 1;
  for (const word of words.slice(1)) {
    if (`${short} ${word}`.length > 26) break;
    short = `${short} ${word}`;
    used++;
  }
  if (short.length > 26) return `${short.slice(0, 25)}…`;
  return used < words.length ? `${short}…` : short;
}
