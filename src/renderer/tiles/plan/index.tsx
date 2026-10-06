/**
 * Plan tile: the plan document (rendered, or raw markdown to edit), what clarify settled, assumptions,
 * global verification and the estimate; the sign-off footer while the plan awaits approval, and a drift
 * indicator (work outside the plan's declared scope) once it executes.
 */
import { checkScope } from '@engine/orchestrator/core/scope';
import type { InboxItemOf, Plan, QuestionAnswer, Run } from '@shared/domain';
import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { attemptsOfRun, tasksOfRun } from '../../app/data';
import { useData, useLatestPlan, useRun } from '../../app/hooks';
import { Bar, Chip, EngineChip, Kbd } from '../../chrome/ui';
import { ENGINE_LABEL, formatClock } from '../../layout/describe';
import type { TileCardProps, TileProps } from '../../layout/types';
import { approvePlan, registerPlanCommands, requestRevision, useSignoff } from './actions';
import { discardEdits, editPlan, keepMine, type PlanDraft, undoEdit, useAnalysis, usePlanDraft } from './draft';
import { InlineComposer, Markdown, Segmented, useTileKeys } from './kit';
import {
  findSection,
  formatCostRange,
  listItems,
  PLAN_SIDE_SECTIONS,
  type PlanAnalysis,
  verificationCommands,
  withoutSections,
} from './model';

registerPlanCommands();

type View = 'doc' | 'md';

export default function PlanTile({ runId, params }: TileProps<'plan'>) {
  const run = useRun(runId);
  const latest = useLatestPlan(runId);
  const pinned = useData((s) => (params.planId ? (s.plans[params.planId] ?? null) : null));
  const historical = pinned !== null && pinned.id !== latest?.id;
  const draft = usePlanDraft(runId);
  const plan = historical ? pinned : latest;
  const editable =
    !historical && !!plan && run?.status === 'awaiting_approval' && plan.approvedAt === null && draft !== null;
  const markdown = historical || !draft ? (plan?.markdown ?? '') : draft.markdown;
  const dag = historical || !draft ? (plan?.dag ?? null) : draft.dag;
  const analysis = useAnalysis(dag);
  const [view, setView] = useState<View>('doc');
  const root = useRef<HTMLDivElement>(null);
  useTileKeys(root, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === 'm' || e.key === 'M') {
      setView((v) => (v === 'doc' ? 'md' : 'doc'));
      return true;
    }
    return false;
  });

  if (!run) return null;
  if (!plan) return <Drafting run={run} />;

  return (
    <div ref={root} className="lg-col" data-testid="plan-tile">
      <div className="lg-bar">
        <EngineChip engine={run.plannerEngine} text={`${ENGINE_LABEL[run.plannerEngine]} · planner`} />
        <span className="faint truncate text-[12px]">
          v{plan.version}
          {plan.source === 'user' ? ' · edited by you' : ''}
          {historical ? ' · older version' : ''}
        </span>
        <span className="flex-1" />
        {editable && draft ? <SaveState draft={draft} errors={analysis?.validation.errors.length ?? 0} /> : null}
        <Segmented<View>
          label="Plan view"
          value={view}
          onChange={setView}
          options={[
            { value: 'doc', label: 'Doc', title: 'Rendered plan  M' },
            { value: 'md', label: 'MD', title: editable ? 'Edit the markdown  M' : 'Raw markdown  M' },
          ]}
        />
      </div>
      {editable && draft?.status === 'conflict' ? <ConflictBanner runId={runId} draft={draft} /> : null}
      {view === 'md' ? (
        <div className="lg-scroll">
          <textarea
            className="lg-editor"
            aria-label="Plan markdown"
            spellCheck={false}
            readOnly={!editable}
            value={markdown}
            onChange={(e) => {
              const value = e.target.value;
              editPlan(runId, 'markdown', () => ({ markdown: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (e.target as HTMLElement).closest<HTMLElement>('[data-tile-id]')?.focus();
            }}
          />
        </div>
      ) : (
        <div className="lg-scroll">
          <PlanDocument run={run} plan={plan} markdown={markdown} />
        </div>
      )}
      <PlanFooter run={run} plan={plan} analysis={analysis} editable={editable} />
    </div>
  );
}

function Drafting({ run }: { run: Run }) {
  const drafting = run.status === 'planning' || run.status === 'clarifying' || run.status === 'draft';
  return (
    <div className="lg-col">
      <div className="lg-scroll lg-pane">
        <div className="flex items-center gap-2 text-[13px]">
          {drafting ? <span className="dot live" style={{ color: 'var(--blue)' }} /> : null}
          <span className="font-semibold">
            {run.status === 'clarifying'
              ? 'Waiting for your answers'
              : drafting
                ? `${ENGINE_LABEL[run.plannerEngine]} is reading the repo`
                : 'No plan'}
          </span>
        </div>
        <p className="muted mt-2 mb-4 text-[12.5px] leading-relaxed">
          {drafting
            ? 'The plan appears here once the planner has a task graph. You review it, edit anything, then approve.'
            : 'This run has no plan.'}
        </p>
        {run.issueText ? (
          <>
            <div className="lg-sec">Issue</div>
            <Markdown>{run.issueText}</Markdown>
          </>
        ) : null}
        <div className="mt-5 flex flex-col gap-2.5" aria-hidden="true">
          {[86, 64, 92, 48].map((w) => (
            <div key={w} className="h-2.5 rounded bg-surface0/60" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SaveState({ draft, errors }: { draft: PlanDraft; errors: number }) {
  const map: Record<PlanDraft['status'], { text: string; color: string }> = {
    clean: { text: '', color: '' },
    pending: { text: 'Unsaved', color: 'var(--overlay2)' },
    saving: { text: 'Saving…', color: 'var(--overlay2)' },
    saved: { text: 'Saved', color: 'var(--overlay2)' },
    invalid: { text: `Not saved · ${errors} problem${errors === 1 ? '' : 's'}`, color: 'var(--peach)' },
    conflict: { text: 'Newer version', color: 'var(--peach)' },
    error: { text: 'Save failed', color: 'var(--red)' },
  };
  const { text, color } = map[draft.status];
  if (!text) return null;
  return (
    <span
      className="flex flex-none items-center gap-1.5 whitespace-nowrap text-[11.5px]"
      style={{ color }}
      title={draft.error ?? undefined}
    >
      {text}
      {draft.undo && draft.status !== 'saving' ? (
        <button
          type="button"
          className="lg-link text-[11.5px]"
          onClick={() => undoEdit(draft.runId)}
          title={`Undo ${draft.undo.label}`}
        >
          Undo
        </button>
      ) : null}
    </span>
  );
}

function ConflictBanner({ runId, draft }: { runId: string; draft: PlanDraft }) {
  return (
    <div className="px-3 pt-2">
      <div className="lg-callout" role="alert">
        <span style={{ color: 'var(--peach)' }}>Newer plan</span>
        <span className="muted flex-1">{draft.error}</span>
        <button type="button" className="btn btn-ghost" onClick={() => keepMine(runId)}>
          Keep my edits
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => discardEdits(runId)}>
          Use theirs
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

function useClarifyAnswers(runId: string): { question: string; answer: string }[] {
  const items = useData(
    useShallow((s): InboxItemOf<'question'>[] =>
      Object.values(s.inbox).filter(
        (i): i is InboxItemOf<'question'> =>
          i.runId === runId && i.kind === 'question' && i.payload.source === 'clarify' && i.resolution !== null,
      ),
    ),
  );
  return useMemo(
    () =>
      items
        .sort((a, b) => a.createdAt - b.createdAt)
        .flatMap((item) =>
          item.payload.questions.map((q) => ({
            question: q.question,
            answer:
              (item.resolution as { answers: QuestionAnswer[] } | null)?.answers.find((a) => a.questionId === q.id)
                ?.answer ?? '—',
          })),
        ),
    [items],
  );
}

function PlanDocument({ run, plan, markdown }: { run: Run; plan: Plan; markdown: string }) {
  const answers = useClarifyAnswers(run.id);
  const assumptions = findSection(markdown, ['Assumptions']);
  const verification = findSection(markdown, ['Verification', 'Global verification']);
  const body = withoutSections(markdown, PLAN_SIDE_SECTIONS);
  const executing = plan.approvedAt !== null;
  return (
    <div className="lg-pane">
      {executing ? <Drift runId={run.id} plan={plan} /> : null}
      {plan.feedback ? (
        <div className="lg-callout mb-3" data-tone="info">
          <span style={{ color: 'var(--blue)' }}>v{plan.version} revised</span>
          <span className="muted flex-1">“{plan.feedback}”</span>
        </div>
      ) : null}
      <Markdown>{body}</Markdown>
      {answers.length > 0 ? (
        <>
          <div className="lg-sec">From clarify</div>
          <div className="flex flex-col gap-2 text-[12.5px] leading-normal">
            {answers.map((a) => (
              <div key={a.question}>
                <div className="faint">{a.question}</div>
                <div>{a.answer}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {assumptions ? (
        <>
          <div className="lg-sec">Assumptions</div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12.5px] leading-normal">
            {listItems(assumptions.body).map((item) => (
              <li key={item} className="flex gap-2">
                <span className="faint mt-[1px] flex-none">◇</span>
                <Markdown className="[&_p]:m-0 [&_p]:text-subtext1">{item}</Markdown>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {verification ? (
        <>
          <div className="lg-sec">Global verification</div>
          <div className="lg-block">{verificationCommands(verification.body).join(' && ')}</div>
        </>
      ) : null}
    </div>
  );
}

/** Work outside the plan: files the agents changed that no task declared. */
function Drift({ runId, plan }: { runId: string; plan: Plan }) {
  const offPlan = useData(
    useShallow((s) => {
      const out: string[] = [];
      for (const task of tasksOfRun(s.tasks, runId)) {
        const node = plan.dag.nodes.find((n) => n.id === task.nodeId);
        if (!node) continue;
        const files = new Set<string>();
        for (const a of attemptsOfRun(s.attempts, runId))
          if (a.taskId === task.id && a.role !== 'reviewer')
            for (const f of s.diffstats[a.id]?.files ?? []) files.add(f);
        for (const path of checkScope(node, [...files]).outOfScope) out.push(`${task.nodeId}\u0000${path}`);
      }
      return out;
    }),
  );
  const rows = offPlan.map((s) => s.split('\u0000') as [string, string]);
  if (rows.length === 0)
    return (
      <div className="mb-3 flex items-center gap-2 text-[12px]">
        <Chip tone="ok">on plan</Chip>
        <span className="faint">every change so far is inside a task’s declared files</span>
      </div>
    );
  return (
    <div className="lg-callout mb-3" style={{ alignItems: 'flex-start' }}>
      <div className="flex w-full flex-col gap-1 py-0.5 pr-1">
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--peach)' }}>Drift</span>
          <span className="muted">
            {rows.length} file{rows.length === 1 ? '' : 's'} changed outside the plan
          </span>
        </div>
        {rows.slice(0, 4).map(([nodeId, path]) => (
          <div key={`${nodeId}${path}`} className="mono text-[11.5px]">
            <span className="faint">{nodeId}</span> {path}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------------------------

export function EstimateLine({ analysis }: { analysis: PlanAnalysis | null }) {
  const est = analysis?.estimate;
  if (!analysis || !est) return null;
  return (
    <div className="lg-meta" title={`critical path ${est.criticalPath.join(' → ')}`}>
      <span>{est.tasks} tasks</span>
      <span>max {est.maxParallel} parallel</span>
      <span>est. {formatCostRange([est.costLow, est.costHigh])}</span>
      <span>~{est.minutes} min</span>
    </div>
  );
}

function PlanFooter({
  run,
  plan,
  analysis,
  editable,
}: {
  run: Run;
  plan: Plan;
  analysis: PlanAnalysis | null;
  editable: boolean;
}) {
  const signoff = useSignoff(run.id);
  const [revising, setRevising] = useState(false);
  const progress = useData(
    useShallow((s) => {
      const tasks = tasksOfRun(s.tasks, run.id);
      return [tasks.filter((t) => t.status === 'merged').length, tasks.length] as const;
    }),
  );
  const problems = analysis?.validation.errors ?? [];

  if (plan.approvedAt !== null) {
    const [merged, total] = progress;
    return (
      <div className="lg-foot">
        <div className="flex items-center gap-2 text-[12px]">
          <span style={{ color: 'var(--green)' }}>✓</span>
          <span>
            Approved {formatClock(plan.approvedAt)} · v{plan.version}
          </span>
          <span className="faint ml-auto mono text-[11.5px]">
            {merged}/{total} merged
          </span>
          <Bar pct={total ? (merged / total) * 100 : 0} color="var(--green)" width={64} />
        </div>
      </div>
    );
  }
  if (run.status === 'planning')
    return (
      <div className="lg-foot">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="dot live" style={{ color: 'var(--blue)' }} />
          <span>{ENGINE_LABEL[run.plannerEngine]} is revising the plan</span>
          <span className="faint ml-auto">v{plan.version + 1} will need your sign-off</span>
        </div>
      </div>
    );
  if (!editable) return null;

  return (
    <div className="lg-foot" data-testid="plan-signoff">
      <EstimateLine analysis={analysis} />
      {problems.length > 0 ? (
        <div className="text-[12px] leading-normal" style={{ color: 'var(--peach)' }}>
          {problems.length === 1 ? 'Fix before approving: ' : `${problems.length} problems to fix, first: `}
          <span className="text-subtext1">{problems[0]?.message}</span>
        </div>
      ) : null}
      {signoff.error ? <div className="text-[12px] text-red">{signoff.error}</div> : null}
      {revising ? (
        <InlineComposer
          placeholder="What should the planner change? e.g. “Split T4; keep German out of this run.”"
          submitLabel="Send to planner"
          tone="warn"
          hint={`v${plan.version + 1} comes back for sign-off`}
          onCancel={() => setRevising(false)}
          onSubmit={async (text) => {
            await requestRevision(run.id, text);
            setRevising(false);
          }}
        />
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary lg-btn-lg flex-1"
            disabled={signoff.pending !== null || problems.length > 0}
            onClick={() => void approvePlan(run.id)}
            data-testid="approve-plan"
          >
            {signoff.pending === 'approve' ? 'Starting…' : 'Approve & start'}
            <Kbd>⌘⏎</Kbd>
          </button>
          <button type="button" className="btn lg-btn-lg" onClick={() => setRevising(true)}>
            Ask for revision
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------------------------

export function Card({ runId }: TileCardProps<'plan'>) {
  const plan = useLatestPlan(runId);
  const analysis = useAnalysis(plan?.dag ?? null);
  const merged = useData((s) => tasksOfRun(s.tasks, runId).filter((t) => t.status === 'merged').length);
  if (!plan || !analysis) return <div>planner is drafting the DAG</div>;
  const est = analysis.estimate;
  const overlap = analysis.overlaps[0];
  return (
    <>
      <div>
        {plan.dag.nodes.length} tasks{est ? ` · max ${est.maxParallel} parallel` : ''}
        {plan.approvedAt ? ` · ${merged} merged` : ''}
      </div>
      <div>{est ? `est. ${formatCostRange([est.costLow, est.costHigh])} · ~${est.minutes} min` : ''}</div>
      <div>
        {overlap
          ? `overlap: ${overlap.to} now runs after ${overlap.from}`
          : `critical path ${(est?.criticalPath ?? []).join(' → ')}`}
      </div>
    </>
  );
}
