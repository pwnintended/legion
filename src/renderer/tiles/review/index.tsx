/**
 * Review tile: the review pack for one task (or the run's final review). Intent → outcome (the task's goal
 * vs. the agent's own report), gates with their evidence, the reviewer's verdict per acceptance criterion,
 * findings across fix rounds (resolved ones struck through), why a human gate applies, and the actions:
 * Approve & merge ⌘⏎, Request changes (R), send a minor finding to the agent. D opens the diff.
 */
import type { Attempt, Review, Task, TaskNode } from '@shared/domain';
import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { type CommandContext, registerCommands } from '../../app/commands';
import { taskReport } from '../../app/compat';
import { attemptsOfRun, openInbox, reviewsOfRun, verificationsOfRun } from '../../app/data';
import { rpc, useData, useLatestPlan, useNow, useSettings, useTranscript } from '../../app/hooks';
import { whenData } from '../../app/pending';
import { actions, dataStore } from '../../app/store';
import { Chip, EngineChip, Kbd } from '../../chrome/ui';
import { displayEngine, ENGINE_LABEL, ENGINE_NAME, formatDuration, otherEngine } from '../../layout/describe';
import { focusedTile } from '../../layout/tree';
import type { TileCardProps, TileProps } from '../../layout/types';
import { focusDiff } from '../diff/data';
import { Check, errorText, InlineComposer, Markdown, openTile, shortSha, useAction, useTileKeys } from '../plan/kit';
import { type Gate, gateReasons, gatesFor, isBlocking, latestVerifications, trackFindings } from './evidence';
import { FindingCard } from './findings';

// ---------------------------------------------------------------------------------------------
// ⌘⏎ on a focused review tile
// ---------------------------------------------------------------------------------------------

interface ApproveState {
  pending: boolean;
  error: string | null;
}
const IDLE: ApproveState = { pending: false, error: null };
const approveStore = createStore<Record<string, ApproveState>>(() => ({}));

function useApproveState(taskId: string): ApproveState {
  return useStore(approveStore, (s) => s[taskId] ?? IDLE);
}

/**
 * Approve a task for the merge queue. Stays pending until the task leaves `awaiting_human` in the store (the
 * `task.updated` event), so a held ⌘⏎ can't send a second `tasks.approveMerge`.
 */
export async function approveMerge(taskId: string): Promise<void> {
  const set = (next: ApproveState) => approveStore.setState({ ...approveStore.getState(), [taskId]: next });
  if (approveStore.getState()[taskId]?.pending) return;
  set({ pending: true, error: null });
  try {
    await rpc('tasks.approveMerge', { taskId });
    await whenData((data) => data.tasks[taskId]?.status !== 'awaiting_human');
    set(IDLE);
  } catch (error) {
    set({ pending: false, error: errorText(error) });
  }
}

function focusedReviewTask(ctx: CommandContext): Task | null {
  if (ctx.ui.overlay !== null || ctx.ui.layoutMode === 'overview' || ctx.ui.layoutMode === 'pipeline') return null;
  const tile = ctx.layout ? focusedTile(ctx.layout) : null;
  if (!tile || (tile.kind !== 'review' && tile.kind !== 'diff')) return null;
  const params = tile.params as { taskId?: string | null; target?: { kind: string; taskId?: string } };
  const taskId = tile.kind === 'review' ? params.taskId : params.target?.kind === 'task' ? params.target.taskId : null;
  return taskId ? (ctx.data.tasks[taskId] ?? null) : null;
}

registerCommands([
  {
    id: 'review.approveMerge',
    title: 'Approve & merge the focused task',
    category: 'Run',
    keybinding: 'Mod+Enter',
    priority: 10,
    inInput: false,
    when: (ctx) => focusedReviewTask(ctx)?.status === 'awaiting_human',
    run: (ctx) => {
      const task = focusedReviewTask(ctx);
      if (task) return approveMerge(task.id);
    },
  },
]);

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

interface Pack {
  task: Task | null;
  node: TaskNode | null;
  reviews: Review[];
  coder: Attempt | null;
  reviewer: Attempt | null;
  coderAttempts: Attempt[];
  gates: Gate[];
  reasons: string[];
  changedFiles: string[];
}

function usePack(runId: string, taskId: string | null): Pack {
  const plan = useLatestPlan(runId);
  const settings = useSettings();
  const deps = useData(useShallow((s) => [s.tasks, s.reviews, s.attempts, s.verifications, s.inbox, s.diffstats]));
  return useMemo(() => {
    const state = dataStore.getState();
    const task = taskId ? (state.tasks[taskId] ?? null) : null;
    const node = task ? (plan?.dag.nodes.find((n) => n.id === task.nodeId) ?? null) : null;
    const reviews = reviewsOfRun(state.reviews, runId).filter((r) => r.taskId === taskId);
    const attempts = attemptsOfRun(state.attempts, runId).filter((a) => a.taskId === taskId);
    const coderAttempts = attempts.filter((a) => a.role === 'coder');
    const coder = coderAttempts.at(-1) ?? null;
    const reviewer =
      attempts.filter((a) => a.role === (taskId ? 'reviewer' : 'finalizer')).at(-1) ??
      (taskId
        ? null
        : (attemptsOfRun(state.attempts, runId)
            .filter((a) => a.role === 'finalizer')
            .at(-1) ?? null));
    const files = new Set<string>();
    for (const a of coderAttempts) for (const f of state.diffstats[a.id]?.files ?? []) files.add(f);
    const verifications = taskId
      ? latestVerifications(verificationsOfRun(state.verifications, runId), taskId)
      : verificationsOfRun(state.verifications, runId).filter((v) => v.phase === 'final');
    const gates = gatesFor({ node, verifications, changedFiles: taskId ? [...files] : null });
    const reasons =
      task && node
        ? gateReasons({
            task,
            node,
            annotations: plan?.dag.annotations ?? [],
            inbox: openInbox(state.inbox, runId),
            maxFixRounds: settings?.limits.maxFixRounds ?? 2,
          })
        : [];
    return { task, node, reviews, coder, reviewer, coderAttempts, gates, reasons, changedFiles: [...files] };
  }, [runId, taskId, plan, settings, ...deps]);
}

/** The coder's own account: the last assistant message of the latest coder attempt that has one. */
function useAgentReport(attempts: Attempt[]): { text: string | null; attempt: Attempt | null } {
  const latest = attempts.at(-1) ?? null;
  const previous = attempts.at(-2) ?? null;
  const t1 = useTranscript(latest?.id);
  const t0 = useTranscript(previous?.id);
  const last = (t: typeof t1) => {
    for (let i = t.count - 1; i >= 0; i--) {
      const e = t.entries[i]?.event;
      if (e?.type === 'message') return e.text;
    }
    return null;
  };
  const text = last(t1);
  if (text) return { text, attempt: latest };
  return { text: last(t0), attempt: previous };
}

// ---------------------------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------------------------

export default function ReviewTile({ runId, params }: TileProps<'review'>) {
  const pack = usePack(runId, params.taskId);
  const [round, setRound] = useState<number | null>(null);
  const [requesting, setRequesting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { task } = pack;

  const openDiff = () => {
    const target = task ? { kind: 'task' as const, taskId: task.id } : { kind: 'run' as const, runId };
    openTile(runId, 'diff', { target }, { besideTileId: null, width: '1/2' });
  };

  useTileKeys(root, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if ((e.key === 'r' || e.key === 'R') && task && task.status === 'awaiting_human') {
      setRequesting(true);
      return true;
    }
    if (e.key === 'd' || e.key === 'D') {
      openDiff();
      return true;
    }
    return false;
  });

  if (params.taskId && !task)
    return <div className="flex h-full items-center justify-center text-subtext0">Task not loaded</div>;

  const reviews = pack.reviews;
  const shownRound = round ?? reviews.length;
  const review = reviews[shownRound - 1] ?? null;
  const findings = trackFindings(reviews);
  const reviewerEngine =
    pack.reviewer?.engine ?? otherEngine(pack.coder?.engine ?? pack.node?.agent.engine ?? 'claude');

  return (
    <div ref={root} className="lg-col" data-testid="review-tile">
      <Header pack={pack} reviews={reviews} onDiff={openDiff} />
      <div className="lg-scroll">
        <div className="lg-pane grid gap-x-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          <div className="min-w-0">
            {task ? <IntentOutcome pack={pack} /> : <FinalIntent runId={runId} />}
            <Gates gates={pack.gates} live={task ? ['running', 'verifying', 'fixing'].includes(task.status) : false} />
            {pack.reasons.length > 0 && task?.status === 'awaiting_human' ? (
              <>
                <div className="lg-sec">Why you’re seeing this</div>
                <div className="flex flex-col gap-1.5 text-[12.5px] leading-normal text-subtext0">
                  {pack.reasons.map((r) => (
                    <Markdown key={r} className="[&_p]:m-0 [&_p]:text-subtext0">
                      {r.replace(/(\S+\/\*\*|legion\.json)/g, '`$1`')}
                    </Markdown>
                  ))}
                </div>
              </>
            ) : null}
          </div>
          <div className="min-w-0">
            <div className="lg-sec">
              Reviewer
              <span className="lg-sec-aside flex items-center gap-1.5">
                <EngineChip engine={reviewerEngine} text={`${ENGINE_LABEL[reviewerEngine]} · fresh session`} />
                {review ? <VerdictChip review={review} /> : null}
              </span>
            </div>
            {reviews.length > 1 ? (
              <div className="mb-2 flex gap-1" role="tablist" aria-label="Review rounds">
                {reviews.map((r, i) => (
                  <button
                    key={r.id}
                    type="button"
                    role="tab"
                    className="lg-ftab"
                    style={{ height: 24, fontFamily: 'var(--font-ui)', fontSize: 12 }}
                    aria-selected={shownRound === i + 1}
                    aria-current={shownRound === i + 1}
                    onClick={() => setRound(i + 1)}
                  >
                    Round {i + 1}
                    <span className={r.verdict === 'approve' ? 'lg-add' : 'text-peach'}>
                      {r.verdict === 'approve' ? '✓' : '△'}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {review ? (
              <Criteria review={review} node={pack.node} />
            ) : (
              <ReviewPending pack={pack} engine={reviewerEngine} />
            )}
            {review?.summary ? (
              <p className="mt-2 mb-0 text-[12.5px] leading-normal text-subtext0">{review.summary}</p>
            ) : null}
            {findings.length > 0 ? (
              <>
                <div className="lg-sec">
                  Findings
                  <span className="lg-sec-aside">
                    {findings.filter((f) => f.state === 'open' && isBlocking(f.finding)).length} blocking ·{' '}
                    {findings.filter((f) => f.state === 'resolved').length} resolved
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {findings.map((f) => (
                    <FindingCard
                      key={f.key}
                      tracked={f}
                      reviewer={reviewerEngine}
                      task={task}
                      scope={task?.id ?? runId}
                      onOpen={
                        f.finding.file
                          ? () => {
                              openDiff();
                              const target = task
                                ? { kind: 'task' as const, taskId: task.id }
                                : { kind: 'run' as const, runId };
                              setTimeout(() => focusDiff(target, f.finding.file as string, f.finding.line), 80);
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
      {task ? (
        <Actions runId={runId} task={task} pack={pack} requesting={requesting} setRequesting={setRequesting} />
      ) : null}
    </div>
  );
}

function VerdictChip({ review }: { review: Review }) {
  if (review.verdict === 'approve') return <Chip tone="ok">approve</Chip>;
  if (review.verdict === 'request_changes') return <Chip tone="warn">changes requested</Chip>;
  return <Chip tone="bad">re-plan</Chip>;
}

function Header({ pack, reviews, onDiff }: { pack: Pack; reviews: Review[]; onDiff: () => void }) {
  const { task, node } = pack;
  return (
    <div className="lg-bar">
      {task && node ? (
        <>
          <span className="tile-id">{task.nodeId}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{node.title}</span>
          {node.risk === 'high' ? (
            <Chip tone="warn">{task.status === 'awaiting_human' ? 'risk high · your call' : 'risk high'}</Chip>
          ) : null}
          {reviews.length > 0 ? <Chip tone="idle">round {reviews.length}</Chip> : null}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">Final review · base…integration</span>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDiff} title="Open the diff  D">
        Diff <Kbd>D</Kbd>
      </button>
    </div>
  );
}

function IntentOutcome({ pack }: { pack: Pack }) {
  // Prefer the coder's structured report (Task.report on newer engines) over its last chat message.
  const structured = taskReport(pack.task);
  const fromTranscript = useAgentReport(structured ? [] : pack.coderAttempts);
  const report = structured ? { text: structured.summary, attempt: pack.coderAttempts.at(-1) ?? null } : fromTranscript;
  const shown = report.attempt ?? pack.coder;
  const engine = shown ? displayEngine(dataStore.getState(), shown) : (pack.node?.agent.engine ?? 'claude');
  const running = report.attempt?.status === 'running';
  return (
    <>
      <div className="lg-sec">Intent → outcome</div>
      <div className="flex flex-col gap-3 text-[12.5px] leading-normal">
        <div>
          <div className="faint text-[11.5px]">Task asked for</div>
          <div>{pack.node?.goal ?? '—'}</div>
        </div>
        <div>
          <div className="faint flex items-center gap-1.5 text-[11.5px]">
            Agent reports <EngineChip engine={engine} />
            {running ? <span className="dot live" style={{ color: 'var(--blue)' }} /> : null}
          </div>
          <div className={report.text ? '' : 'faint'}>{report.text ?? pack.task?.progress ?? 'No report yet.'}</div>
        </div>
      </div>
    </>
  );
}

function FinalIntent({ runId }: { runId: string }) {
  const run = useData((s) => s.runs[runId] ?? null);
  return (
    <>
      <div className="lg-sec">Intent</div>
      <div className="text-[12.5px] leading-normal">{run?.title}</div>
      {run?.issueUrl ? <div className="faint mono mt-1 text-[11.5px]">{run.issueUrl}</div> : null}
    </>
  );
}

function Gates({ gates, live }: { gates: Gate[]; live: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const green = gates.filter((g) => g.ok === true).length;
  return (
    <>
      <div className="lg-sec">
        Gates
        <span className="lg-sec-aside">
          {gates.length === 0 ? (
            'not run yet'
          ) : (
            <Chip tone={green === gates.length ? 'ok' : 'bad'}>
              {green}/{gates.length} green
            </Chip>
          )}
        </span>
      </div>
      {live ? (
        <div className="faint mb-1 flex items-center gap-1.5 text-[11.5px]">
          <span className="dot live" style={{ color: 'var(--blue)' }} />
          results below are from the last run; new ones arrive after the agent’s turn
        </div>
      ) : null}
      <div data-testid="gates">
        {gates.map((g) => (
          <div key={g.key}>
            <button
              type="button"
              className="lg-gate"
              onClick={() => setOpen(open === g.key ? null : g.key)}
              aria-expanded={open === g.key}
              title={g.command ?? undefined}
            >
              <Check ok={g.ok} />
              <span className="min-w-0 flex-1 truncate">{g.label}</span>
              <span className="lg-gate-ev">{g.evidence}</span>
            </button>
            {open === g.key && g.detail ? (
              <div className="lg-block mt-0.5 mb-2 lg-rise">
                {g.command ? <div className="faint">$ {g.command}</div> : null}
                {g.detail}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function Criteria({ review, node }: { review: Review; node: TaskNode | null }) {
  const met = review.criteria.filter((c) => c.status === 'met').length;
  return (
    <>
      <div className="faint mb-2 text-[11.5px]">
        Acceptance criteria · {met}/{review.criteria.length}
      </div>
      <div className="flex flex-col gap-2 text-[12.5px] leading-normal" data-testid="criteria">
        {review.criteria.map((c) => {
          const text = node?.acceptanceCriteria.find((a) => a.id === c.id)?.text ?? c.id;
          return (
            <div key={c.id} className="flex gap-2">
              <span className="w-3.5 flex-none pt-[1px]">
                {c.status === 'met' ? (
                  <Check ok />
                ) : c.status === 'unmet' ? (
                  <Check ok={false} />
                ) : (
                  <span className="text-peach">?</span>
                )}
              </span>
              <div className="min-w-0">
                {text}
                <div className="faint mono text-[11px]">{c.evidence}</div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ReviewPending({ pack, engine }: { pack: Pack; engine: Attempt['engine'] }) {
  const now = useNow(5_000);
  const running = pack.reviewer?.status === 'running' || pack.task?.status === 'reviewing';
  return (
    <div className="flex items-center gap-2 py-2 text-[12.5px] text-subtext0">
      {running ? (
        <span className="dot live" style={{ color: `var(--${engine === 'codex' ? 'teal' : 'mauve'})` }} />
      ) : null}
      {running
        ? `${ENGINE_NAME[engine]} is reviewing in a fresh session${pack.reviewer ? ` · ${formatDuration(now - pack.reviewer.startedAt)}` : ''}`
        : 'The other engine reviews once the gates pass.'}
    </div>
  );
}

function Actions({
  runId,
  task,
  pack,
  requesting,
  setRequesting,
}: {
  runId: string;
  task: Task;
  pack: Pack;
  requesting: boolean;
  setRequesting: (v: boolean) => void;
}) {
  const approve = useApproveState(task.id);
  const now = useNow(10_000);
  const [request] = useAction(async (feedback: string) => {
    await rpc('tasks.requestChanges', { taskId: task.id, feedback });
  });
  const coder = pack.coder;
  const worktree = task.worktreePath;

  if (task.status === 'awaiting_human')
    return (
      <div className="lg-foot" data-testid="review-actions">
        {approve.error ? <div className="text-[12px] text-red">{approve.error}</div> : null}
        {requesting ? (
          <InlineComposer
            placeholder={`What should ${ENGINE_NAME[displayEngine(dataStore.getState(), coder)]} change?`}
            submitLabel="Request changes"
            tone="warn"
            hint="goes back to the coder session"
            onCancel={() => setRequesting(false)}
            onSubmit={async (text) => {
              if (await request(text)) setRequesting(false);
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn lg-btn-ok lg-btn-lg"
              disabled={approve.pending}
              onClick={() => void approveMerge(task.id)}
              data-testid="approve-merge"
            >
              {approve.pending ? 'Approving…' : 'Approve & merge'}
              <Kbd>⌘⏎</Kbd>
            </button>
            <button type="button" className="btn lg-btn-lg" onClick={() => setRequesting(true)}>
              Request changes <Kbd>R</Kbd>
            </button>
            {worktree ? (
              <button
                type="button"
                className="btn btn-ghost lg-btn-lg"
                onClick={() => window.legion?.showItemInFolder?.(worktree)}
                title={worktree}
              >
                Open worktree
              </button>
            ) : null}
            <span className="faint ml-auto text-[12px]">next: merge queue → post-merge verify</span>
          </div>
        )}
      </div>
    );

  let line: React.ReactNode;
  if (task.status === 'fixing')
    line = (
      <>
        <span
          className="dot live"
          style={{ color: `var(--${displayEngine(dataStore.getState(), coder) === 'codex' ? 'teal' : 'mauve'})` }}
        />
        {ENGINE_NAME[displayEngine(dataStore.getState(), coder)]} is fixing round {task.fixRounds}
        {coder?.status === 'running' ? ` · ${formatDuration(now - coder.startedAt)}` : ''}
        <span className="faint ml-auto">then gates and a fresh review run again</span>
      </>
    );
  else if (task.status === 'reviewing' || task.status === 'verifying')
    line = (
      <>
        <span className="dot live" style={{ color: 'var(--blue)' }} />
        {task.status === 'verifying' ? 'Running the gates' : 'Under review'}
      </>
    );
  else if (task.status === 'approved' || task.status === 'merging')
    line = (
      <>
        <span className="dot live" style={{ color: 'var(--green)' }} />
        {task.status === 'merging' ? 'Merging into the integration branch' : 'Approved · waiting in the merge queue'}
      </>
    );
  else if (task.status === 'merged')
    line = (
      <>
        <Check ok />
        Merged into integration {task.mergedSha ? <span className="mono faint">{shortSha(task.mergedSha)}</span> : null}
      </>
    );
  else if (task.status === 'failed') line = <span className="text-red">Failed: {task.error ?? 'see the session'}</span>;
  else return null;
  return (
    <div className="lg-foot" data-testid="review-actions">
      <div className="flex items-center gap-2 text-[12.5px]">
        {line}
        {task.status === 'fixing' ? null : (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            onClick={() => actions.revealTile(runId, `session:${task.nodeId}`, null)}
          >
            Session →
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------------------------

export function Card({ runId, params }: TileCardProps<'review'>) {
  const pack = usePack(runId, params.taskId);
  const review = pack.reviews.at(-1);
  if (!review) return <div>waiting for the reviewer</div>;
  const met = review.criteria.filter((c) => c.status === 'met').length;
  const findings = trackFindings(pack.reviews);
  const open = findings.filter((f) => f.state === 'open');
  const green = pack.gates.filter((g) => g.ok).length;
  return (
    <>
      <div>
        round {pack.reviews.length} · {review.verdict.replace('_', ' ')} · criteria {met}/{review.criteria.length}
      </div>
      <div>
        gates {green}/{pack.gates.length} green · {findings.filter((f) => f.state === 'resolved').length} resolved
      </div>
      <div>{open[0] ? `${open[0].finding.severity}: ${open[0].finding.title}` : 'no open findings'}</div>
    </>
  );
}
