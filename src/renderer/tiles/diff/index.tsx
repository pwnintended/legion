/**
 * Diff tile: a task's changes (`diff.get` task range) or the whole run (`base...integration`). File tabs with
 * +/−, per-file collapse (large files start collapsed), virtualized rows, Shiki highlighting of the hunks
 * on screen (in a worker), review findings anchored at file:line, "since round N", j/k hunks, n findings.
 */

import type { EngineKind, Review, Task } from '@shared/domain';
import type { DiffFile, DiffTarget } from '@shared/rpc';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { attemptsOfRun, reviewsOfRun, tasksOfRun } from '../../app/data';
import { useData, useLatestPlan, useRun, useSettings } from '../../app/hooks';
import { Chip } from '../../chrome/ui';
import { otherEngine } from '../../layout/describe';
import type { TileCardProps, TileProps } from '../../layout/types';
import { Segmented, useTileKeys } from '../plan/kit';
import { filesChangedSince, type TrackedFinding, trackFindings } from '../review/evidence';
import { FindingCard } from '../review/findings';
import { diffFocus, targetKey, useDiff } from './data';
import { highlighted, requestHighlight, type Tok, useHighlightVersion } from './highlight';
import { buildRows, defaultCollapsed, hunkSides, languageOf, offsetsOf, type Row, rowAt } from './model';

type Mode = 'all' | 'since';
const OVERSCAN_PX = 600;

interface Context {
  task: Task | null;
  title: string;
  reviews: Review[];
  findings: TrackedFinding[];
  reviewer: EngineKind;
  version: string;
  /** Files changed by fix rounds since the first review (for "since round N"). */
  sinceFiles: string[] | null;
  sinceRound: number;
}

function useDiffContext(runId: string, target: DiffTarget): Context {
  const plan = useLatestPlan(runId);
  const run = useRun(runId);
  const coderEngine = useSettings()?.roles.coder.engine ?? 'claude';
  const deps = useData(useShallow((s) => [s.tasks, s.reviews, s.attempts, s.diffstats, s.merges]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from the collections above.
  return useMemo(() => {
    const [tasks, reviews, attempts, diffstats, merges] = deps as [
      Record<string, Task>,
      Record<string, Review>,
      Parameters<typeof attemptsOfRun>[0],
      Record<string, { files: string[] }>,
      Record<string, { runId: string }>,
    ];
    if (target.kind === 'task') {
      const task = tasks[target.taskId] ?? null;
      const node = task ? plan?.dag.nodes.find((n) => n.id === task.nodeId) : null;
      const mine = reviewsOfRun(reviews, runId).filter((r) => r.taskId === target.taskId);
      const coder = attemptsOfRun(attempts, runId).filter((a) => a.taskId === target.taskId && a.role === 'coder');
      const engine = coder.at(-1)?.engine ?? coderEngine;
      const first = mine[0];
      const since = first ? filesChangedSince(coder, diffstats, target.taskId, first.createdAt) : [];
      return {
        task,
        title: task ? `${task.nodeId} · ${node?.title ?? ''}` : 'Task diff',
        reviews: mine,
        findings: trackFindings(mine),
        reviewer: otherEngine(engine),
        version: `${task?.updatedAt ?? 0}:${mine.length}`,
        sinceFiles: first && since.length > 0 ? since : null,
        sinceRound: Math.max(1, mine.length - (task?.status === 'fixing' ? 0 : 1)),
      };
    }
    // Run diff: the final review, plus open findings of each task's latest review.
    const all = reviewsOfRun(reviews, runId);
    const final = all.filter((r) => r.taskId === null);
    const perTask = tasksOfRun(tasks, runId).flatMap((t) =>
      trackFindings(all.filter((r) => r.taskId === t.id)).filter((f) => f.state === 'open'),
    );
    const merged = Object.values(merges).filter((m) => m.runId === runId).length;
    return {
      task: null,
      title: run?.integrationBranch ? `${run.baseRef}...${run.integrationBranch}` : 'Run diff',
      reviews: final,
      findings: [...trackFindings(final), ...perTask],
      reviewer: 'codex',
      version: `${run?.updatedAt ?? 0}:${merged}`,
      sinceFiles: null,
      sinceRound: 1,
    };
  }, [runId, targetKey(target), plan, run, coderEngine, ...deps]);
}

export default function DiffTile({ runId, params, focused, visible }: TileProps<'diff'>) {
  const target = params.target;
  const runCtx = useDiffContext(runId, target);
  const diff = useDiff(target, runCtx.version);
  // A project commit (`git.show`): its subject and author head the diff.
  const commit = (diff.data as { commit?: { subject: string; author: string; shortSha: string } } | null)?.commit;
  const ctx = useMemo(
    () => (commit ? { ...runCtx, title: `${commit.subject} · ${commit.author}` } : runCtx),
    [runCtx, commit],
  );
  const [mode, setMode] = useState<Mode>('all');
  const files = useMemo(() => {
    const all = diff.data?.files ?? [];
    if (mode === 'since' && ctx.sinceFiles) return all.filter((f) => ctx.sinceFiles?.includes(f.path));
    return all;
  }, [diff.data, mode, ctx.sinceFiles]);

  if (!diff.data && diff.loading) return <Skeleton />;
  if (!diff.data && diff.error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Chip tone="bad">diff unavailable</Chip>
        <p className="mono max-w-sm text-[12px] text-subtext0">{diff.error}</p>
        <button type="button" className="btn btn-sm" onClick={diff.refresh}>
          Retry
        </button>
      </div>
    );
  const data = diff.data;
  if (!data) return <Skeleton />;
  return (
    <DiffView
      key={targetKey(target)}
      runId={runId}
      target={target}
      ctx={ctx}
      files={files}
      allFiles={data.files}
      range={`${data.from.slice(0, 9)}..${data.to.length > 12 && !data.to.includes('/') ? data.to.slice(0, 9) : data.to}`}
      mode={mode}
      setMode={setMode}
      focused={focused}
      visible={visible}
      refreshing={diff.loading}
      onRefresh={diff.refresh}
    />
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-hidden="true">
      {[40, 72, 64, 88, 52, 70].map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static
        <div key={i} className="h-2.5 rounded bg-surface0/60" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function estimateFindingHeight(f: TrackedFinding): number {
  const text = f.finding.title.length + f.finding.body.length;
  const lines = Math.ceil(text / 72);
  const fix = f.finding.suggestedFix && f.state === 'open' ? f.finding.suggestedFix.split('\n').length * 18 + 16 : 0;
  const actions = f.state === 'open' && (f.finding.severity === 'minor' || f.finding.severity === 'nit') ? 32 : 0;
  return 16 + 28 + lines * 19 + fix + actions + 14;
}

function DiffView({
  runId,
  target,
  ctx,
  files,
  allFiles,
  range,
  mode,
  setMode,
  focused,
  visible,
  refreshing,
  onRefresh,
}: {
  runId: string;
  target: DiffTarget;
  ctx: Context;
  files: DiffFile[];
  allFiles: DiffFile[];
  range: string;
  mode: Mode;
  setMode: (m: Mode) => void;
  focused: boolean;
  visible: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(allFiles));
  const [measured, setMeasured] = useState<Map<string, number>>(() => new Map());
  const [activeHunk, setActiveHunk] = useState(-1);
  const [activeFinding, setActiveFinding] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });

  const built = useMemo(
    () => buildRows(files, collapsed, ctx.findings, (f) => measured.get(f.key) ?? estimateFindingHeight(f)),
    [files, collapsed, ctx.findings, measured],
  );
  const offsets = useMemo(() => offsetsOf(built.rows), [built]);
  const total = offsets[built.rows.length] ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, []);

  const first = rowAt(offsets, Math.max(0, view.top - OVERSCAN_PX));
  const last = rowAt(offsets, view.top + view.height + OVERSCAN_PX);
  const visibleRows = built.rows.slice(first, last + 1);
  const currentFile = built.rows[rowAt(offsets, view.top + 4)]?.file ?? 0;

  // Highlight the hunks that are on screen.
  useHighlightVersion();
  useEffect(() => {
    if (!visible) return;
    const seen = new Set<string>();
    for (const row of visibleRows) {
      if (row.kind !== 'line') continue;
      const file = files[row.file];
      if (!file) continue;
      const key = `${file.path}#${row.hunk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lang = languageOf(file.path);
      const hunk = file.hunks[row.hunk];
      if (!lang || !hunk) continue;
      const sides = hunkSides(hunk);
      requestHighlight(`${range}|${key}`, lang, [sides.oldCode, sides.newCode]);
    }
  });

  const scrollToRow = (index: number, align: 'top' | 'center' = 'top') => {
    const el = scroller.current;
    if (!el || index < 0) return;
    const y = offsets[index] ?? 0;
    el.scrollTo({
      top: align === 'top' ? Math.max(0, y - 8) : Math.max(0, y - el.clientHeight / 3),
      behavior: 'smooth',
    });
  };

  // Jump requests from the review tile.
  const focusRequest = useStore(diffFocus, (s) => s[targetKey(target)] ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to new requests only.
  useEffect(() => {
    if (!focusRequest) return;
    if (collapsed.has(focusRequest.path)) {
      const next = new Set(collapsed);
      next.delete(focusRequest.path);
      setCollapsed(next);
    }
    requestAnimationFrame(() => {
      const index = built.findingRows.find((i) => {
        const row = built.rows[i];
        return (
          row?.kind === 'finding' &&
          row.finding.finding.file === focusRequest.path &&
          (focusRequest.line === null || row.finding.finding.line === focusRequest.line)
        );
      });
      const at = index ?? built.fileRows.get(focusRequest.path) ?? -1;
      setActiveFinding(index !== undefined ? built.findingRows.indexOf(index) : -1);
      scrollToRow(at, 'center');
    });
  }, [focusRequest?.nonce]);

  const step = (list: number[], current: number, set: (n: number) => void, dir: 1 | -1) => {
    if (list.length === 0) return;
    let next: number;
    if (current < 0) {
      // Start from what is on screen.
      const here = rowAt(offsets, view.top + 4);
      const idx = list.findIndex((r) => r > here);
      next = dir === 1 ? (idx === -1 ? list.length - 1 : idx) : Math.max(0, (idx === -1 ? list.length : idx) - 1);
    } else next = Math.min(list.length - 1, Math.max(0, current + dir));
    set(next);
    scrollToRow(list[next] as number, list === built.findingRows ? 'center' : 'top');
  };

  useTileKeys(root, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'j':
        step(built.hunkRows, activeHunk, setActiveHunk, 1);
        return true;
      case 'k':
        step(built.hunkRows, activeHunk, setActiveHunk, -1);
        return true;
      case 'n':
        step(built.findingRows, activeFinding, setActiveFinding, 1);
        return true;
      case 'N':
        step(built.findingRows, activeFinding, setActiveFinding, -1);
        return true;
      case ']':
      case '[': {
        const next = Math.min(files.length - 1, Math.max(0, currentFile + (e.key === ']' ? 1 : -1)));
        const path = files[next]?.path;
        if (path) scrollToRow(built.fileRows.get(path) ?? 0);
        return true;
      }
      case 'x': {
        const path = files[currentFile]?.path;
        if (path) toggle(path);
        return true;
      }
      default:
        return false;
    }
  });

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  const onMeasure = useCallback((key: string, height: number) => {
    setMeasured((m) => (Math.abs((m.get(key) ?? 0) - height) < 1 ? m : new Map(m).set(key, height)));
  }, []);

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const openFindings = ctx.findings.filter((f) => f.state === 'open').length;
  const activeHunkRow = built.hunkRows[activeHunk] ?? -1;
  const activeFindingRow = built.findingRows[activeFinding] ?? -1;

  return (
    <div ref={root} className="lg-col" data-testid="diff-tile">
      <div className="lg-bar" style={{ gap: 10 }}>
        <span className="min-w-0 truncate text-[12.5px] font-medium">{ctx.title}</span>
        {ctx.task?.status === 'awaiting_human' ? <Chip tone="warn">your call</Chip> : null}
        {ctx.reviews.length > 0 ? <Chip tone="idle">round {ctx.reviews.length}</Chip> : null}
        <span className="flex-1" />
        <span className="mono faint flex-none text-[11.5px]">
          {files.length} file{files.length === 1 ? '' : 's'} <span className="lg-add">+{additions}</span>{' '}
          <span className="lg-del">−{deletions}</span>
          {openFindings ? ` · ${openFindings} open` : ''}
        </span>
        {ctx.sinceFiles ? (
          <Segmented<Mode>
            label="Diff scope"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: 'All changes' },
              {
                value: 'since',
                label: `Since round ${ctx.sinceRound}`,
                title: 'Files the fix rounds touched after the first review',
              },
            ]}
          />
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          style={{ width: 24, height: 24 }}
          onClick={onRefresh}
          aria-label="Refresh diff"
          title={`Refresh · ${range}`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className={refreshing ? 'live' : undefined}
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
          </svg>
        </button>
      </div>
      <div
        className="flex flex-none items-center gap-1 overflow-x-auto border-b border-[var(--hairline)] px-2 py-1.5"
        role="tablist"
        aria-label="Files"
      >
        {files.map((f, i) => (
          <button
            key={f.path}
            type="button"
            role="tab"
            className="lg-ftab"
            aria-current={i === currentFile}
            aria-selected={i === currentFile}
            title={f.path}
            onClick={() => {
              if (collapsed.has(f.path)) toggle(f.path);
              scrollToRow(built.fileRows.get(f.path) ?? 0);
            }}
          >
            {f.path.split('/').at(-1)}
            {f.additions ? <span className="lg-add">+{f.additions}</span> : null}
            {f.deletions ? <span className="lg-del">−{f.deletions}</span> : null}
          </button>
        ))}
        {files.length === 0 ? <span className="faint px-2 text-[12px]">No changes in this range</span> : null}
      </div>
      <div ref={scroller} className="lg-scroll relative" data-testid="diff-scroll">
        <div style={{ height: total, position: 'relative' }}>
          {visibleRows.map((row, i) => {
            const index = first + i;
            return (
              <div
                key={row.key}
                style={{
                  position: 'absolute',
                  top: offsets[index],
                  left: 0,
                  right: 0,
                  height: row.kind === 'finding' ? undefined : row.height,
                }}
              >
                <RowView
                  row={row}
                  file={files[row.file] as DiffFile}
                  range={range}
                  collapsed={collapsed.has(files[row.file]?.path ?? '')}
                  onToggle={toggle}
                  findings={ctx.findings}
                  activeHunk={index === activeHunkRow}
                  activeFinding={index === activeFindingRow}
                  reviewer={ctx.reviewer}
                  task={ctx.task}
                  scope={ctx.task?.id ?? runId}
                  onMeasure={onMeasure}
                />
              </div>
            );
          })}
        </div>
        {built.elsewhere.length > 0 ? (
          <div className="px-3.5 pb-4">
            <div className="lg-sec">Findings outside this diff</div>
            <div className="flex flex-col gap-2">
              {built.elsewhere.map((f) => (
                <FindingCard
                  key={f.key}
                  tracked={f}
                  reviewer={ctx.reviewer}
                  task={ctx.task}
                  scope={ctx.task?.id ?? runId}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {focused ? (
        <div className="faint flex flex-none items-center gap-3 border-t border-[var(--hairline)] px-3.5 py-1.5 text-[11px]">
          <span>
            <span className="kbd">j</span>/<span className="kbd">k</span> hunks
          </span>
          <span>
            <span className="kbd">n</span> next finding
          </span>
          <span>
            <span className="kbd">[</span>/<span className="kbd">]</span> files
          </span>
          <span>
            <span className="kbd">x</span> collapse
          </span>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_MARK: Record<DiffFile['status'], { text: string; color: string }> = {
  added: { text: 'A', color: 'var(--green)' },
  modified: { text: 'M', color: 'var(--yellow)' },
  deleted: { text: 'D', color: 'var(--red)' },
  renamed: { text: 'R', color: 'var(--blue)' },
  copied: { text: 'C', color: 'var(--blue)' },
  type_changed: { text: 'T', color: 'var(--overlay2)' },
};

const RowView = memo(function RowView({
  row,
  file,
  range,
  collapsed,
  onToggle,
  findings,
  activeHunk,
  activeFinding,
  reviewer,
  task,
  scope,
  onMeasure,
}: {
  row: Row;
  file: DiffFile;
  range: string;
  collapsed: boolean;
  onToggle: (path: string) => void;
  findings: TrackedFinding[];
  activeHunk: boolean;
  activeFinding: boolean;
  reviewer: EngineKind;
  task: Task | null;
  scope: string;
  onMeasure: (key: string, height: number) => void;
}) {
  switch (row.kind) {
    case 'file': {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
      const count = findings.filter((f) => f.finding.file === file.path && f.state === 'open').length;
      const mark = STATUS_MARK[file.status];
      return (
        <button type="button" className="lg-fhead" onClick={() => onToggle(file.path)} aria-expanded={!collapsed}>
          <svg
            className="lg-chev"
            data-open={!collapsed}
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span style={{ color: mark.color }} title={file.status}>
            {mark.text}
          </span>
          <span className="min-w-0 truncate">
            <span className="faint">{dir}</span>
            {file.path.slice(dir.length)}
          </span>
          {count ? (
            <Chip tone="warn">
              {count} finding{count === 1 ? '' : 's'}
            </Chip>
          ) : null}
          <span className="ml-auto flex-none text-[11.5px]">
            {file.additions ? <span className="lg-add">+{file.additions} </span> : null}
            {file.deletions ? <span className="lg-del">−{file.deletions}</span> : null}
          </span>
        </button>
      );
    }
    case 'hunk': {
      const h = file.hunks[row.hunk];
      if (!h) return null;
      return (
        <div className="lg-hunk" data-active={activeHunk}>
          @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@{' '}
          <span className="faint">{h.header || (file.status === 'added' ? 'new file' : '')}</span>
        </div>
      );
    }
    case 'line':
      return <LineView file={file} row={row} range={range} />;
    case 'finding':
      return (
        <Measured id={row.finding.key} onMeasure={onMeasure}>
          <div className="py-1.5 pr-3.5 pl-[62px]">
            <FindingCard
              tracked={row.finding}
              reviewer={reviewer}
              task={task}
              scope={scope}
              compact
              active={activeFinding}
            />
          </div>
        </Measured>
      );
    case 'note':
      return (
        <div className="faint flex h-full items-center gap-3 px-[62px] text-[12px]">
          {row.text}
          {collapsed ? (
            <button type="button" className="lg-link text-[12px]" onClick={() => onToggle(file.path)}>
              Expand
            </button>
          ) : null}
        </div>
      );
    case 'gap':
      return null;
  }
});

function Measured({
  id,
  onMeasure,
  children,
}: {
  id: string;
  onMeasure: (key: string, h: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    onMeasure(id, el.offsetHeight);
    const observer = new ResizeObserver(() => onMeasure(id, el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [id, onMeasure]);
  return <div ref={ref}>{children}</div>;
}

function LineView({ file, row, range }: { file: DiffFile; row: Extract<Row, { kind: 'line' }>; range: string }) {
  const hunk = file.hunks[row.hunk];
  const line = hunk?.lines[row.line];
  if (!hunk || !line) return null;
  const tokens = highlighted(`${range}|${file.path}#${row.hunk}`);
  let toks: Tok[] | null = null;
  if (tokens) {
    const sides = hunkSides(hunk);
    const at = sides.index[row.line];
    if (at && at.at >= 0) toks = tokens[at.side === 'old' ? 0 : 1]?.[at.at] ?? null;
  }
  const oneCol = file.status === 'added' || file.status === 'deleted';
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'no_newline' ? '\\' : ' ';
  return (
    <div
      className={`lg-dl ${oneCol ? 'one-col' : ''}`}
      data-k={line.kind}
      data-anchor={row.anchor === 'open' ? 'true' : row.anchor === 'resolved' ? 'resolved' : undefined}
    >
      {oneCol ? null : <span className="ln">{line.oldLine ?? ''}</span>}
      <span className="ln">{(oneCol && file.status === 'deleted' ? line.oldLine : line.newLine) ?? ''}</span>
      <span className="sg">{sign}</span>
      <span className="tx">
        {toks
          ? toks.map((t, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: token order is stable
                key={i}
                style={t.c || t.i ? { color: t.c ?? undefined, fontStyle: t.i ? 'italic' : undefined } : undefined}
              >
                {t.t}
              </span>
            ))
          : line.text || ' '}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------------------------

export function Card({ runId, params }: TileCardProps<'diff'>) {
  const ctx = useDiffContext(runId, params.target);
  const open = ctx.findings.filter((f) => f.state === 'open');
  return (
    <>
      <div>{ctx.title}</div>
      <div>
        {ctx.reviews.length
          ? `${ctx.reviews.length} review round${ctx.reviews.length === 1 ? '' : 's'}`
          : 'not reviewed yet'}
      </div>
      <div>
        {open.length ? `${open.length} open finding${open.length === 1 ? '' : 's'} inline` : 'no open findings'}
      </div>
    </>
  );
}
