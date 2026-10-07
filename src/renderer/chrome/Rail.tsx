/**
 * Left rail: projects (name, branch, uncommitted-changes dot, active runs / needs-you), each expandable to its
 * runs (numbered workspaces, ⌘1–9 in this order), "Add project", archived runs on request, and the engines
 * footer. A project row opens its home; a run row opens the run.
 */
import type { Run } from '@shared/domain';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip, executeCommand } from '../app/commands';
import { canArchive, isArchived } from '../app/compat';
import {
  applyProjectStatus,
  openInboxCount,
  runningAttempts,
  selectArchivedRuns,
  TERMINAL_RUN_STATUSES,
  taskCounts,
} from '../app/data';
import { rpc, useActiveRunId, useConnection, useData, useEngines, useUi } from '../app/hooks';
import { setPref, usePrefs } from '../app/prefs';
import { openProject } from '../app/project-actions';
import { activeRunsOf, type RailGroup, selectRailGroups, selectWorkspaceRuns } from '../app/projects';
import { archiveRunInteractively, reloadRuns, stopRunInteractively } from '../app/run-actions';
import { actions, dataStore } from '../app/store';
import { ENGINE_NAME } from '../layout/describe';
import { toast } from '../overlays/nav';
import { Icon } from './icons';
import { runStatusLine } from './run-status';
import { Dot, toneColor } from './ui';

// ---------------------------------------------------------------------------------------------
// Collapsed project groups (per device)
// ---------------------------------------------------------------------------------------------

const COLLAPSED_KEY = 'legion.rail.collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // best effort
  }
}

/** A calm, stable tint per project name (Catppuccin accents only). */
const GLYPH_TINTS = ['mauve', 'blue', 'teal', 'peach', 'pink', 'sapphire', 'green', 'lavender', 'flamingo', 'yellow'];
function tintOf(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--${GLYPH_TINTS[h % GLYPH_TINTS.length]})`;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function RailRun({ run, index, active }: { run: Run; index: number | null; active: boolean }) {
  const stats = useData(
    useShallow((s) => {
      const counts = taskCounts(s, run.id);
      const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
      return {
        agents: runningAttempts(s, run.id).length,
        merged: counts.merged ?? 0,
        total,
        urgent: openInboxCount(s, run.id),
      };
    }),
  );
  const [archiving, setArchiving] = useState(false);
  const line = runStatusLine(run, stats.agents, stats.merged, stats.total, stats.urgent);
  const archived = isArchived(run);
  const archivable = canArchive(run);
  const stoppable = !archived && !TERMINAL_RUN_STATUSES.has(run.status);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      await stopRunInteractively(run);
    } catch (error) {
      toast(`Couldn't stop the run: ${errorText(error)}`, 'error');
    } finally {
      setStopping(false);
    }
  };
  const archive = async () => {
    setArchiving(true);
    try {
      if (!(await archiveRunInteractively(run))) setArchiving(false);
    } catch (error) {
      toast(`Couldn't archive: ${errorText(error)}`, 'error');
      setArchiving(false);
    }
  };
  return (
    <div className="rail-row rr" data-archived={archived} data-archiving={archiving}>
      <button
        type="button"
        className="rail-item rr-item"
        aria-current={active}
        onClick={() => actions.setActiveRun(run.id)}
        title={index !== null && index < 9 ? commandTooltip(`workspace.${index + 1}`, run.title) : run.title}
        data-testid={archived ? 'rail-archived-run' : 'rail-run'}
      >
        <span className="ws rr-ws">{index !== null ? index + 1 : <Icon name="archive" size={11} />}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium">{run.title}</span>
            {stats.urgent > 0 ? (
              <span className="ml-auto flex-none" title={`${stats.urgent} waiting for you`}>
                <Dot color="var(--peach)" live />
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: toneColor(line.tone) }}>
            <Dot color={toneColor(line.tone)} live={line.live} />
            <span className={line.tone === 'idle' ? 'muted truncate' : 'truncate'}>
              {archived ? `archived · ${line.text}` : line.text}
            </span>
          </span>
        </span>
      </button>
      {stoppable ? (
        <button
          type="button"
          className="rail-action btn btn-ghost btn-icon"
          aria-label={`Stop ${run.title}`}
          title={
            active
              ? commandTooltip('run.stop', 'Stop run')
              : 'Stop run: every agent stops, unfinished tasks are cancelled'
          }
          disabled={stopping}
          onClick={() => void stop()}
          data-testid="rail-stop"
        >
          <Icon name="stop" size={12} />
        </button>
      ) : null}
      {archivable ? (
        <button
          type="button"
          className="rail-action btn btn-ghost btn-icon"
          aria-label={`Archive ${run.title}`}
          title={active ? commandTooltip('run.archive', 'Archive run') : 'Archive run (cleans up its worktrees)'}
          disabled={archiving}
          onClick={() => void archive()}
          data-testid="rail-archive"
        >
          <Icon name="archive" size={13} />
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

function ProjectGroup({
  group,
  numbers,
  collapsed,
  onToggle,
}: {
  group: RailGroup;
  numbers: Map<string, number>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const project = group.project;
  const homeActive = useUi((s) => s.activeRunId === null && project !== null && s.activeProjectId === project.id);
  const activeRunId = useActiveRunId();
  const status = useData((s) => (project ? (s.projectStatus[project.id] ?? null) : null));
  const urgent = useData((s) => group.runs.reduce((n, run) => n + openInboxCount(s, run.id), 0));
  const running = activeRunsOf(group.runs).length;
  const containsActive = group.runs.some((r) => r.id === activeRunId);
  const open = !collapsed || containsActive;
  const sub = project
    ? status
      ? status.exists
        ? (status.branch ?? 'detached HEAD')
        : 'folder missing'
      : null
    : 'not a project';

  return (
    <section className="rp" aria-label={group.name} data-current={homeActive || containsActive}>
      <div className="rp-row">
        <button
          type="button"
          className="rail-item rp-item"
          aria-current={homeActive}
          onClick={() => (project ? openProject(project.id) : onToggle())}
          title={project ? `${project.path}\n${commandTooltip('project.home', 'Open the project home')}` : group.path}
          data-testid="rail-project"
          data-project={project?.id ?? undefined}
        >
          <span
            className="rp-glyph"
            style={{ '--tint': project ? tintOf(group.name) : 'var(--overlay0)' } as React.CSSProperties}
            data-orphan={!project}
            aria-hidden="true"
          >
            {group.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="rp-text">
            <span className="rp-name">{group.name}</span>
            {sub ? (
              <span className="rp-sub">
                {project ? <Icon name="branch" size={10} className="rp-branch-icon" /> : null}
                <span className={project ? 'mono truncate' : 'truncate'}>{sub}</span>
                {status?.dirty ? (
                  <span className="rp-dirty" title="Uncommitted changes" role="img" aria-label="uncommitted changes" />
                ) : null}
              </span>
            ) : (
              <span className="rp-sub rp-sub-pending" />
            )}
          </span>
          <span className="rp-badges">
            {urgent > 0 ? (
              <span className="rp-urgent" title={`${urgent} waiting for you`}>
                <Dot color="var(--peach)" live />
              </span>
            ) : running > 0 ? (
              <span className="rp-count mono" title={`${running} active run${running === 1 ? '' : 's'}`}>
                {running}
              </span>
            ) : null}
          </span>
        </button>
        {group.runs.length > 0 ? (
          <button
            type="button"
            className="rp-twisty"
            aria-expanded={open}
            aria-label={open ? `Hide runs of ${group.name}` : `Show runs of ${group.name}`}
            onClick={onToggle}
            disabled={containsActive}
          >
            <Icon name="chevronRight" size={11} strokeWidth={2.4} data-open={open} />
          </button>
        ) : null}
      </div>
      {open && group.runs.length > 0 ? (
        <div className="rp-runs">
          {group.runs.map((run) => (
            <RailRun key={run.id} run={run} index={numbers.get(run.id) ?? null} active={run.id === activeRunId} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Branch / dirty state of every project: on load, when the window regains focus, and every 30 s. */
function useProjectStatusPolling(projectCount: number): void {
  useEffect(() => {
    if (projectCount === 0) return;
    let cancelled = false;
    const load = () =>
      rpc('projects.status', { projectId: null }).then(
        (list) => !cancelled && dataStore.setState((s) => applyProjectStatus(s, list), true),
        () => {},
      );
    void load();
    const timer = setInterval(load, 30_000);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [projectCount]);
}

export function Rail() {
  const groups = useData(selectRailGroups);
  const workspaceRuns = useData(selectWorkspaceRuns);
  const archived = useData(selectArchivedRuns);
  const showArchived = usePrefs((p) => p.showArchived);
  const activeRunId = useActiveRunId();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const projectCount = groups.filter((g) => g.project).length;
  useProjectStatusPolling(projectCount);

  const numbers = new Map(workspaceRuns.map((run, i) => [run.id, i]));
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  const toggleArchived = () => {
    setPref('showArchived', !showArchived);
    reloadRuns();
  };

  return (
    <aside
      aria-label="Projects"
      className="flex w-[236px] flex-none flex-col gap-1 border-r border-[var(--chrome-line)] bg-mantle px-2.5 py-3 max-[760px]:hidden"
    >
      <div className="rail-head">
        <span className="sec">Projects</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon rail-head-add"
          aria-label="Add a project"
          title={commandTooltip('project.add', 'Add a project')}
          onClick={() => void executeCommand('project.add')}
          data-testid="rail-add-project"
        >
          <Icon name="plus" size={13} strokeWidth={2.4} />
        </button>
      </div>
      <nav className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label="Projects and runs">
        {groups.map((group) => (
          <ProjectGroup
            key={group.key}
            group={group}
            numbers={numbers}
            collapsed={collapsed.has(group.key)}
            onToggle={() => toggle(group.key)}
          />
        ))}
        {groups.length === 0 ? (
          <button
            type="button"
            className="rail-item items-center"
            onClick={() => void executeCommand('project.add')}
            title={commandTooltip('project.add')}
          >
            <span className="ws border-[1.5px] border-dashed border-surface1 bg-transparent">
              <Icon name="plus" size={12} strokeWidth={2.4} />
            </span>
            <span className="muted text-[12.5px]">Add a project</span>
          </button>
        ) : null}
        {showArchived ? (
          <>
            <div className="sec mx-2 mt-3 mb-1">Archived</div>
            {archived.length === 0 ? (
              <div className="muted mx-2 text-xs">No archived runs.</div>
            ) : (
              archived.map((run) => <RailRun key={run.id} run={run} index={null} active={run.id === activeRunId} />)
            )}
          </>
        ) : null}
      </nav>
      <button
        type="button"
        className="rail-toggle"
        aria-pressed={showArchived}
        onClick={toggleArchived}
        data-testid="show-archived"
      >
        <Icon name="archive" size={12} />
        {showArchived ? 'Hide archived runs' : 'Show archived runs'}
      </button>
      <EnginesFooter />
    </aside>
  );
}

function EnginesFooter() {
  const engines = useEngines();
  const connection = useConnection();
  const real = engines.list.filter((e) => e.kind !== 'fake');
  const statusColor =
    connection.status === 'connected'
      ? 'var(--green)'
      : connection.status === 'connecting' || connection.status === 'degraded'
        ? 'var(--peach)'
        : 'var(--red)';
  return (
    <div className="mt-auto flex flex-col gap-1 border-t border-[var(--chrome-line)] px-1 pt-2 pb-0.5">
      <div className="flex h-6 items-center px-1">
        <span className="sec">Engines</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon ml-auto h-6 w-6"
          aria-label="Settings"
          title={commandTooltip('settings.open', 'Settings')}
          onClick={() => void executeCommand('settings.open')}
          data-testid="rail-settings"
        >
          <Icon name="settings" size={14} />
        </button>
      </div>
      {real.length === 0 ? (
        <div className="faint px-1 text-xs">
          {engines.status === 'unavailable' ? 'detection unavailable' : 'detecting…'}
        </div>
      ) : (
        real.map((engine) => {
          const problem = !engine.installed ? 'not found' : engine.loggedIn === false ? 'not logged in' : null;
          return (
            <button
              key={engine.kind}
              type="button"
              className="rail-engine"
              title={`${engine.error ?? engine.path ?? ENGINE_NAME[engine.kind]} · engine settings`}
              onClick={() => actions.openSettings('engines')}
            >
              <Dot color={problem ? 'var(--red)' : `var(--${engine.kind === 'codex' ? 'teal' : 'mauve'})`} />
              {ENGINE_NAME[engine.kind]}
              <span className={`mono ml-auto text-[11px] ${problem ? 'text-red' : 'faint'}`}>
                {problem ?? engine.version ?? '?'}
              </span>
            </button>
          );
        })
      )}
      <div className="faint flex items-center gap-2 px-1 pt-0.5 text-[11px]">
        <Dot
          color={statusColor}
          live={connection.status === 'connecting' || connection.status === 'degraded' || connection.syncing}
        />
        engine
        <span
          className="mono ml-auto"
          data-testid="connection-status"
          title={connection.status === 'degraded' ? 'No live updates from the engine; reconnecting…' : undefined}
        >
          {connection.status === 'degraded' ? 'no live updates' : connection.status}
        </span>
      </div>
    </div>
  );
}
