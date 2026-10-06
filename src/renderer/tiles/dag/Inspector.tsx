/**
 * Node inspector under the DAG: every field of a task node. Editable while the plan awaits sign-off
 * (changes go into the shared plan draft and are saved with `runs.updatePlan`); read-only with live task
 * status afterwards.
 */
import {
  EFFORTS,
  type Effort,
  type PlanDag,
  type RealEngineKind,
  type Risk,
  TASK_KINDS,
  type TaskKind,
  type TaskNode,
  type TaskSize,
  type Touch,
  type TouchMode,
} from '@shared/domain';
import { type RefObject, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { latestAttempt, latestReview, tasksOfRun } from '../../app/data';
import { useData } from '../../app/hooks';
import { actions, dataStore } from '../../app/store';
import { EngineChip, StatusChipView } from '../../chrome/ui';
import { describeTile, ENGINE_LABEL, ENGINE_NAME, otherEngine } from '../../layout/describe';
import type { LayoutTile } from '../../layout/tree';
import { editPlan } from '../plan/draft';
import { AutoTextarea, openTile } from '../plan/kit';
import {
  addDependency,
  isAutoEdge,
  type PlanAnalysis,
  removeDependency,
  removeNode,
  sharedWrites,
  updateNode,
} from '../plan/model';

const ENGINES: readonly RealEngineKind[] = ['claude', 'codex'];
const SIZES: readonly TaskSize[] = ['S', 'M', 'L'];
const RISKS: readonly Risk[] = ['low', 'med', 'high'];
const MODES: readonly TouchMode[] = ['modify', 'create', 'read'];

export function DagInspector({
  runId,
  dag,
  node,
  editable,
  analysis,
  titleRef,
  onSelect,
}: {
  runId: string;
  dag: PlanDag;
  node: TaskNode;
  editable: boolean;
  analysis: PlanAnalysis | null;
  titleRef: RefObject<HTMLInputElement | null>;
  onSelect: (id: string | null) => void;
}) {
  const update = (label: string, fn: (n: TaskNode) => TaskNode) =>
    editPlan(runId, label, (d) => ({ dag: updateNode(d.dag, node.id, fn) }));
  const problems = analysis?.validation.errors.filter((e) => e.nodeIds.includes(node.id)) ?? [];
  const shared = useMemo(() => sharedWrites(dag, node.id), [dag, node.id]);
  const reviewer = otherEngine(node.agent.engine);

  return (
    <div
      className="lg-card mx-2.5 mb-2.5 flex max-h-[42%] min-h-[140px] flex-none flex-col overflow-hidden"
      data-testid="dag-inspector"
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--hairline)] px-3.5 py-2">
        <span className="tile-id">{node.id}</span>
        {editable ? (
          <input
            ref={titleRef}
            className="lg-field min-w-0 flex-1 font-semibold"
            aria-label="Task title"
            value={node.title}
            onChange={(e) => {
              const title = e.target.value;
              update('title', (n) => ({ ...n, title }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape')
                (e.target as HTMLElement).closest<HTMLElement>('[data-tile-id]')?.focus();
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-semibold">{node.title}</span>
        )}
        {editable ? (
          <span className="flex flex-none items-center gap-1.5">
            <Select
              label="Kind"
              value={node.kind}
              options={TASK_KINDS}
              onChange={(kind) => update('kind', (n) => ({ ...n, kind: kind as TaskKind }))}
            />
            <Select
              label="Size"
              value={node.size}
              options={SIZES}
              format={(s) => `size ${s}`}
              onChange={(size) => update('size', (n) => ({ ...n, size: size as TaskSize }))}
            />
            <Select
              label="Risk"
              value={node.risk}
              options={RISKS}
              format={(r) => `risk ${r}`}
              onChange={(risk) => update('risk', (n) => ({ ...n, risk: risk as Risk }))}
            />
          </span>
        ) : (
          <span className="faint flex-none text-[12px]">
            {node.kind} · size {node.size} · risk {node.risk}
          </span>
        )}
      </div>
      <div className="lg-scroll px-3.5 py-3">
        {problems.length > 0 ? (
          <div className="mb-3 flex flex-col gap-1 text-[12px]" style={{ color: 'var(--red)' }}>
            {problems.map((p) => (
              <div key={p.message}>{p.message}</div>
            ))}
          </div>
        ) : null}
        {!editable ? <LiveStatus runId={runId} node={node} /> : null}
        <div className="lg-kv">
          <span className="lg-k">Engine</span>
          <span className="flex flex-wrap items-center gap-2">
            {editable ? (
              <>
                <select
                  className="lg-field"
                  aria-label="Coder engine"
                  value={node.agent.engine}
                  onChange={(e) => {
                    const engine = e.target.value as RealEngineKind;
                    update('engine', (n) => ({ ...n, agent: { ...n.agent, engine, model: null } }));
                  }}
                >
                  {ENGINES.map((e) => (
                    <option key={e} value={e}>
                      {ENGINE_NAME[e]}
                    </option>
                  ))}
                </select>
                <select
                  className="lg-field"
                  aria-label="Reasoning effort"
                  value={node.agent.effort ?? ''}
                  onChange={(e) => {
                    const effort = (e.target.value || null) as Effort | null;
                    update('effort', (n) => ({ ...n, agent: { ...n.agent, effort } }));
                  }}
                >
                  <option value="">default effort</option>
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
                <CommitInput
                  className="lg-field mono w-[130px]"
                  label="Model"
                  placeholder="default model"
                  value={node.agent.model ?? ''}
                  onCommit={(model) => update('model', (n) => ({ ...n, agent: { ...n.agent, model: model || null } }))}
                />
              </>
            ) : (
              <EngineChip
                engine={node.agent.engine}
                text={[ENGINE_LABEL[node.agent.engine], node.agent.model, node.agent.effort]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
            <span className="faint text-[12px]">
              reviewer: {ENGINE_NAME[reviewer]} (the other engine, set automatically)
            </span>
          </span>

          <span className="lg-k">Goal</span>
          {editable ? (
            <AutoTextarea
              className="lg-field w-full"
              aria-label="Goal"
              minRows={1}
              maxRows={5}
              value={node.goal}
              onChange={(e) => {
                const goal = e.target.value;
                update('goal', (n) => ({ ...n, goal }));
              }}
            />
          ) : (
            <span className="pt-1 text-subtext1 leading-normal">{node.goal}</span>
          )}

          <span className="lg-k">Depends on</span>
          <Dependencies runId={runId} dag={dag} node={node} editable={editable} onSelect={onSelect} />

          <span className="lg-k">Touches</span>
          <div className="flex flex-col gap-1.5">
            {node.touches.length === 0 ? <span className="faint pt-1">nothing declared</span> : null}
            {node.touches.map((touch, i) => (
              <TouchRow
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while editing
                key={i}
                touch={touch}
                editable={editable}
                sharedWith={shared.get(touch.glob) ?? []}
                onChange={(next) =>
                  update('touch', (n) => ({ ...n, touches: n.touches.map((t, j) => (j === i ? next : t)) }))
                }
                onRemove={() => update('remove touch', (n) => ({ ...n, touches: n.touches.filter((_, j) => j !== i) }))}
              />
            ))}
            {editable ? (
              <AddRow
                label="+ touch"
                placeholder="web/src/pages/auth/**"
                onAdd={(glob) =>
                  update('add touch', (n) => ({ ...n, touches: [...n.touches, { glob, mode: 'modify' }] }))
                }
              />
            ) : null}
          </div>

          <span className="lg-k">Acceptance</span>
          <div className="flex flex-col gap-1.5">
            {node.acceptanceCriteria.length === 0 ? (
              <span className="pt-1 text-[12px]" style={{ color: editable ? 'var(--red)' : undefined }}>
                none yet: the reviewer needs at least one
              </span>
            ) : null}
            {node.acceptanceCriteria.map((c, i) =>
              editable ? (
                <span key={c.id} className="flex items-center gap-2">
                  <span className="faint mono w-7 flex-none text-[11px]">{c.id}</span>
                  <input
                    className="lg-field min-w-0 flex-1"
                    aria-label={`Criterion ${c.id}`}
                    value={c.text}
                    aria-invalid={!c.text.trim()}
                    onChange={(e) => {
                      const text = e.target.value;
                      update('criterion', (n) => ({
                        ...n,
                        acceptanceCriteria: n.acceptanceCriteria.map((x, j) => (j === i ? { ...x, text } : x)),
                      }));
                    }}
                  />
                  <RemoveButton
                    label={`Remove ${c.id}`}
                    onClick={() =>
                      update('remove criterion', (n) => ({
                        ...n,
                        acceptanceCriteria: n.acceptanceCriteria.filter((_, j) => j !== i),
                      }))
                    }
                  />
                </span>
              ) : (
                <span key={c.id} className="flex gap-2 pt-0.5 leading-normal">
                  <span className="faint mono w-7 flex-none pt-[1px] text-[11px]">{c.id}</span>
                  <span>{c.text}</span>
                </span>
              ),
            )}
            {editable ? (
              <AddRow
                label="+ criterion"
                placeholder="Keys are namespaced auth.*"
                onAdd={(text) =>
                  update('add criterion', (n) => {
                    const max = Math.max(0, ...n.acceptanceCriteria.map((c) => Number(c.id.replace(/\D/g, '')) || 0));
                    return { ...n, acceptanceCriteria: [...n.acceptanceCriteria, { id: `AC${max + 1}`, text }] };
                  })
                }
              />
            ) : null}
          </div>

          <span className="lg-k">Verify</span>
          <div className="flex flex-col gap-1.5">
            {node.verify.commands.map((cmd, i) =>
              editable ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while editing
                <span key={i} className="flex items-center gap-2">
                  <CommitInput
                    className="lg-field mono min-w-0 flex-1"
                    label={`Verify command ${i + 1}`}
                    value={cmd}
                    onCommit={(value) =>
                      update('verify', (n) => ({
                        ...n,
                        verify: { commands: n.verify.commands.map((c, j) => (j === i ? value : c)).filter(Boolean) },
                      }))
                    }
                  />
                  <RemoveButton
                    label="Remove command"
                    onClick={() =>
                      update('remove verify', (n) => ({
                        ...n,
                        verify: { commands: n.verify.commands.filter((_, j) => j !== i) },
                      }))
                    }
                  />
                </span>
              ) : (
                <span key={cmd} className="mono pt-0.5 text-[11.5px] text-subtext1">
                  {cmd}
                </span>
              ),
            )}
            {editable ? (
              <AddRow
                label="+ command"
                placeholder="pnpm test pages/auth"
                mono
                onAdd={(cmd) =>
                  update('add verify', (n) => ({ ...n, verify: { commands: [...n.verify.commands, cmd] } }))
                }
              />
            ) : null}
          </div>
        </div>
        {editable ? (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--red)' }}
              onClick={() => {
                editPlan(runId, `remove ${node.id}`, (d) => ({ dag: removeNode(d.dag, node.id) }));
                onSelect(null);
              }}
            >
              Remove {node.id}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  format?: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <select className="lg-field" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {format ? format(o) : o}
        </option>
      ))}
    </select>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="lg-x" aria-label={label} title={label} onClick={onClick}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** A text input that commits on blur / Enter (structural fields: globs, commands, model). */
function CommitInput({
  value,
  onCommit,
  label,
  className,
  placeholder,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  className: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };
  return (
    <input
      className={className}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function AddRow({
  label,
  placeholder,
  onAdd,
  mono,
}: {
  label: string;
  placeholder: string;
  onAdd: (value: string) => void;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open)
    return (
      <span>
        <button type="button" className="lg-link text-[12px]" onClick={() => setOpen(true)}>
          {label}
        </button>
      </span>
    );
  const done = (commit: boolean) => {
    if (commit && text.trim()) onAdd(text.trim());
    setText('');
    setOpen(false);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
      autoFocus
      className={`lg-field ${mono ? 'mono' : ''}`}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
      }}
    />
  );
}

function TouchRow({
  touch,
  editable,
  sharedWith,
  onChange,
  onRemove,
}: {
  touch: Touch;
  editable: boolean;
  sharedWith: string[];
  onChange: (touch: Touch) => void;
  onRemove: () => void;
}) {
  const modeColor = touch.mode === 'read' ? 'var(--overlay2)' : 'var(--yellow)';
  const shared =
    sharedWith.length > 0 && touch.mode !== 'read' ? (
      <span className="text-[11.5px]" style={{ color: 'var(--peach)' }}>
        · shared with {sharedWith.join(', ')}
      </span>
    ) : null;
  if (!editable)
    return (
      <span className="mono flex items-baseline gap-2 pt-0.5 text-[11.5px]">
        <span className="w-12 flex-none" style={{ color: modeColor }}>
          {touch.mode}
        </span>
        <span className="min-w-0 break-all">{touch.glob}</span>
        {shared}
      </span>
    );
  return (
    <span className="flex items-center gap-2">
      <select
        className="lg-field mono w-[86px] flex-none"
        style={{ color: modeColor }}
        aria-label="Touch mode"
        value={touch.mode}
        onChange={(e) => onChange({ ...touch, mode: e.target.value as TouchMode })}
      >
        {MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <CommitInput
        className="lg-field mono min-w-0 flex-1"
        label="Path or glob"
        value={touch.glob}
        onCommit={(glob) => (glob ? onChange({ ...touch, glob }) : onRemove())}
      />
      {shared}
      <RemoveButton label="Remove touch" onClick={onRemove} />
    </span>
  );
}

function Dependencies({
  runId,
  dag,
  node,
  editable,
  onSelect,
}: {
  runId: string;
  dag: PlanDag;
  node: TaskNode;
  editable: boolean;
  onSelect: (id: string) => void;
}) {
  const candidates = dag.nodes
    .filter((n) => n.id !== node.id && !node.dependsOn.includes(n.id))
    .filter((n) => addDependency(dag, n.id, node.id).ok);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {node.dependsOn.length === 0 ? <span className="faint">nothing: starts right away</span> : null}
      {node.dependsOn.map((dep) => {
        const auto = isAutoEdge(dag, dep, node.id);
        return (
          <span key={dep} className="lg-tag" data-tone={auto ? 'warn' : undefined}>
            <button
              type="button"
              className="lg-link"
              style={{ color: 'inherit' }}
              onClick={() => onSelect(dep)}
              title={`Select ${dep}`}
            >
              {dep}
            </button>
            {auto ? <span className="font-sans text-[11px]">added for overlap</span> : null}
            {editable ? (
              <RemoveButton
                label={`Remove dependency on ${dep}`}
                onClick={() =>
                  editPlan(runId, `remove ${dep}→${node.id}`, (d) => ({
                    dag: removeDependency(d.dag, dep, node.id),
                  }))
                }
              />
            ) : (
              <span className="w-1" />
            )}
          </span>
        );
      })}
      {editable && candidates.length > 0 ? (
        <select
          className="lg-field h-[24px] text-[12px]"
          aria-label="Add dependency"
          value=""
          onChange={(e) => {
            const from = e.target.value;
            if (!from) return;
            editPlan(runId, `add ${from}→${node.id}`, (d) => {
              const result = addDependency(d.dag, from, node.id);
              return result.ok ? { dag: result.dag } : {};
            });
          }}
        >
          <option value="">+ depends on…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.title}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}

/** Read-only live status of the node's task (after approval). */
function LiveStatus({ runId, node }: { runId: string; node: TaskNode }) {
  const deps = useData(useShallow((s) => [s.tasks, s.attempts, s.reviews, s.inbox]));
  const info = useMemo(() => {
    const state = dataStore.getState();
    const task = tasksOfRun(state.tasks, runId).find((t) => t.nodeId === node.id) ?? null;
    if (!task) return null;
    const tile: LayoutTile = {
      id: `session:${node.id}`,
      kind: 'session',
      params: { taskId: task.id, attemptId: null },
      auto: true,
    };
    const meta = describeTile(state, runId, tile);
    const coder = latestAttempt(state, task, 'coder');
    const review = latestReview(state, task.id, runId);
    return { task, meta, coder, review };
  }, [runId, node.id, ...deps]);
  if (!info) return null;
  const { task, meta, coder, review } = info;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
      {meta.status ? <StatusChipView status={meta.status} /> : null}
      {coder ? <span className="faint">attempt {task.attemptCount || 1}</span> : null}
      {task.fixRounds ? (
        <span className="faint">
          · {task.fixRounds} fix round{task.fixRounds === 1 ? '' : 's'}
        </span>
      ) : null}
      {review ? <span className="faint">· review: {review.verdict.replace('_', ' ')}</span> : null}
      <span className="flex-1" />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => actions.revealTile(runId, `session:${node.id}`, null)}
      >
        Session →
      </button>
      {review ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => openTile(runId, 'review', { taskId: task.id })}
        >
          Review →
        </button>
      ) : null}
    </div>
  );
}
