/**
 * The implementation lead's pure rules: which plan amendments may apply without a human, and the board
 * digest the lead is woken with.
 */
import { posix } from 'node:path';
import type { TaskNode, TaskStatus } from '@shared/domain';
import type { BoardRow } from './prompts/types';

const GLOB_CHARS = /[*?[\]{}!]/;

/** Directory a touch glob writes in: the literal prefix's directory (`src/api/**` → `src/api`, `README.md` → `.`). */
export function touchDirectory(glob: string): string {
  const match = GLOB_CHARS.exec(glob);
  const literal = match ? glob.slice(0, match.index) : glob;
  const trimmed = literal.replace(/\/+$/, '');
  // `src/api/**` and `docs/`: the literal part up to the glob (or the slash) is the directory itself.
  if (literal.endsWith('/')) return posix.normalize(trimmed) || '.';
  return posix.dirname(trimmed) || '.';
}

const within = (dir: string, parent: string): boolean =>
  parent === '.' ? dir === '.' : dir === parent || dir.startsWith(`${parent}/`);

export const writes = (node: TaskNode): string[] => node.touches.filter((t) => t.mode !== 'read').map((t) => t.glob);

/**
 * Why an amendment needs a human's sign-off, or null when it may apply at once. A new node is in scope when its
 * risk is not high and every write stays inside a directory the approved plan already writes to. A changed
 * node only asks when the change raises it to high risk or adds such a write: rewording a high-risk task (its
 * goal, acceptance criteria, verify commands) was already signed off with that task.
 */
export function amendmentNeedsSignoff(approved: readonly TaskNode[], node: TaskNode): string | null {
  const previous = approved.find((n) => n.id === node.id) ?? null;
  if (node.risk === 'high' && previous?.risk !== 'high') {
    return previous ? `${node.id} becomes high risk` : `${node.id} is high risk`;
  }
  const approvedWrites = new Set(previous ? writes(previous) : []);
  const areas = new Set(
    approved
      .filter((n) => n.id !== node.id)
      .flatMap(writes)
      .map(touchDirectory),
  );
  for (const glob of writes(node)) {
    if (approvedWrites.has(glob)) continue;
    const dir = touchDirectory(glob);
    if (![...areas].some((area) => within(dir, area))) {
      return `${node.id} writes outside the approved plan's area (\`${glob}\`)`;
    }
  }
  return null;
}

export type BoardSnapshot = ReadonlyMap<string, TaskStatus>;

export const boardSnapshot = (board: readonly BoardRow[]): BoardSnapshot =>
  new Map(board.map((row) => [row.nodeId, row.status]));

/** One line per task whose status changed since `previous` (new tasks included). */
export function boardChanges(previous: BoardSnapshot, board: readonly BoardRow[]): string[] {
  const lines: string[] = [];
  for (const row of board) {
    const before = previous.get(row.nodeId);
    if (before === row.status) continue;
    const detail =
      row.status === 'merged' || row.status === 'approved'
        ? row.summary
        : row.status === 'failed' || row.status === 'awaiting_human'
          ? (row.error ?? row.summary)
          : null;
    const head = before ? `${row.nodeId} ${before} → ${row.status}` : `${row.nodeId} added (${row.status})`;
    lines.push(detail ? `${head}: ${detail.trim().split('\n')[0]}` : head);
  }
  return lines;
}

/** Statuses a task must still be in for the lead to amend or cancel it without disturbing an agent. */
export const AMENDABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['blocked', 'queued']);
