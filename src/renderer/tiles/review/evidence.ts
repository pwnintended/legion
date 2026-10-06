/**
 * The review pack's evidence, derived purely from run data: verification gates (with the scope check),
 * findings tracked across review rounds (resolved ones are kept, struck through) and why a task waits for
 * a human.
 */
import { checkScope } from '@engine/orchestrator/core/scope';
import type {
  Attempt,
  FindingSeverity,
  InboxItem,
  PlanAnnotation,
  Review,
  ReviewFinding,
  Task,
  TaskNode,
  Verification,
} from '@shared/domain';

// ---------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------

export type GateKind = 'tests' | 'typecheck' | 'lint' | 'verify' | 'scope' | 'secrets';

export interface Gate {
  key: string;
  kind: GateKind;
  label: string;
  /** null = not run yet / running. */
  ok: boolean | null;
  /** One short line of evidence (`10/10 · 2.3s`, `4/4 files declared`). */
  evidence: string;
  /** Full output (expandable), if any. */
  detail: string | null;
  command: string | null;
}

const ORDER: Record<GateKind, number> = { tests: 0, typecheck: 1, lint: 2, verify: 3, scope: 4, secrets: 5 };

export function classifyCommand(command: string): GateKind {
  const c = command.toLowerCase();
  if (/gitleaks|trufflehog|detect-secrets|secret/.test(c)) return 'secrets';
  if (/\btsc\b|typecheck|type-check|mypy|pyright/.test(c)) return 'typecheck';
  if (/\blint\b|biome|eslint|clippy|ruff|golangci/.test(c)) return 'lint';
  if (/\b(vitest|jest|pytest|mocha|playwright)\b|go test|cargo test|(^|\s)(pnpm|npm|yarn|bun) (run )?test\b/.test(c))
    return 'tests';
  return 'verify';
}

const GATE_LABEL: Record<Exclude<GateKind, 'verify'>, string> = {
  tests: 'Tests',
  typecheck: 'Typecheck',
  lint: 'Lint',
  scope: 'Scope',
  secrets: 'Secret scan',
};

/** `pnpm db:migrate:check` → `db:migrate:check`. */
export function commandLabel(command: string): string {
  return command
    .split('&&')
    .map((part) => part.trim().replace(/^(pnpm|npm|yarn|bun)( run)? /, ''))
    .join(' && ');
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}

function seconds(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 1000).toFixed(1)}s`;
}

/** Verifications of the task's most recent verified attempt (one per command, latest wins). */
export function latestVerifications(verifications: readonly Verification[], taskId: string): Verification[] {
  const mine = verifications.filter((v) => v.taskId === taskId && v.phase === 'task');
  const last = mine.reduce<Verification | null>((a, v) => (!a || v.createdAt > a.createdAt ? v : a), null);
  if (!last) return [];
  const group = mine.filter((v) => v.attemptId === last.attemptId);
  const byCommand = new Map<string, Verification>();
  for (const v of group.sort((a, b) => a.createdAt - b.createdAt)) byCommand.set(v.command, v);
  return [...byCommand.values()];
}

export function gatesFor(input: {
  node: Pick<TaskNode, 'touches'> | null;
  verifications: readonly Verification[];
  /** Files the task changed (diff or file_change events); null = unknown. */
  changedFiles: readonly string[] | null;
}): Gate[] {
  const gates: Gate[] = input.verifications.map((v) => {
    const kind = classifyCommand(v.command);
    const tail = lastLine(v.outputTail);
    return {
      key: v.id,
      kind,
      label: kind === 'verify' ? commandLabel(v.command) : GATE_LABEL[kind],
      ok: v.exitCode === null ? false : v.exitCode === 0,
      evidence: [
        tail.length > 48 ? `${tail.slice(0, 47)}…` : tail,
        /\d(\.\d+)?m?s\b/.test(tail) ? null : seconds(v.durationMs),
      ]
        .filter(Boolean)
        .join(' · '),
      detail: v.outputTail || null,
      command: v.command,
    };
  });
  if (input.node && input.changedFiles && input.changedFiles.length > 0) {
    const scope = checkScope(input.node, input.changedFiles);
    const total = scope.inScope.length + scope.outOfScope.length;
    gates.push({
      key: 'scope',
      kind: 'scope',
      label: 'Scope',
      ok: scope.outOfScope.length === 0,
      evidence:
        scope.outOfScope.length === 0
          ? `${total}/${total} files declared`
          : `${scope.outOfScope.length} outside: ${scope.outOfScope.slice(0, 2).join(', ')}`,
      detail: [
        `declared: ${input.node.touches.map((t) => `${t.mode} ${t.glob}`).join(', ') || 'nothing'}`,
        `changed:  ${scope.inScope.join(', ') || '—'}`,
        scope.outOfScope.length ? `outside:  ${scope.outOfScope.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      command: null,
    });
  }
  return gates.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

// ---------------------------------------------------------------------------------------------
// Findings across rounds
// ---------------------------------------------------------------------------------------------

export interface TrackedFinding {
  key: string;
  finding: ReviewFinding;
  /** 1-based review round where it was (last) raised. */
  round: number;
  /** Still in the latest review, or gone from it (fixed). */
  state: 'open' | 'resolved';
  review: Review;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

export function findingKey(f: Pick<ReviewFinding, 'file' | 'title'>): string {
  return `${f.file ?? ''}|${f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}`;
}

/** Findings of every round: those in the latest review are open, earlier ones that disappeared are resolved. */
export function trackFindings(reviews: readonly Review[]): TrackedFinding[] {
  const sorted = [...reviews].sort((a, b) => a.createdAt - b.createdAt);
  const latest = sorted.at(-1);
  if (!latest) return [];
  const byKey = new Map<string, TrackedFinding>();
  sorted.forEach((review, i) => {
    for (const finding of review.findings) {
      const key = findingKey(finding);
      byKey.set(key, { key, finding, round: i + 1, state: review === latest ? 'open' : 'resolved', review });
    }
  });
  return [...byKey.values()].sort(
    (a, b) =>
      (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      a.round - b.round,
  );
}

export function isBlocking(f: Pick<ReviewFinding, 'severity'>): boolean {
  return f.severity === 'blocker' || f.severity === 'major';
}

// ---------------------------------------------------------------------------------------------
// Human gate
// ---------------------------------------------------------------------------------------------

const TAG = /^\[([a-z_]+)\] ?/;

/** Why a task waits for a human (high risk, high-risk globs, escalations). */
export function gateReasons(input: {
  task: Task;
  node: TaskNode | null;
  annotations: readonly PlanAnnotation[];
  inbox: readonly InboxItem[];
  maxFixRounds: number;
}): string[] {
  const { task, node } = input;
  const reasons: string[] = [];
  for (const item of input.inbox) {
    if (item.taskId !== task.id || item.resolvedAt !== null) continue;
    if (item.kind === 'escalation') reasons.push(item.payload.summary);
    if (item.kind === 'conflict') reasons.push(`Merge conflict: ${item.payload.summary}`);
  }
  for (const a of input.annotations) {
    if (!a.nodeIds.includes(task.nodeId)) continue;
    const tag = TAG.exec(a.message)?.[1];
    if (tag === 'high_risk_glob') reasons.push(a.message.replace(TAG, ''));
  }
  if (node?.risk === 'high')
    reasons.push(
      `${task.nodeId} is marked high-risk in the plan, so it waits for you even after the reviewer approves.`,
    );
  if (task.fixRounds >= input.maxFixRounds && task.status === 'awaiting_human')
    reasons.push(`It used all ${input.maxFixRounds} fix rounds.`);
  return [...new Set(reasons)];
}

/** Files changed by a task's coder attempts after `since` (from live file_change events). */
export function filesChangedSince(
  attempts: readonly Attempt[],
  diffstats: Readonly<Record<string, { files: string[] } | undefined>>,
  taskId: string,
  since: number,
): string[] {
  const files = new Set<string>();
  for (const a of attempts)
    if (a.taskId === taskId && a.role === 'coder' && a.startedAt >= since)
      for (const f of diffstats[a.id]?.files ?? []) files.add(f);
  return [...files];
}
