/**
 * Your review of a task's diff, in the Code view: comments on its hunks, drafted in place and sent back to the
 * task's agent as one message. While its coder works, the review goes into that session (`sessions.send`, after
 * its current turn); while the task waits on you or is approved, it sends the task back to fixing
 * (`tasks.requestChanges`). Drafts survive a reload (localStorage) until sent or deleted.
 */
import type { DiffHunk, DiffLine } from '@shared/rpc';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { DataState } from '../../app/data';
import { rpc } from '../../app/hooks';

export interface ReviewComment {
  id: string;
  taskId: string;
  path: string;
  /** The hunk it is about, by where it starts on the new side (indexes shift when the diff changes). */
  newStart: number;
  /** New-side lines the hunk changes (for the reference the agent reads). */
  start: number;
  end: number;
  /** The changed lines, quoted for the agent (a few at most). */
  quote: string[];
  text: string;
}

interface ReviewState {
  drafts: Record<string, ReviewComment[]>;
  /** The hunk a comment is being written on. */
  composing: { taskId: string; path: string; newStart: number } | null;
}

const KEY = 'legion.review.drafts';

function load(): Record<string, ReviewComment[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, ReviewComment[]>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export const reviewStore = createStore<ReviewState>(() => ({ drafts: load(), composing: null }));

reviewStore.subscribe((s, prev) => {
  if (s.drafts === prev.drafts) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s.drafts));
  } catch {
    // best effort
  }
});

const NONE: ReviewComment[] = [];

export function useDrafts(taskId: string | null): ReviewComment[] {
  return useStore(reviewStore, (s) => (taskId ? (s.drafts[taskId] ?? NONE) : NONE));
}

export function useComposing() {
  return useStore(reviewStore, (s) => s.composing);
}

/** The new-side lines a hunk changes (its whole new range when it only deletes). */
export function changedRange(hunk: DiffHunk): { start: number; end: number } {
  const lines = hunk.lines.filter((l) => l.kind === 'add').map((l) => l.newLine as number);
  if (lines.length === 0) return { start: hunk.newStart, end: hunk.newStart + Math.max(0, hunk.newLines - 1) };
  return { start: Math.min(...lines), end: Math.max(...lines) };
}

function quoteOf(lines: readonly DiffLine[]): string[] {
  const changed = lines.filter((l) => l.kind === 'add' || l.kind === 'del');
  const out = changed.slice(0, 8).map((l) => `${l.kind === 'add' ? '+' : '-'} ${l.text}`);
  if (changed.length > 8) out.push(`… ${changed.length - 8} more changed lines`);
  return out;
}

export function startComment(taskId: string, path: string, newStart: number): void {
  reviewStore.setState({ composing: { taskId, path, newStart } });
}

export function cancelComment(): void {
  reviewStore.setState({ composing: null });
}

export function addComment(taskId: string, path: string, hunk: DiffHunk, text: string): void {
  const body = text.trim();
  if (!body) return;
  const comment: ReviewComment = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    taskId,
    path,
    newStart: hunk.newStart,
    ...changedRange(hunk),
    quote: quoteOf(hunk.lines),
    text: body,
  };
  reviewStore.setState((s) => ({
    composing: null,
    drafts: { ...s.drafts, [taskId]: [...(s.drafts[taskId] ?? []), comment] },
  }));
}

export function deleteComment(taskId: string, id: string): void {
  reviewStore.setState((s) => ({
    drafts: { ...s.drafts, [taskId]: (s.drafts[taskId] ?? []).filter((c) => c.id !== id) },
  }));
}

/** The message the agent reads: every comment with its file, lines and the change it is about. */
export function reviewText(comments: readonly ReviewComment[]): string {
  const parts = comments.map((c, i) => {
    const lines = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`;
    const quote = c.quote.map((q) => `   > ${q}`).join('\n');
    return `${i + 1}. ${c.path}:${lines}\n${quote}\n   ${c.text.replace(/\n/g, '\n   ')}`;
  });
  return `Review of your changes, from the user (${comments.length} comment${comments.length === 1 ? '' : 's'}). Address each one:\n\n${parts.join('\n\n')}`;
}

/** How a review can reach the task's agent right now; `null` with the reason when it can't. */
export function reviewChannel(
  data: DataState,
  taskId: string,
): { kind: 'session'; attemptId: string } | { kind: 'requestChanges' } | { kind: 'none'; reason: string } {
  const task = data.tasks[taskId];
  if (!task) return { kind: 'none', reason: 'The task is gone.' };
  const coder = Object.values(data.attempts).find(
    (a) => a.taskId === taskId && a.status === 'running' && (a.role === 'coder' || a.role === 'resolver'),
  );
  if (coder) return { kind: 'session', attemptId: coder.id };
  if (task.status === 'awaiting_human' || task.status === 'approved') return { kind: 'requestChanges' };
  if (task.status === 'merged') return { kind: 'none', reason: 'Merged: start a new run to change it.' };
  if (task.status === 'reviewing' || task.status === 'verifying')
    return { kind: 'none', reason: 'Its checks and review are running; send once they are done.' };
  return { kind: 'none', reason: `The task is ${task.status.replace('_', ' ')}.` };
}

/** Send the drafted review to the task's agent; the drafts go once it is on its way. */
export async function sendReview(data: DataState, taskId: string): Promise<void> {
  const comments = reviewStore.getState().drafts[taskId] ?? [];
  if (comments.length === 0) return;
  const channel = reviewChannel(data, taskId);
  const text = reviewText(comments);
  if (channel.kind === 'none') throw new Error(channel.reason);
  if (channel.kind === 'session') await rpc('sessions.send', { attemptId: channel.attemptId, text, priority: 'next' });
  else await rpc('tasks.requestChanges', { taskId, feedback: text });
  reviewStore.setState((s) => {
    const { [taskId]: _sent, ...drafts } = s.drafts;
    return { drafts };
  });
}
