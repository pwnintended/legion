/**
 * Command palette (⌘K, cmdk): every registered command with its shortcut, plus entries derived from run data:
 * switch run, jump to a task by id ("T3"), take over / interrupt a session, swap a task's engine, open the diff,
 * reveal or copy a worktree, open a planner/reviewer session. With an empty query it leads with what the
 * focused task can do.
 */
import type { Attempt, EngineKind, Task } from '@shared/domain';
import { Command, defaultFilter } from 'cmdk';
import { type ReactNode, useMemo, useState } from 'react';
import { type CommandView, executeCommand, useCommands } from '../app/commands';
import { attemptsOfRun, latestPlan, selectRunList, tasksOfRun } from '../app/data';
import { rpc, useActiveRunId, useData, useLayout } from '../app/hooks';
import { formatChord } from '../app/keys';
import { actions } from '../app/store';
import { Icon, type IconName } from '../chrome/icons';
import { ENGINE_NAME } from '../layout/describe';
import { focusedTile } from '../layout/tree';
import { errorMessage, interrupt, openTaskDiff, sessionTileOf, takeOver } from '../tiles/session/actions';
import { openTileColumn, revealInRun, toast } from './nav';
import { OverlayPanel } from './Shell';

interface Entry {
  id: string;
  group: string;
  title: ReactNode;
  /** Text cmdk matches on. */
  value: string;
  keywords?: string[];
  shortcut?: string | null;
  icon?: IconName;
  hint?: string;
  disabled?: boolean;
  run: () => unknown;
}

/** cmdk needs unique values; only the part after SEP is matched (see `filter`). */
const SEP = '\u0001';
const filter = (value: string, search: string, keywords?: string[]) =>
  defaultFilter(value.slice(value.indexOf(SEP) + 1), search, keywords);

const DONE: readonly Task['status'][] = ['merged', 'skipped', 'cancelled'];

function bridge() {
  return (window as Window & { legion?: { showItemInFolder?: (path: string) => void } }).legion;
}

function closeThen(fn: () => unknown) {
  return () => {
    actions.closeOverlay();
    return fn();
  };
}

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    toast(`${label}: ${errorMessage(error)}`, 'error');
  }
}

function taskEntries(
  runId: string,
  task: Task,
  title: string,
  engine: EngineKind,
  coder: Attempt | null,
  layoutTile: string | null,
  group: string,
): Entry[] {
  const id = task.nodeId;
  const other: EngineKind = engine === 'codex' ? 'claude' : 'codex';
  const out: Entry[] = [];
  if (coder?.status === 'running') {
    out.push({
      id: `takeover:${task.id}`,
      group,
      title: `Take over ${id} in terminal`,
      value: `take over ${id} terminal ${title}`,
      keywords: [id],
      icon: 'terminal',
      run: closeThen(() => takeOver(coder, layoutTile)),
    });
    out.push({
      id: `interrupt:${task.id}`,
      group,
      title: `Interrupt ${id}`,
      value: `interrupt stop ${id} ${title}`,
      keywords: [id],
      icon: 'pause',
      run: closeThen(() => interrupt(coder.id)),
    });
  }
  if (!DONE.includes(task.status)) {
    out.push({
      id: `engine:${task.id}`,
      group,
      title: `Swap ${id} engine to ${ENGINE_NAME[other]}`,
      value: `swap ${id} engine ${other} ${title}`,
      keywords: [id, other],
      icon: 'spark',
      hint: task.status === 'running' ? 'applies to the next attempt' : undefined,
      run: closeThen(() =>
        attempt(`Couldn't swap ${id}`, async () => {
          await rpc('tasks.setEngine', { taskId: task.id, engine: other, model: null, effort: null });
          toast(`${id} will use ${ENGINE_NAME[other]} from its next attempt.`);
        }),
      ),
    });
  }
  out.push({
    id: `diff:${task.id}`,
    group,
    title: `Open ${id} diff`,
    value: `diff changes ${id} ${title}`,
    keywords: [id],
    icon: 'diff',
    run: closeThen(() => openTaskDiff(runId, task.id, layoutTile)),
  });
  const worktree = task.worktreePath;
  if (worktree) {
    out.push({
      id: `finder:${task.id}`,
      group,
      title: `Reveal ${id} worktree in Finder`,
      value: `reveal finder worktree open ${id} ${title}`,
      keywords: [id],
      icon: 'branch',
      run: closeThen(() => bridge()?.showItemInFolder?.(worktree)),
    });
    out.push({
      id: `shell:${task.id}`,
      group,
      title: `Open a terminal in ${id}'s worktree`,
      value: `terminal shell worktree ${id} ${title}`,
      keywords: [id],
      icon: 'terminal',
      run: closeThen(() =>
        openTileColumn(
          runId,
          { kind: 'terminal', params: { terminalId: null, cwd: worktree, attemptId: null } },
          layoutTile,
        ),
      ),
    });
    out.push({
      id: `copy:${task.id}`,
      group,
      title: `Copy ${id} worktree path`,
      value: `copy path worktree ${id} ${title}`,
      keywords: [id],
      icon: 'list',
      run: closeThen(() =>
        attempt("Couldn't copy", async () => {
          await navigator.clipboard.writeText(worktree);
          toast('Worktree path copied.');
        }),
      ),
    });
  }
  return out;
}

function useEntries(): { contextual: Entry[]; data: Entry[] } {
  const activeRunId = useActiveRunId();
  const layout = useLayout(activeRunId);
  const state = useData((s) => s);
  return useMemo(() => {
    const contextual: Entry[] = [];
    const data: Entry[] = [];
    // Runs
    selectRunList(state).forEach((run, i) => {
      data.push({
        id: `run:${run.id}`,
        group: 'Runs',
        title: (
          <>
            Switch to <span className="pal-strong">{run.title}</span>
          </>
        ),
        value: `switch run workspace ${run.title}`,
        shortcut: i < 9 ? formatChord(`Mod+${i + 1}`) : null,
        icon: 'layers',
        run: closeThen(() => actions.setActiveRun(run.id)),
      });
    });
    if (!activeRunId) return { contextual, data };
    const plan = latestPlan(state, activeRunId);
    const tasks = tasksOfRun(state.tasks, activeRunId);
    const attempts = attemptsOfRun(state.attempts, activeRunId);
    const focused = layout ? focusedTile(layout) : null;
    const focusedTaskId =
      focused && (focused.kind === 'session' || focused.kind === 'review')
        ? (focused.params as { taskId: string | null }).taskId
        : null;
    for (const task of tasks) {
      const node = plan?.dag.nodes.find((n) => n.id === task.nodeId) ?? null;
      const title = node?.title ?? task.nodeId;
      const coder = attempts
        .filter((a) => a.taskId === task.id && (a.role === 'coder' || a.role === 'resolver'))
        .at(-1);
      const engine = task.engineOverride ?? coder?.engine ?? node?.agent.engine ?? 'claude';
      const tileId = sessionTileOf(layout, task.id);
      data.push({
        id: `task:${task.id}`,
        group: 'Tasks',
        title: (
          <>
            <span className="pal-id">{task.nodeId}</span>
            {title}
          </>
        ),
        value: `${task.nodeId} ${title}`,
        keywords: [task.nodeId, task.status],
        hint: task.status.replace('_', ' '),
        icon: 'session',
        run: () => revealInRun(activeRunId, tileId),
      });
      const entries = taskEntries(activeRunId, task, title, engine, coder ?? null, tileId, 'Task actions');
      if (task.id === focusedTaskId)
        contextual.push(...entries.map((e) => ({ ...e, group: `${task.nodeId} · ${title}` })));
      else data.push(...entries);
    }
    // Read-only sessions (planner, reviewers) can be opened as their own tiles.
    for (const a of attempts) {
      if (a.role === 'coder' || a.role === 'resolver') continue;
      const task = a.taskId ? state.tasks[a.taskId] : null;
      const label = task ? `${a.role} of ${task.nodeId}` : a.role;
      data.push({
        id: `session:${a.id}`,
        group: 'Sessions',
        title: `Open ${label} session`,
        value: `open session ${label} ${a.engine}`,
        keywords: task ? [task.nodeId] : [],
        hint: `${a.engine} · ${a.status}`,
        icon: 'eye',
        run: closeThen(() =>
          openTileColumn(activeRunId, { kind: 'session', params: { attemptId: a.id, taskId: null } }, null),
        ),
      });
    }
    return { contextual, data };
  }, [state, activeRunId, layout]);
}

function CommandRow({ entry }: { entry: Entry }) {
  return (
    <Command.Item
      value={`${entry.id}${SEP}${entry.value}`}
      keywords={entry.keywords}
      disabled={entry.disabled}
      onSelect={() => void entry.run()}
      className="pal-item"
    >
      {entry.icon ? <Icon name={entry.icon} size={14} className="pal-icon" /> : <span className="pal-icon" />}
      <span className="pal-title">{entry.title}</span>
      {entry.hint ? <span className="pal-hint">{entry.hint}</span> : null}
      {entry.shortcut ? <span className="kbd">{entry.shortcut}</span> : null}
    </Command.Item>
  );
}

const COMMAND_ICON: Record<string, IconName> = {
  'composer.open': 'plus',
  'inbox.open': 'inbox',
  'focus.nextUrgent': 'alert',
  'layout.strip': 'strip',
  'layout.focus': 'focus',
  'layout.overview': 'overview',
  'layout.pipeline': 'pipeline',
  'run.pause': 'pause',
  'run.resume': 'play',
  'tile.newTerminal': 'terminal',
  'tile.close': 'close',
  'column.maximize': 'maximize',
  'column.toggleCollapse': 'collapse',
  'settings.open': 'settings',
};
const CATEGORY_ICON: Record<string, IconName> = {
  Focus: 'arrowRight',
  Column: 'strip',
  Mode: 'maximize',
  Workspace: 'layers',
  Layout: 'strip',
  Run: 'play',
  Tile: 'session',
  Overlay: 'search',
  App: 'settings',
};

function fromCommand(c: CommandView): Entry {
  return {
    icon: COMMAND_ICON[c.id] ?? CATEGORY_ICON[c.category ?? ''],
    id: `cmd:${c.id}`,
    group: c.category ?? 'Commands',
    title: c.title,
    value: `${c.title} ${c.category ?? ''}`,
    shortcut: c.shortcut,
    disabled: !c.enabled,
    run: () => {
      actions.closeOverlay();
      // Let the overlay close first: some commands are unavailable while one is open.
      queueMicrotask(() => void executeCommand(c.id));
    },
  };
}

export function PaletteOverlay() {
  const [search, setSearch] = useState('');
  const commands = useCommands();
  const { contextual, data } = useEntries();
  const searching = search.trim().length > 0;

  const commandEntries = useMemo(
    () =>
      commands
        .filter((c) => c.id !== 'palette.open')
        .map(fromCommand)
        .sort((a, b) => Number(a.disabled ?? false) - Number(b.disabled ?? false)),
    [commands],
  );
  const LEAD = ['cmd:focus.nextUrgent', 'cmd:composer.open', 'cmd:inbox.open'];
  const lead = LEAD.map((id) => commandEntries.find((e) => e.id === id)).filter((e): e is Entry => !!e);
  const rest = commandEntries.filter((e) => !lead.includes(e));

  const groups: [string, Entry[]][] = searching
    ? groupBy([...contextual, ...commandEntries, ...data])
    : [
        ['Suggested', lead.filter((e) => !e.disabled)],
        ...groupBy(contextual),
        ['Commands', rest.filter((e) => !e.disabled)],
        ['Runs', data.filter((e) => e.group === 'Runs')],
        ['Tasks', data.filter((e) => e.group === 'Tasks')],
      ];

  return (
    <OverlayPanel label="Command palette" placement="center" width={600} top={96} testId="palette">
      <Command label="Command palette" loop filter={filter} className="pal">
        <div className="pal-input-row">
          <Icon name="search" size={16} className="pal-search" />
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder="Type a command or a task id…"
            className="pal-input"
            data-autofocus
          />
        </div>
        <Command.List className="pal-list">
          <Command.Empty className="pal-empty">No matching command.</Command.Empty>
          {groups
            .filter(([, entries]) => entries.length > 0)
            .map(([heading, entries]) => (
              <Command.Group key={heading} heading={heading} className="pal-group">
                {entries.map((entry) => (
                  <CommandRow key={entry.id} entry={entry} />
                ))}
              </Command.Group>
            ))}
        </Command.List>
        <div className="ovl-foot pal-foot">
          <span>↑↓ select</span>
          <span>⏎ run</span>
          <span>esc close</span>
        </div>
      </Command>
    </OverlayPanel>
  );
}

function groupBy(entries: Entry[]): [string, Entry[]][] {
  const map = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = map.get(entry.group) ?? [];
    list.push(entry);
    map.set(entry.group, list);
  }
  return [...map.entries()];
}
