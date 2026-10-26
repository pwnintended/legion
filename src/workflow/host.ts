/**
 * What the workflow runtime needs from its surroundings. `RunManager` provides the real one (session engines,
 * the TUI's interaction queue, git); `validate.ts` provides a dry one (fake engines, auto-approved gates, simulated
 * git and shell) so a freshly written workflow can be exercised without spending tokens or touching the repo.
 */
import type { AgentEngine, AgentEvent, ApprovalDecision, Effort, EngineKind } from '../engine/types.ts';
import type { RunStatus, StepKind } from './journal.ts';

export type Interaction =
  | {
      kind: 'gate';
      runId: string;
      key: string;
      title: string;
      /** Markdown shown with the gate (a plan, a diff summary). */
      body: string | null;
    }
  | { kind: 'ask'; runId: string; key: string; question: string; options: readonly string[] }
  | { kind: 'approval'; runId: string; key: string; tool: string; input: unknown; reason: string | null };

export type GateAnswer = { choice: 'approve' | 'changes' | 'abort'; note: string | null };
export type AskAnswer = { answer: string };

export type InteractionAnswer<I extends Interaction> = I extends { kind: 'gate' }
  ? GateAnswer
  : I extends { kind: 'ask' }
    ? AskAnswer
    : ApprovalDecision;

/** Progress the UI renders. Not durable: the journal is the source of truth. */
export type RunEvent =
  | { type: 'run'; runId: string; status: RunStatus; error?: string | null; result?: unknown }
  | {
      type: 'step';
      runId: string;
      key: string;
      kind: StepKind;
      status: 'started' | 'done' | 'failed' | 'cached';
      label: string;
      detail?: string | null;
      /** Agent steps: the engine they run on. */
      engine?: EngineKind;
    }
  | { type: 'agent'; runId: string; key: string; event: AgentEvent }
  | { type: 'log'; runId: string; message: string };

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ShellOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A branch checked out in its own worktree. */
export interface Worktree {
  name: string;
  branch: string;
  path: string;
  /** Commit the branch started from. */
  baseSha: string;
  /** Branch it started from, when it started from one (PRs target it; local merges land on it). */
  baseBranch: string | null;
}

export type MergeResult = { ok: true; sha: string | null } | { ok: false; conflicts: string[] };

/** Git operations the SDK exposes. Mutations are journaled by the runtime; this layer just does them. */
export interface GitOps {
  /** The run's integration branch, created from `base` (default: the current HEAD of the repo). */
  integration(runId: string, opts: { base: string | null }): Promise<Worktree>;
  /** A task worktree on a new branch from `from` (a worktree's branch, or a rev; default: HEAD). */
  worktree(runId: string, name: string, opts: { from: string | null }): Promise<Worktree>;
  /** Commits everything in the worktree. null sha when there was nothing to commit. */
  commit(wt: Worktree, message: string): Promise<{ sha: string | null }>;
  /** Squash-merges `wt`'s branch into `into`, rolling back on conflict. */
  squashMerge(wt: Worktree, into: Worktree, message: string): Promise<MergeResult>;
  /** Merges `from` into `wt` (to resolve conflicts on the task branch); leaves conflicts in place for an agent. */
  mergeInto(wt: Worktree, from: Worktree): Promise<MergeResult>;
  /** Commits a finished in-progress merge after checking for conflict markers. */
  finishMerge(wt: Worktree, message: string): Promise<{ sha: string }>;
  /** Unified diff of `wt` against `against` (default: its base). */
  diff(wt: Worktree, opts: { against: string | null }): Promise<string>;
  /** Changed paths of `wt` against its base. */
  changedFiles(wt: Worktree): Promise<string[]>;
  /** Pushes and opens a draft PR (or returns the existing one). */
  draftPr(wt: Worktree, opts: { title: string; body: string; base: string | null }): Promise<{ url: string }>;
  /** Fast-forwards / merges `wt`'s branch into the base branch without touching the user's checkout. */
  mergeToBase(wt: Worktree, opts: { base: string | null; message: string }): Promise<{ sha: string }>;
  remove(wt: Worktree): Promise<void>;
  /** Re-creates a worktree whose directory is gone (a resumed run after a reboot or cleanup), from its branch. */
  restore(wt: Worktree): Promise<void>;
}

export interface AgentModelRequest {
  /** The key passed to `agent()`. */
  key: string;
  /** The full step key (`T1/review/2/fix`). */
  step: string;
  engine: EngineKind;
  model: string | null;
  effort: Effort | null;
}

export interface RunHost {
  readonly repo: string;
  readonly dryRun: boolean;
  /** The session's engine for a kind (bound to the session profile; fake in dry runs). */
  engine(kind: EngineKind): AgentEngine;
  /** Resolves when the human (or the dry host) answers. */
  interact<I extends Interaction>(interaction: I): Promise<InteractionAnswer<I>>;
  emit(event: RunEvent): void;
  sh(command: string, opts: ShellOptions): Promise<ShellResult>;
  readonly git: GitOps;
  /** Max agent sessions alive at once across the run. */
  readonly maxAgents: number;
  /**
   * The engine, model and effort an agent step runs with, given what the workflow's code asked for (the user's
   * settings for this workflow may override it). Absent: the code's choice as is.
   */
  agentModel?(req: AgentModelRequest): { engine?: EngineKind; model: string | null; effort: Effort | null };
  /** Default for agents that do not say who answers their tool approvals. */
  readonly approvals: 'ask' | 'auto';
}
