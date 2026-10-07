/**
 * Title bar (hiddenInset window): drag region with room for the traffic lights, project / run breadcrumb (the
 * project opens its home), the Chat | Code switch, and the Commands / needs-you / New run buttons.
 *
 * A conversation's agents are not a view of the switch: they are the inside of one conversation, so Chat stays
 * lit there and the crumb grows `/ Agents`, its run title leading back to the board.
 */
import { motion } from 'motion/react';
import { commandTooltip, executeCommand } from '../app/commands';
import { useActiveRun, useData, useInbox, useUi } from '../app/hooks';
import { useReducedMotionPref } from '../app/prefs';
import { openProject } from '../app/project-actions';
import { actions, activeProjectOf, type View } from '../app/store';
import { boardActions } from '../board/state';
import { SPRING } from '../theme/motion';
import { Icon, type IconName, LegionMark } from './icons';
import { CommandKbd } from './ui';

const VIEWS: { view: View; label: string; icon: IconName; command: string; tip: string }[] = [
  { view: 'chat', label: 'Chat', icon: 'chat', command: 'view.chat', tip: 'The conversations' },
  { view: 'code', label: 'Code', icon: 'fileCode', command: 'view.code', tip: "The project's code and terminals" },
];

export function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).slice(-2).join('/');
}

export function TitleBar() {
  const run = useActiveRun();
  const view = useUi((s) => s.view);
  const inbox = useInbox(null);
  const reduced = useReducedMotionPref();
  const demo = useUi((s) => s.demo);
  const activeRunId = useUi((s) => s.activeRunId);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const project = useData((s) => activeProjectOf({ activeRunId, activeProjectId }, s));
  const branch = useData((s) => (project ? (s.projectStatus[project.id]?.branch ?? null) : null));
  // Inside a conversation's agents, the switch still says where that conversation lives.
  const inAgents = view === 'agents' && run !== null;
  // On a project's board (or inside one of its conversations), New splits a conversation tile in; elsewhere it
  // opens the full composer.
  const onBoard = (view === 'chat' || inAgents) && project !== null;
  const lit: View = view === 'agents' ? 'chat' : view;
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
            {inAgents ? (
              <button
                type="button"
                className="tb-crumb tb-crumb-run no-drag hidden lg:inline"
                onClick={() => boardActions.backFromAgents()}
                title={commandTooltip('view.agents.leave', `Back to ${run.title}`)}
                data-testid="titlebar-run"
              >
                {run.title}
              </button>
            ) : (
              <span className="muted hidden truncate text-[13px] lg:inline" title={run.title}>
                {run.title}
              </span>
            )}
            {inAgents ? (
              <>
                <span className="faint">/</span>
                <span className="tb-here" aria-current="page" data-testid="titlebar-agents">
                  Agents
                </span>
              </>
            ) : null}
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
                aria-pressed={lit === v.view}
                title={
                  inAgents && v.view === 'chat'
                    ? commandTooltip('view.agents.leave', 'Back to the board')
                    : commandTooltip(v.command, v.tip)
                }
                onClick={() =>
                  inAgents && v.view === 'chat' ? boardActions.backFromAgents() : actions.setView(v.view)
                }
                data-testid={`view-${v.view}`}
              >
                {lit === v.view ? (
                  <motion.span
                    layoutId="view-pill"
                    className="seg-pill"
                    transition={reduced ? { duration: 0 } : SPRING}
                  />
                ) : null}
                <Icon name={v.icon} />
                <span>{v.label}</span>
              </button>
            ))}
          </nav>
        </div>
      ) : null}

      <div className="no-drag flex flex-1 items-center justify-end gap-1.5">
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
          onClick={() => void executeCommand(onBoard ? 'board.new' : 'composer.open')}
          title={commandTooltip(onBoard ? 'board.new' : 'composer.open')}
        >
          <Icon name="plus" strokeWidth={2.4} />
          {onBoard ? 'New conversation' : 'New run'}
          <CommandKbd id={onBoard ? 'board.new' : 'composer.open'} />
        </button>
      </div>
    </header>
  );
}
