/**
 * The review pack's evidence, derived purely from run data: verification gates (with the scope check),
 * findings tracked across review rounds (resolved ones are kept, struck through) and why a task waits for
 * a human.
 */
import { gateCounts } from '@engine/orchestrator/core/gates';
import { checkScope } from '@engine/orchestrator/core/scope';
import type {
  Attempt,
  FindingSeverity,
  GateStatus,
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
  /** null = not run yet / running, or skipped (see `status`). */
  ok: boolean | null;
  /** pass / fail / skipped; skipped gates are listed but not counted. */
  status: GateStatus;
  /** A failing non-blocking gate only warns. */
  blocking: boolean;
  /** One short line of evidence (`10/10 · 2.3s`, `4/4 files declared`). */
  evidence: string;
  /** Output tail (expandable), if any. */
  detail: string | null;
  /** The command it ran; null for Legion's built-in gates. */
  command: string | null;
  /** The persisted row (its full output via `verifications.output`); null for the client-side scope check. */
  verificationId: string | null;
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

/** `line · 2.3s`: the line clipped, the duration left out when the line already has one. */
function evidenceLine(line: string, durationMs: number | null): string {
  return [
    line.length > 48 ? `${line.slice(0, 47)}…` : line,
    durationMs === null || /\d(\.\d+)?m?s\b/.test(line) ? null : seconds(durationMs),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A structured gate row (engine with gates); legacy rows have no gate fields. */
function isGateRow(v: Verification): boolean {
  return typeof v.gate === 'string' && v.gate !== '' && typeof v.status === 'string';
}

/**
 * Verifications of the task's most recent verified attempt: one per gate (by gate name, or by command on
 * legacy rows), latest wins.
 */
export function latestVerifications(verifications: readonly Verification[], taskId: string): Verification[] {
  const mine = verifications.filter((v) => v.taskId === taskId && v.phase === 'task');
  const last = mine.reduce<Verification | null>((a, v) => (!a || v.createdAt > a.createdAt ? v : a), null);
  if (!last) return [];
  const group = mine.filter((v) => v.attemptId === last.attemptId);
  const byGate = new Map<string, Verification>();
  for (const v of group.sort((a, b) => a.createdAt - b.createdAt)) byGate.set(v.gate || v.command, v);
  return [...byGate.values()];
}

function structuredGate(v: Verification): Gate {
  const status = v.status as GateStatus;
  // Built-in gates (`legion:scope`, `legion:secrets`) have no command worth showing.
  const builtin = v.kind === 'scope' || v.kind === 'secrets' ? v.kind : null;
  return {
    key: v.id,
    kind: builtin ?? classifyCommand(v.command),
    label: builtin ? GATE_LABEL[builtin] : (v.gate as string),
    ok: status === 'skipped' ? null : status === 'pass',
    status,
    blocking: v.blocking ?? true,
    evidence: evidenceLine(
      v.summary || lastLine(v.outputTail) || status,
      status === 'skipped' || builtin ? null : v.durationMs,
    ),
    detail: v.outputTail || v.summary || null,
    command: builtin ? null : v.command,
    verificationId: v.id,
  };
}

/** A row from before gates: classified by its command, always blocking. */
function legacyGate(v: Verification): Gate {
  const kind = classifyCommand(v.command);
  const ok = v.exitCode === null ? false : v.exitCode === 0;
  return {
    key: v.id,
    kind,
    label: kind === 'verify' ? commandLabel(v.command) : GATE_LABEL[kind],
    ok,
    status: ok ? 'pass' : 'fail',
    blocking: true,
    evidence: evidenceLine(lastLine(v.outputTail), v.durationMs),
    detail: v.outputTail || null,
    command: v.command,
    verificationId: v.id,
  };
}

export function gatesFor(input: {
  node: Pick<TaskNode, 'touches'> | null;
  verifications: readonly Verification[];
  /** Files the task changed (diff or file_change events); null = unknown. */
  changedFiles: readonly string[] | null;
}): Gate[] {
  const gates: Gate[] = input.verifications.map((v) => (isGateRow(v) ? structuredGate(v) : legacyGate(v)));
  // The engine records a scope gate since gates exist; before that, check the scope here (informational).
  const persistedScope = input.verifications.some((v) => isGateRow(v) && v.kind === 'scope');
  if (!persistedScope && input.node && input.changedFiles && input.changedFiles.length > 0) {
    const scope = checkScope(input.node, input.changedFiles);
    const total = scope.inScope.length + scope.outOfScope.length;
    const ok = scope.outOfScope.length === 0;
    gates.push({
      key: 'scope',
      kind: 'scope',
      label: 'Scope',
      ok,
      status: ok ? 'pass' : 'fail',
      blocking: false,
      evidence: ok
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
      verificationId: null,
    });
  }
  return gates.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/** Files the task's coder attempts changed (their diffstats), in first-seen order. */
export function taskChangedFiles(
  attempts: readonly Pick<Attempt, 'id' | 'taskId' | 'role'>[],
  diffstats: Readonly<Record<string, { files: readonly string[] } | undefined>>,
  taskId: string,
): string[] {
  const files = new Set<string>();
  for (const a of attempts) {
    if (a.taskId !== taskId || a.role !== 'coder') continue;
    for (const f of diffstats[a.id]?.files ?? []) files.add(f);
  }
  return [...files];
}

/**
 * A task's gates as the review pack and the merge-gate card show them: the latest attempt's rows, plus the
 * client-side scope check over the changed files when no scope row was persisted (legacy runs).
 */
export function taskGates(input: {
  taskId: string;
  node: Pick<TaskNode, 'touches'> | null;
  /** The run's verifications (any phase, any task). */
  verifications: readonly Verification[];
  /** The run's attempts. */
  attempts: readonly Pick<Attempt, 'id' | 'taskId' | 'role'>[];
  diffstats: Readonly<Record<string, { files: readonly string[] } | undefined>>;
}): Gate[] {
  return gatesFor({
    node: input.node,
    verifications: latestVerifications(input.verifications, input.taskId),
    changedFiles: taskChangedFiles(input.attempts, input.diffstats, input.taskId),
  });
}

/**
 * The "N/N green" chip: skipped gates don't count. ok when every counted gate passed, warn when only
 * non-blocking gates failed, bad when a blocking one did (idle when nothing counted).
 */
export function gatesChip(gates: readonly Pick<Gate, 'status' | 'blocking'>[]): {
  green: number;
  total: number;
  warnings: number;
  tone: 'ok' | 'warn' | 'bad' | 'idle';
} {
  const { green, total, blockingFailed, warnings } = gateCounts(gates);
  const tone = total === 0 ? 'idle' : blockingFailed > 0 ? 'bad' : warnings > 0 ? 'warn' : 'ok';
  return { green, total, warnings, tone };
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
