/** A direct session (`runs.session`): one agent the human talks to, in their checkout or a worktree of its own. */

export interface SessionPlace {
  /** The project's folder name. */
  readonly project: string;
  /** The branch the human's checkout is on, or the worktree was cut from. */
  readonly baseRef: string;
  /** The session's own worktree branch; null = it works in the human's checkout. */
  readonly worktreeBranch: string | null;
}

export function sessionSystem({ project, baseRef, worktreeBranch }: SessionPlace): string {
  const where = worktreeBranch
    ? [
        `You are working in a git worktree of ${project} of your own (branch ${worktreeBranch}, cut from ${baseRef}), in a conversation with the human.`,
        "Do what they ask here, and answer their questions. Your edits stay in this worktree; the human's own checkout is not touched.",
      ]
    : [
        `You are working directly in the human's own checkout of ${project} (branch ${baseRef}), in a conversation with them.`,
        'Do what they ask here, and answer their questions. Your edits land in their working tree as they are.',
      ];
  return [...where, "Don't commit or push: the human does that."].join(' ');
}
