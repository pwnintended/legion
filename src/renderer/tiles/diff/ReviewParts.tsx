/**
 * Reviewing a task's diff in place: actions on each hunk (comment, revert), the comment box under a hunk, your
 * drafted comments, and the review bar that sends them to the task's agent or approves the merge.
 */
import type { Task } from '@shared/domain';
import type { DiffHunk } from '@shared/rpc';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useData } from '../../app/hooks';
import { dataStore } from '../../app/store';
import { Icon } from '../../chrome/icons';
import { Kbd } from '../../chrome/ui';
import { toast } from '../../overlays/nav';
import { approveMerge } from '../review/index';
import { addComment, cancelComment, deleteComment, type ReviewComment, reviewChannel, sendReview } from './review';

/** A hunk's header, with what you can do about the hunk while reviewing a task. */
export function HunkHead({
  file,
  hunk,
  status,
  active,
  review,
}: {
  file: string;
  hunk: DiffHunk;
  status: string;
  active: boolean;
  review: {
    onComment: () => void;
    onRevert: () => void;
    /** Why reverting is not possible right now (null: it is). */
    revertBlocked: string | null;
  } | null;
}) {
  return (
    <div className="lg-hunk lg-hunk-row" data-active={active}>
      <span className="lg-hunk-range">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{' '}
        <span className="faint">{hunk.header || (status === 'added' ? 'new file' : '')}</span>
      </span>
      {review ? (
        <span className="lg-hunk-actions">
          <button
            type="button"
            className="lg-hunk-btn"
            onClick={review.onComment}
            title={`Comment on this change in ${file}  c`}
            data-testid="hunk-comment"
          >
            <Icon name="chat" size={12} />
            Comment
          </button>
          <button
            type="button"
            className="lg-hunk-btn"
            onClick={review.onRevert}
            disabled={review.revertBlocked !== null}
            title={review.revertBlocked ?? `Take this change back out of the task's worktree`}
            data-testid="hunk-revert"
          >
            <Icon name="refresh" size={12} />
            Revert
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** Writing a comment on a hunk: ⌘⏎ adds it to your review, Esc puts it away. */
export function ComposeBox({ taskId, path, hunk }: { taskId: string; path: string; hunk: DiffHunk }) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    el?.focus({ preventScroll: true });
    // It opens under the hunk, which may be near the bottom: bring it (and its buttons) into view.
    requestAnimationFrame(() => el?.closest('.lg-compose')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, []);
  const add = () => {
    if (text.trim()) addComment(taskId, path, hunk, text);
  };
  return (
    <div className="lg-compose" data-testid="hunk-compose">
      <textarea
        ref={field}
        className="lg-compose-field"
        placeholder="What should change here? It goes to the agent with this change quoted."
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            add();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancelComment();
          }
        }}
        data-testid="hunk-compose-field"
      />
      <div className="lg-compose-row">
        <span className="faint">Sent with your review</span>
        <span className="flex-1" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={cancelComment}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={add}>
          Add comment
          <Kbd>⌘⏎</Kbd>
        </button>
      </div>
    </div>
  );
}

/** One of your drafted comments, under the change it is about. */
export function CommentCard({ comment }: { comment: ReviewComment }) {
  const lines = comment.start === comment.end ? `${comment.start}` : `${comment.start}–${comment.end}`;
  return (
    <div className="lg-comment" data-testid="review-comment">
      <div className="lg-comment-head">
        <Icon name="chat" size={12} className="lg-comment-icon" />
        <span>Your comment</span>
        <span className="mono faint">
          {comment.path.split('/').at(-1)}:{lines}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Delete this comment"
          title="Delete"
          onClick={() => deleteComment(comment.taskId, comment.id)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <p className="lg-comment-text">{comment.text}</p>
    </div>
  );
}

/**
 * The review's bar: how many comments, Send to the agent (into its session while it codes, else as a request for
 * changes), and Approve & merge while the task waits on you.
 */
export function ReviewBar({ task, comments }: { task: Task; comments: readonly ReviewComment[] }) {
  const channel = useData(useShallow((s) => reviewChannel(s, task.id)));
  const agent = useData((s) => {
    const coder = Object.values(s.attempts)
      .filter((a) => a.taskId === task.id && (a.role === 'coder' || a.role === 'resolver'))
      .at(-1);
    return coder?.engine ?? null;
  });
  const [sending, setSending] = useState(false);
  const canApprove = task.status === 'awaiting_human';
  if (comments.length === 0 && !canApprove) return null;
  const send = async () => {
    setSending(true);
    try {
      await sendReview(dataStore.getState(), task.id);
      toast(
        channel.kind === 'session'
          ? `Sent to ${task.nodeId}'s agent: it reads your review after its current step.`
          : `Sent: ${task.nodeId} goes back to its agent to address your review.`,
      );
    } catch (error) {
      toast(`Couldn't send the review: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="lg-review" data-testid="review-bar">
      {comments.length > 0 ? (
        <span className="lg-review-count">
          {comments.length} comment{comments.length === 1 ? '' : 's'}
        </span>
      ) : null}
      {comments.length > 0 && channel.kind === 'none' ? <span className="faint">{channel.reason}</span> : null}
      <span className="flex-1" />
      {comments.length > 0 ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={channel.kind === 'none' || sending}
          onClick={() => void send()}
          title={
            channel.kind === 'session'
              ? 'Into its session; it reads it after its current step'
              : channel.kind === 'requestChanges'
                ? 'The task goes back to its agent to address it'
                : channel.reason
          }
          data-testid="review-send"
        >
          {sending
            ? 'Sending…'
            : `Send to ${agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'the agent'}`}
        </button>
      ) : null}
      {canApprove ? (
        <button
          type="button"
          className="btn lg-btn-ok"
          onClick={() => void approveMerge(task.id)}
          title="Approve it for the merge queue"
          data-testid="review-approve"
        >
          Approve & merge
        </button>
      ) : null}
    </div>
  );
}
