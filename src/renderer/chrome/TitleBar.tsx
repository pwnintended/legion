/**
 * Title bar (hiddenInset window): drag region with room for the traffic lights, project / run breadcrumb (the
 * project opens its home), the Chat | Agents switch (a project: Chat | Repository), the agents' layout modes
 * while they are on screen, and the Commands / needs-you / New run buttons.
 */
import { motion } from 'motion/react';
import { commandTooltip, executeCommand } from '../app/commands';
import { useActiveRun, useData, useInbox, useUi } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { openProject } from '../app/project-actions';
import { actions, activeProjectOf, type View } from '../app/store';
import type { LayoutMode } from '../layout/tree';
import { SPRING } from '../theme/motion';
import { Icon, type IconName, LegionMark } from './icons';
import { CommandKbd } from './ui';

const VIEWS: { view: View; label: string; projectLabel: string; icon: IconName }[] = [
  { view: 'chat', label: 'Chat', projectLabel: 'Chat', icon: 'chat' },
  { view: 'agents', label: 'Agents', projectLabel: 'Repository', icon: 'agents' },
];

const MODES: { mode: LayoutMode; label: string; icon: IconName; command: string }[] = [
  { mode: 'strip', label: 'Strip', icon: 'strip', command: 'layout.strip' },
  { mode: 'focus', label: 'Focus', icon: 'focus', command: 'layout.focus' },
  { mode: 'overview', label: 'Overview', icon: 'overview', command: 'layout.overview' },
  { mode: 'pipeline', label: 'Pipeline', icon: 'pipeline', command: 'layout.pipeline' },
];

export function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).slice(-2).join('/');
}

export function TitleBar() {
  const run = useActiveRun();
  const mode = useUi((s) => s.layoutMode);
  const view = useUi((s) => s.view);
  const inbox = useInbox(null);
  const reduced = useReducedMotionPref();
  const demo = useUi((s) => s.demo);
  const activeRunId = useUi((s) => s.activeRunId);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const project = useData((s) => activeProjectOf({ activeRunId, activeProjectId }, s));
  const branch = useData((s) => (project ? (s.projectStatus[project.id]?.branch ?? null) : null));
  return (
    <header
      className="drag flex h-11 flex-none items-center gap-3 border-b border-[var(--chrome-line)] bg-mantle pr-2.5"
      style={{ paddingLeft: 84 }}
      data-testid="titlebar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <LegionMark size={16} />
        <span className="mono text-xs font-semibold tracking-[0.06em] text-mauve">legion</span>
        {demo ? (
          <span className="chip chip-accent" title="Demo mode: fixture data, no engine">
            demo
          </span>
        ) : null}
        {project || run ? <span className="faint">/</span> : null}
        {project ? (
          <button
            type="button"
            className="tb-crumb no-drag"
            onClick={() => openProject(project.id)}
            title={run ? commandTooltip('project.home', `${project.name} home`) : project.path}
            aria-current={run ? undefined : 'page'}
            data-testid="titlebar-project"
          >
            {project.name}
          </button>
        ) : run ? (
          <span className="whitespace-nowrap text-[13px] font-semibold" title={run.repoPath}>
            {repoLabel(run.repoPath)}
          </span>
        ) : null}
        {run ? (
          <>
            {project ? <span className="faint hidden lg:inline">/</span> : null}
            <span className="muted hidden truncate text-[13px] lg:inline" title={run.title}>
              {run.title}
            </span>
            {run.paused ? <span className="chip chip-warn">paused</span> : null}
          </>
        ) : project && branch ? (
          <span className="tb-branch mono" title={`On ${branch}`}>
            <Icon name="branch" size={11} />
            {branch}
          </span>
        ) : null}
      </div>

      {run || project ? (
        <div className="no-drag flex flex-none items-center gap-2">
          <nav aria-label="View" className="segs tb-views isolate flex-none">
            {VIEWS.map((v) => (
              <button
                key={v.view}
                type="button"
                className="seg"
                aria-pressed={view === v.view}
                title={commandTooltip('view.toggle', `${run ? v.label : v.projectLabel}`)}
                onClick={() => actions.setView(v.view)}
                data-testid={`view-${v.view}`}
              >
                {view === v.view ? (
                  <motion.span
                    layoutId="view-pill"
                    className="seg-pill"
                    transition={reduced ? { duration: 0 } : SPRING}
                  />
                ) : null}
                <Icon name={v.icon} />
                <span>{run ? v.label : v.projectLabel}</span>
              </button>
            ))}
          </nav>
        </div>
      ) : null}

      <div className="no-drag flex flex-1 items-center justify-end gap-1.5">
        {run && view === 'agents' ? (
          <nav aria-label="Layout" className="segs tb-modes isolate mr-1.5 flex-none">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className="seg"
                aria-pressed={mode === m.mode}
                aria-label={`${m.label} layout`}
                title={commandTooltip(m.command, `${m.label} layout`)}
                onClick={() => void executeCommand(m.command)}
                data-testid={`layout-${m.mode}`}
              >
                {mode === m.mode ? (
                  <motion.span
                    layoutId="seg-pill"
                    className="seg-pill"
                    transition={reduced ? { duration: 0 } : SPRING}
                  />
                ) : null}
                <Icon name={m.icon} />
              </button>
            ))}
          </nav>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void executeCommand('palette.open')}
          title={commandTooltip('palette.open')}
        >
          <Icon name="search" />
          <span className="hidden lg:inline">Commands</span>
          <CommandKbd id="palette.open" />
        </button>
        <button
          type="button"
          className="btn btn-ghost tb-needs"
          data-waiting={inbox.length > 0 || undefined}
          onClick={() => void executeCommand('decision.next')}
          title={commandTooltip('decision.next')}
          aria-label={inbox.length ? `${inbox.length} waiting for you` : 'Nothing is waiting for you'}
          data-testid="needs-you"
        >
          <span className="tb-needs-dot" aria-hidden="true" />
          <span className="hidden lg:inline">{inbox.length ? 'Needs you' : 'All clear'}</span>
          {inbox.length > 0 ? <span className="tb-needs-count mono">{inbox.length}</span> : null}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void executeCommand('composer.open')}
          title={commandTooltip('composer.open')}
        >
          <Icon name="plus" strokeWidth={2.4} />
          New run
          <CommandKbd id="composer.open" />
        </button>
      </div>
    </header>
  );
}
