/**
 * The workspace bar: every workspace of the project, in the order made (the main checkout first), each named
 * after what it is on; a worktree's shows a lock while it is read-only and its task's state as a dot (blue while
 * its agent works, static peach while something waits on you). "+" makes a workspace: on the project, or on one
 * of its runs' worktrees (a task's, the integration's). ⌘1–9 switch between them in Code.
 */
import type { Checkout } from '@shared/rpc';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip, executeCommand } from '../app/commands';
import { type DataState, latestPlan } from '../app/data';
import { rpc, useData } from '../app/hooks';
import { formatChord } from '../app/keys';
import { useReducedMotionPref } from '../app/prefs';
import { useQuery } from '../app/query';
import { TASK_SHORT } from '../app/status-words';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
import { SPRING } from '../theme/motion';
import {
  closeWorkspace,
  createWorkspace,
  isReadOnly,
  liveAgent,
  showWorkspace,
  togglePanel,
  workspaceFor,
} from './actions';
import { useProjectCode } from './hooks';
import { codeStore, type Workspace } from './state';

/** What a workspace is called: its own name, else what it is on. */
export function workspaceName(state: DataState, ws: Workspace, projectId: string): string {
  if (ws.name) return ws.name;
  const project = state.projects[projectId]?.name ?? 'Project';
  if (!ws.checkout) return project;
  const task = ws.taskId ? state.tasks[ws.taskId] : undefined;
  if (task) {
    const node = latestPlan(state, task.runId)?.dag.nodes.find((n) => n.id === task.nodeId);
    return `${task.nodeId} ${node?.title ?? ''}`.trim();
  }
  const run = ws.runId ? state.runs[ws.runId] : undefined;
  if (run) return `Integration · ${run.title}`;
  return ws.checkout.split('/').filter(Boolean).at(-1) ?? ws.checkout;
}

interface TabInfo {
  id: string;
  name: string;
  worktree: boolean;
  readOnly: boolean;
  waiting: boolean;
  live: boolean;
}

export function WorkspaceBar({ projectId, current }: { projectId: string; current: Workspace | null }) {
  const project = useProjectCode(projectId);
  const reduced = useReducedMotionPref();
  const tabs = useData(
    useShallow((s) =>
      project.workspaces.map((ws) =>
        JSON.stringify({
          id: ws.id,
          name: workspaceName(s, ws, projectId),
          worktree: ws.checkout !== null,
          readOnly: isReadOnly(s, ws),
          waiting: ws.taskId !== null && s.tasks[ws.taskId]?.status === 'awaiting_human',
          live: liveAgent(s, ws.taskId) !== null,
        } satisfies TabInfo),
      ),
    ),
  ).map((t) => JSON.parse(t) as TabInfo);
  // Several workspaces on the main checkout: number them so they read apart.
  const mains = tabs.filter((t) => !t.worktree);
  const label = (t: TabInfo) => (!t.worktree && mains.length > 1 ? `${t.name} ${mains.indexOf(t) + 1}` : t.name);

  return (
    <div className="cw-bar">
      <button
        type="button"
        className="btn btn-ghost btn-icon cw-panel-toggle"
        aria-label={current?.panel ? 'Hide the side panel' : 'Show the side panel'}
        aria-pressed={current?.panel ?? false}
        title={commandTooltip('code.panel', current?.panel ? 'Hide the side panel' : 'Show the side panel')}
        onClick={togglePanel}
        data-testid="code-panel-toggle"
      >
        <Icon name="sidebar" size={15} />
      </button>
      <div className="bd-tabs cw-spaces" role="tablist" aria-label="Workspaces" data-testid="code-spaces">
        {tabs.map((tab, i) => {
          const active = current?.id === tab.id;
          return (
            <div key={tab.id} className="cw-space" data-active={active || undefined}>
              <button
                type="button"
                role="tab"
                className="bd-tab cw-space-tab"
                aria-selected={active}
                onClick={() => showWorkspace(projectId, tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) void closeWorkspace(projectId, tab.id);
                }}
                title={i < 9 ? `${label(tab)}  ${formatChord(`Mod+${i + 1}`)}` : label(tab)}
                data-space={tab.id}
                data-testid="code-space"
              >
                {active ? (
                  <motion.span
                    layoutId="cw-space-pill"
                    className="bd-tab-pill"
                    transition={reduced ? { duration: 0 } : SPRING}
                  />
                ) : null}
                {tab.waiting ? (
                  <span className="bd-needs-dot" aria-hidden="true" />
                ) : tab.live ? (
                  <span className="cw-live-dot" aria-hidden="true" />
                ) : (
                  <Icon name={tab.worktree ? 'branch' : 'repo'} size={12} className="cw-space-icon" />
                )}
                <span className="bd-tab-text">{label(tab)}</span>
                {tab.readOnly ? <Icon name="lock" size={11} className="cw-space-lock" /> : null}
                {tab.readOnly ? <span className="sr-only">, read-only</span> : null}
                {tab.waiting ? <span className="sr-only">, waiting for you</span> : null}
              </button>
              {tabs.length > 1 ? (
                <button
                  type="button"
                  className="cw-space-close"
                  aria-label={`Close the workspace ${label(tab)}`}
                  title="Close the workspace (and its terminals)"
                  onClick={() => void closeWorkspace(projectId, tab.id)}
                >
                  <Icon name="close" size={10} strokeWidth={2.4} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <NewWorkspace projectId={projectId} />
      <span className="cw-bar-grow" />
      <button
        type="button"
        className="btn btn-ghost cw-new-terminal"
        onClick={() => void executeCommand('tile.newTerminal')}
        title={commandTooltip('tile.newTerminal', 'Open a terminal here')}
        data-testid="code-new-terminal"
      >
        <Icon name="terminal" size={13} />
        Terminal
        <Kbd>{formatChord('Mod+T')}</Kbd>
      </button>
    </div>
  );
}

interface Choice {
  key: string;
  label: string;
  note: string | null;
  run: () => void;
}

/** "+": a new workspace on the project, or on a worktree of one of its runs (switches to it when it exists). */
function NewWorkspace({ projectId }: { projectId: string }) {
  const request = useStore(codeStore, (s) => s.newRequest);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const handled = useRef(request);
  useEffect(() => {
    if (handled.current === request) return;
    handled.current = request;
    setOpen(true);
  }, [request]);
  const checkouts = useQuery<Checkout[]>(
    open ? `checkouts:${projectId}` : null,
    () => rpc('projects.checkouts', { projectId }),
    { staleMs: 3_000 },
  );
  const groups = useData(
    useShallow((s) => {
      const out: string[] = [];
      for (const c of checkouts.data ?? []) {
        const run = c.runId ? s.runs[c.runId] : undefined;
        const task = c.taskId ? s.tasks[c.taskId] : undefined;
        const node = task ? latestPlan(s, task.runId)?.dag.nodes.find((n) => n.id === task.nodeId) : undefined;
        out.push(
          JSON.stringify({
            path: c.path,
            branch: c.branch,
            runId: c.runId,
            taskId: c.taskId,
            run: run?.title ?? (c.kind === 'other' ? 'Other worktrees' : 'Run'),
            label: task
              ? `${task.nodeId} ${node?.title ?? ''}`.trim()
              : c.kind === 'integration'
                ? 'Integration'
                : (c.branch ?? c.path),
            state: task ? TASK_SHORT[task.status] : null,
          }),
        );
      }
      return out;
    }),
  ).map(
    (r) =>
      JSON.parse(r) as {
        path: string;
        branch: string | null;
        runId: string | null;
        taskId: string | null;
        run: string;
        label: string;
        state: string | null;
      },
  );

  const choices: (Choice & { group: string })[] = [
    {
      key: 'main',
      group: '',
      label: 'On the project',
      note: 'main checkout',
      run: () => {
        createWorkspace(projectId, { checkout: null, runId: null, taskId: null });
      },
    },
    ...groups.map((g) => ({
      key: g.path,
      group: g.run,
      label: g.label,
      note: g.state ?? g.branch,
      run: () => workspaceFor(projectId, { checkout: g.path, runId: g.runId, taskId: g.taskId }),
    })),
  ];
  const close = () => setOpen(false);
  const pick = (choice: Choice | undefined) => {
    if (!choice) return;
    close();
    choice.run();
  };

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.cw-new-list')?.focus());
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  return (
    <div className="cw-new" ref={root}>
      <button
        type="button"
        className="btn btn-ghost btn-icon cw-new-button"
        aria-label="New workspace"
        aria-expanded={open}
        title={commandTooltip('code.newWorkspace', 'New workspace')}
        onClick={() => setOpen((o) => !o)}
        data-testid="code-new-workspace"
      >
        <Icon name="plus" size={14} strokeWidth={2.2} />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the list owns its keys (↑↓ ⏎ esc)
        <div
          className="cw-new-pop"
          data-local-keys
          data-testid="code-new-pop"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((a) => (a + step + choices.length) % choices.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              pick(choices[active]);
            }
          }}
        >
          <div className="cw-new-title">New workspace</div>
          <div className="cw-new-list" role="listbox" aria-label="Where" tabIndex={-1}>
            {choices.map((choice, i) => (
              <div key={choice.key}>
                {choice.group && choice.group !== choices[i - 1]?.group ? (
                  <div className="cw-new-group">{choice.group}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className="cw-new-row"
                  data-active={i === active || undefined}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(choice)}
                  data-testid="code-new-choice"
                >
                  <Icon name={i === 0 ? 'repo' : 'branch'} size={13} className="cw-space-icon" />
                  <span className="cw-new-label">{choice.label}</span>
                  {choice.note ? <span className="cw-new-note">{choice.note}</span> : null}
                </button>
              </div>
            ))}
            {checkouts.data && groups.length === 0 ? (
              <p className="cw-new-empty">No run has a worktree yet. They appear here once a plan is underway.</p>
            ) : null}
            {!checkouts.data && checkouts.loading ? <p className="cw-new-empty">Looking for worktrees…</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
