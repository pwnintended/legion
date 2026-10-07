/**
 * PR tile: the human PR gate. The final review of the integrated result, an editable generated title/body
 * (preview or markdown), Create draft PR → the PR's link with "Open on GitHub", and a calm completion state.
 */
import type { InboxItemOf, Review, Run } from '@shared/domain';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip } from '../../app/commands';
import { canArchive, isArchived, type PrState, type PullRequestInfo, runPr } from '../../app/compat';
import { attemptsOfRun, reviewsOfRun, tasksOfRun } from '../../app/data';
import { rpc, useData, useNow, useRun } from '../../app/hooks';
import { archiveRunInteractively, refreshPr } from '../../app/run-actions';
import { dataStore } from '../../app/store';
import { Icon } from '../../chrome/icons';
import { Chip, EngineChip } from '../../chrome/ui';
import { displayEngine, ENGINE_LABEL, formatCost, formatDuration } from '../../layout/describe';
import type { TileCardProps, TileProps } from '../../layout/types';
import { useIntegration } from '../integration';
import { AutoTextarea, Check, Markdown, openTile, Segmented, useAction } from '../plan/kit';
import { trackFindings } from '../review/evidence';
import { FindingCard } from '../review/findings';

/** Title/body edits survive the tile unmounting (per run, this session). */
const drafts = new Map<string, { title: string; body: string }>();

function usePrReady(runId: string): InboxItemOf<'pr_ready'> | null {
  return useData(
    (s) =>
      (Object.values(s.inbox).find((i) => i.runId === runId && i.kind === 'pr_ready') as
        | InboxItemOf<'pr_ready'>
        | undefined) ?? null,
  );
}

function useFinalReview(runId: string): Review | null {
  return useData(
    (s) =>
      reviewsOfRun(s.reviews, runId)
        .filter((r) => r.taskId === null)
        .at(-1) ?? null,
  );
}

export function prNumber(url: string): string | null {
  return /\/pull\/(\d+)/.exec(url)?.[1] ?? null;
}

function openExternal(url: string): void {
  const bridge = window.legion as { openExternal?: (url: string) => Promise<void> } | undefined;
  if (bridge?.openExternal) void bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export default function PrTile({ runId }: TileProps<'pr'>) {
  const run = useRun(runId);
  if (!run) return null;
  const pr = runPr(run);
  if (pr) return <Opened run={run} pr={pr} />;
  if (run.status === 'pr_ready') return <Ready run={run} />;
  return <NotYet run={run} />;
}

// ---------------------------------------------------------------------------------------------
// Not yet / finalizing
// ---------------------------------------------------------------------------------------------

function NotYet({ run }: { run: Run }) {
  const data = useIntegration(run.id);
  const finalizer = useData(
    (s) =>
      attemptsOfRun(s.attempts, run.id)
        .filter((a) => a.role === 'finalizer')
        .at(-1) ?? null,
  );
  const now = useNow(10_000);
  const merged = data.tasks.filter((t) => t.status === 'merged').length;
  const steps = [
    {
      label: `All tasks merged (${merged}/${data.tasks.length})`,
      ok: data.tasks.length > 0 && merged === data.tasks.length,
    },
    {
      label: 'Full verify on the integration branch',
      ok: data.final.length > 0 ? data.final.every((v) => v.exitCode === 0) : null,
    },
    {
      label: finalizer
        ? `Final review by ${ENGINE_LABEL[displayEngine(dataStore.getState(), finalizer)]}`
        : 'Final review by the other engine',
      ok: finalizer?.status === 'succeeded' ? true : null,
    },
    { label: 'Your sign-off: create the draft PR', ok: null },
  ];
  const finalizing = run.status === 'finalizing' || run.status === 'integrating';
  return (
    <div className="lg-col">
      <div className="lg-scroll lg-pane">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          {finalizing ? <span className="dot live" style={{ color: 'var(--blue)' }} /> : null}
          {run.status === 'integrating'
            ? 'Verifying the integrated result'
            : run.status === 'finalizing'
              ? `Final review${finalizer?.status === 'running' ? ` · ${formatDuration(now - finalizer.startedAt)}` : ''}`
              : 'The draft PR opens when the run is done'}
        </div>
        <p className="muted mt-1.5 mb-3 text-[12.5px] leading-normal">
          Legion pushes <span className="mono text-[11.5px]">{run.integrationBranch ?? 'the integration branch'}</span>{' '}
          and opens a draft against <span className="mono text-[11.5px]">{run.baseRef}</span>. You approve it here
          first.
        </p>
        <div className="flex flex-col">
          {steps.map((s) => (
            <div key={s.label} className="lg-gate">
              {s.ok === null ? (
                <span className="h-[13px] w-[13px] flex-none rounded-full border-[1.5px] border-surface2" />
              ) : (
                <Check ok={s.ok} />
              )}
              <span className={s.ok ? '' : 'text-subtext0'}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ready: final review + PR draft
// ---------------------------------------------------------------------------------------------

function Ready({ run }: { run: Run }) {
  const item = usePrReady(run.id);
  const review = useFinalReview(run.id);
  const stored = drafts.get(run.id);
  const [title, setTitleState] = useState(stored?.title ?? item?.payload.title ?? run.title);
  const [body, setBodyState] = useState(stored?.body ?? item?.payload.body ?? '');
  const [view, setView] = useState<'preview' | 'edit'>('preview');
  const remember = (next: { title?: string; body?: string }) =>
    drafts.set(run.id, { title: next.title ?? title, body: next.body ?? body });
  const [create, { pending, error }] = useAction(async () => {
    await rpc('runs.createPr', {
      runId: run.id,
      title: title.trim() || null,
      body: body.trim() ? body : null,
    });
  });
  const edited = title !== (item?.payload.title ?? run.title) || body !== (item?.payload.body ?? '');
  const finalizer = useData(
    (s) =>
      attemptsOfRun(s.attempts, run.id)
        .filter((a) => a.role === 'finalizer')
        .at(-1) ?? null,
  );
  const findings = review ? trackFindings([review]) : [];

  return (
    <div className="lg-col" data-testid="pr-tile">
      <div className="lg-scroll lg-pane">
        <div
          className="grid gap-x-8"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))' }}
        >
          <section className="min-w-0" aria-label="Pull request draft">
            <div className="lg-sec flex-wrap gap-y-1.5">
              Pull request
              <span className="lg-sec-aside flex items-center gap-2">
                {edited ? <span style={{ color: 'var(--peach)' }}>edited</span> : <span>generated</span>}
                <Segmented
                  label="Body view"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'preview', label: 'Preview' },
                    { value: 'edit', label: 'Edit' },
                  ]}
                />
              </span>
            </div>
            <input
              className="lg-field mb-2 w-full font-semibold"
              style={{ height: 34, fontSize: 14 }}
              aria-label="Pull request title"
              value={title}
              onChange={(e) => {
                setTitleState(e.target.value);
                remember({ title: e.target.value });
              }}
            />
            {view === 'edit' ? (
              <AutoTextarea
                className="lg-field mono w-full"
                aria-label="Pull request body"
                minRows={10}
                maxRows={40}
                value={body}
                onChange={(e) => {
                  setBodyState(e.target.value);
                  remember({ body: e.target.value });
                }}
              />
            ) : (
              <div className="lg-card lg-pr-preview px-4 py-3" data-testid="pr-preview">
                <Markdown>{body || '_No description._'}</Markdown>
              </div>
            )}
          </section>
          <section className="min-w-0" aria-label="Final review">
            <div className="lg-sec">
              Final review
              <span className="lg-sec-aside flex items-center gap-1.5">
                {finalizer ? (
                  <EngineChip
                    engine={displayEngine(dataStore.getState(), finalizer)}
                    text={`${ENGINE_LABEL[displayEngine(dataStore.getState(), finalizer)]} · base…integration`}
                  />
                ) : null}
                {review ? (
                  <Chip tone={review.verdict === 'approve' ? 'ok' : 'warn'}>{review.verdict.replace('_', ' ')}</Chip>
                ) : null}
              </span>
            </div>
            {review ? (
              <>
                <p className="m-0 text-[12.5px] leading-normal text-subtext1">{review.summary}</p>
                <div className="mt-2.5 flex flex-col gap-1.5 text-[12.5px]">
                  {review.criteria.map((c) => (
                    <div key={c.id} className="flex gap-2">
                      <span className="pt-[2px]">
                        <Check ok={c.status === 'met'} size={12} />
                      </span>
                      <span className="min-w-0 leading-normal">
                        {c.evidence} <span className="faint mono text-[11px]">{c.id}</span>
                      </span>
                    </div>
                  ))}
                </div>
                {findings.length ? (
                  <div className="mt-3 flex flex-col gap-2">
                    {findings.map((f) => (
                      <FindingCard
                        key={f.key}
                        tracked={f}
                        reviewer={displayEngine(dataStore.getState(), finalizer, 'codex')}
                        task={null}
                        scope={run.id}
                        onOpen={() => openTile(run.id, 'diff', { target: { kind: 'run', runId: run.id } })}
                      />
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="faint text-[12.5px]">No final review recorded.</div>
            )}
          </section>
        </div>
      </div>
      <div className="lg-foot">
        {error ? <div className="text-[12px] text-red">{error}</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary lg-btn-lg"
            disabled={pending || !title.trim()}
            onClick={() => void create()}
            data-testid="create-pr"
          >
            {pending ? 'Pushing…' : 'Create draft PR'}
          </button>
          <button
            type="button"
            className="btn btn-ghost lg-btn-lg"
            onClick={() => openTile(run.id, 'diff', { target: { kind: 'run', runId: run.id } })}
          >
            Review the full diff
          </button>
          <span className="faint ml-auto text-[12px]">
            pushes <span className="mono">{run.integrationBranch}</span> · draft against {run.baseRef}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Opened
// ---------------------------------------------------------------------------------------------

const PR_HEADLINE: Record<PrState, (n: string) => string> = {
  open: (n) => `PR ${n} is open`,
  merged: (n) => `PR ${n} is merged`,
  closed: (n) => `PR ${n} was closed`,
};

function Opened({ run, pr }: { run: Run; pr: PullRequestInfo }) {
  const stats = useData(
    useShallow((s) => {
      const tasks = tasksOfRun(s.tasks, run.id);
      const attempts = attemptsOfRun(s.attempts, run.id);
      // Count tasks by the engine that coded them (the planned one in fake mode).
      const engines = tasks.map((t) => {
        const coder = attempts.filter((a) => a.taskId === t.id && a.role === 'coder').at(-1) ?? null;
        return coder ? displayEngine(s, coder) : null;
      });
      return [
        tasks.filter((t) => t.status === 'merged').length,
        engines.filter((e) => e === 'claude').length,
        engines.filter((e) => e === 'codex').length,
        tasks.reduce((n, t) => n + t.fixRounds, 0),
        attempts.reduce((n, a) => n + (a.costUsd ?? 0), 0),
      ] as const;
    }),
  );
  const [merged, claude, codex, fixes, cost] = stats;
  const number = pr.number ? `#${pr.number}` : '';
  const [copied, setCopied] = useState(false);
  const [refresh, refreshing] = useAction(() => refreshPr(run.id));
  const [archive, archiving] = useAction(() => archiveRunInteractively(run));
  const archivable = canArchive(run);
  const elapsed = useMemo(() => formatDuration(run.updatedAt - run.createdAt), [run.updatedAt, run.createdAt]);
  const headline = pr.state === 'open' && pr.isDraft ? `Draft PR ${number} is open` : PR_HEADLINE[pr.state](number);
  const note =
    pr.state === 'merged'
      ? 'Merged on GitHub. Archive the run to clean up its worktrees and branches.'
      : pr.state === 'closed'
        ? 'Closed without merging. Archive the run to clean up, or reopen it on GitHub.'
        : pr.isDraft
          ? 'Mark it ready for review on GitHub when you are happy with it.'
          : 'Waiting for review on GitHub.';
  return (
    <div className="lg-col lg-pr-opened" data-testid="pr-opened" data-pr-state={pr.state}>
      <div className="lg-scroll flex flex-col px-6 py-6">
        {/* my-auto (not justify-center): centred when it fits, scrollable from the top when it doesn't. */}
        <div className="my-auto flex flex-col items-center text-center">
          <div className="lg-done-ring lg-done-ring-sm lg-rise flex-none" data-state={pr.state}>
            {pr.state === 'closed' ? (
              <Icon name="close" size={26} strokeWidth={2.4} />
            ) : pr.state === 'merged' ? (
              <Icon name="merge" size={26} strokeWidth={2.2} />
            ) : (
              <Icon name="check" size={28} strokeWidth={2.4} />
            )}
          </div>
          <div className="lg-rise mt-4 text-[17px] font-semibold" style={{ animationDelay: '80ms' }}>
            {headline}
          </div>
          <div
            className="lg-rise muted mt-1 max-w-[380px] text-[12.5px] leading-normal"
            style={{ animationDelay: '120ms' }}
          >
            {run.title}. {note}
          </div>
          <div
            className="lg-rise mono faint mt-2 max-w-full truncate text-[11.5px]"
            style={{ animationDelay: '160ms' }}
          >
            {pr.url}
          </div>
          <div className="lg-rise mt-3.5 flex flex-wrap justify-center gap-2" style={{ animationDelay: '200ms' }}>
            {archivable && pr.state !== 'open' ? (
              <button
                type="button"
                className="btn btn-primary lg-btn-lg"
                onClick={() => void archive()}
                disabled={archiving.pending}
                data-testid="pr-archive"
                title="Remove the run's worktrees and hide it from the rail"
              >
                <Icon name="archive" size={14} />
                {archiving.pending ? 'Archiving…' : 'Archive run'}
              </button>
            ) : null}
            <button
              type="button"
              className={archivable && pr.state !== 'open' ? 'btn lg-btn-lg' : 'btn btn-primary lg-btn-lg'}
              onClick={() => openExternal(pr.url)}
              data-testid="open-github"
            >
              Open on GitHub
              <Icon name="external" size={13} />
            </button>
            <button
              type="button"
              className="btn lg-btn-lg"
              onClick={() => {
                void navigator.clipboard?.writeText(pr.url).then(() => setCopied(true));
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          {archiving.error || refreshing.error ? (
            <div className="mt-2 text-[12px] text-red" role="alert">
              {archiving.error ?? refreshing.error}
            </div>
          ) : null}
          <div
            className="lg-rise mono faint mt-7 flex flex-wrap justify-center gap-x-8 gap-y-3 text-[11.5px]"
            style={{ animationDelay: '260ms' }}
          >
            <Stat label="tasks merged" value={`${merged}`} />
            <Stat
              label="coded by"
              value={
                [claude ? `${claude} claude` : null, codex ? `${codex} codex` : null].filter(Boolean).join(' · ') || '—'
              }
            />
            <Stat label="fix rounds" value={`${fixes}`} />
            <Stat label={cost ? 'spent' : 'elapsed'} value={cost ? formatCost(cost) : elapsed} />
          </div>
        </div>
      </div>
      <div className="lg-foot">
        <div className="faint flex items-center gap-2 text-[12px]">
          <Chip tone={pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'idle' : 'ok'}>
            {pr.state === 'open' && pr.isDraft ? 'draft' : pr.state}
          </Chip>
          <span className="mono truncate">{run.integrationBranch}</span>
          {pr.state === 'open' ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm ml-auto"
              onClick={() => void refresh()}
              disabled={refreshing.pending}
              title={commandTooltip('run.refreshPr', 'Check GitHub for the PR state')}
            >
              <Icon name="refresh" size={12} />
              {refreshing.pending ? 'Checking…' : 'Refresh status'}
            </button>
          ) : isArchived(run) ? (
            <span className="ml-auto">archived · worktrees removed</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 whitespace-nowrap">
      <span className="text-[13px] text-text">{value}</span>
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------------------------

export function Card({ runId }: TileCardProps<'pr'>) {
  const run = useRun(runId);
  const item = usePrReady(runId);
  const review = useFinalReview(runId);
  const merged = useData((s) => tasksOfRun(s.tasks, runId).filter((t) => t.status === 'merged').length);
  const total = useData((s) => tasksOfRun(s.tasks, runId).length);
  const pr = runPr(run);
  if (pr)
    return (
      <>
        <div>
          {pr.state === 'open' && pr.isDraft ? 'draft PR' : 'PR'} {pr.number ? `#${pr.number}` : ''}{' '}
          {pr.state === 'open' ? 'open' : pr.state}
        </div>
        <div>{pr.url}</div>
        <div>
          {merged}/{total} tasks merged
        </div>
      </>
    );
  return (
    <>
      <div>{item ? item.payload.title : 'draft PR not opened yet'}</div>
      <div>
        {merged}/{total} tasks merged
      </div>
      <div>{review ? `final review: ${review.verdict.replace('_', ' ')}` : 'final review pending'}</div>
    </>
  );
}
