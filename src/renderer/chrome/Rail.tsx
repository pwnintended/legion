/** Left rail: numbered workspaces (runs) with live status, "New run", and the engines footer. */
import type { Run } from '@shared/domain';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip, executeCommand } from '../app/commands';
import { openInboxCount, runningAttempts, taskCounts } from '../app/data';
import { useActiveRunId, useConnection, useData, useEngines, useRuns } from '../app/hooks';
import { actions } from '../app/store';
import { ENGINE_NAME, type Tone } from '../layout/describe';
import { Icon } from './icons';
import { repoLabel } from './TitleBar';
import { Dot, toneColor } from './ui';

function runStatusLine(
  run: Run,
  agents: number,
  merged: number,
  total: number,
  urgent: number,
): { text: string; tone: Tone; live: boolean } {
  const paused = run.paused ? ' · paused' : '';
  switch (run.status) {
    case 'draft':
      return { text: `draft${paused}`, tone: 'idle', live: false };
    case 'clarifying':
      return urgent
        ? { text: 'questions for you', tone: 'warn', live: true }
        : { text: `clarifying${paused}`, tone: 'run', live: !run.paused };
    case 'planning':
      return { text: `planning${paused}`, tone: 'run', live: !run.paused };
    case 'awaiting_approval':
      return { text: 'plan ready for sign-off', tone: 'warn', live: true };
    case 'executing':
      return {
        text: `executing · ${agents} agent${agents === 1 ? '' : 's'}${paused}`,
        tone: run.paused ? 'warn' : 'run',
        live: !run.paused && agents > 0,
      };
    case 'integrating':
      return { text: `integrating · ${merged}/${total}${paused}`, tone: 'run', live: !run.paused };
    case 'finalizing':
      return { text: `final review${paused}`, tone: 'run', live: !run.paused };
    case 'pr_ready':
      return { text: `PR ready · ${merged}/${total} merged`, tone: 'ok', live: false };
    case 'done':
      return { text: run.prUrl ? 'done · draft PR open' : 'done', tone: 'ok', live: false };
    case 'failed':
      return { text: 'failed', tone: 'bad', live: false };
    case 'cancelled':
      return { text: 'cancelled', tone: 'idle', live: false };
  }
}

function RailItem({ run, index, active }: { run: Run; index: number; active: boolean }) {
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
  const line = runStatusLine(run, stats.agents, stats.merged, stats.total, stats.urgent);
  return (
    <button
      type="button"
      className="rail-item"
      aria-current={active}
      onClick={() => actions.setActiveRun(run.id)}
      title={index < 9 ? commandTooltip(`workspace.${index + 1}`, run.title) : run.title}
      data-testid="rail-run"
    >
      <span className="ws">{index + 1}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{run.title}</span>
          {stats.urgent > 0 ? (
            <span className="ml-auto flex-none" title={`${stats.urgent} waiting for you`}>
              <Dot color="var(--peach)" live />
            </span>
          ) : null}
        </span>
        <span className="muted truncate text-xs">
          {repoLabel(run.repoPath)} · {run.baseRef}
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: toneColor(line.tone === 'idle' ? 'idle' : line.tone) }}
        >
          <Dot color={toneColor(line.tone)} live={line.live} />
          <span className={line.tone === 'idle' ? 'faint truncate' : 'truncate'}>{line.text}</span>
        </span>
      </span>
    </button>
  );
}

export function Rail() {
  const runs = useRuns();
  const activeRunId = useActiveRunId();
  return (
    <aside
      aria-label="Runs"
      className="flex w-[228px] flex-none flex-col gap-1 border-r border-[var(--chrome-line)] bg-mantle px-2.5 py-3 max-[760px]:hidden"
    >
      <div className="sec mx-2 mt-0.5 mb-1.5">Workspaces</div>
      <nav className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {runs.map((run, i) => (
          <RailItem key={run.id} run={run} index={i} active={run.id === activeRunId} />
        ))}
        <button
          type="button"
          className="rail-item"
          onClick={() => void executeCommand('composer.open')}
          title={commandTooltip('composer.open')}
        >
          <span className="ws border-[1.5px] border-dashed border-surface1 bg-transparent">{runs.length + 1}</span>
          <span className="muted pt-0.5 text-[12.5px]">New run</span>
        </button>
      </nav>
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
      : connection.status === 'connecting'
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
        <Dot color={statusColor} live={connection.status === 'connecting' || connection.syncing} />
        engine
        <span className="mono ml-auto" data-testid="connection-status">
          {connection.status}
        </span>
      </div>
    </div>
  );
}
