/**
 * The command registry (architecture §11): one list of commands feeds keybindings, the palette
 * (`useCommands()`), tooltips (`commandTooltip(id)`), and the app menu (`executeCommand(id)`, also reachable
 * via `window.postMessage({ type: 'legion:command', id })`).
 *
 * Keyboard rules:
 * - ⌘-chords work everywhere, including text inputs, unless the command sets `inInput: false`.
 * - Plain keys (Escape) never fire while typing in an input, unless the command sets `inInput: true`.
 * - Terminals are "locked": everything except ⌘-chords passes through to them.
 * - Overlays own their keys: while one is open, only commands marked `inOverlay` (opening/closing/switching
 *   overlays) are dispatched from the keyboard; everything else (⌘⏎ Focus layout, ⌘⌥H, plain tile keys, ...)
 *   passes through untouched to the overlay, so e.g. ⌘⏎ submits the composer even with focus on a button.
 *   `executeCommand` (palette, app menu) is not guarded: those callers decide for themselves.
 */
import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { boardCommands } from '../board/commands';
import { boardActions } from '../board/state';
import { codeCommands } from '../code/commands';
import type { Workspace } from '../layout/tree';
import { toast } from '../overlays/nav';
import { canArchive, isArchived, runPr } from './compat';
import { isConfirmOpen } from './confirm';
import { type DataState, hasAgents, TERMINAL_RUN_STATUSES } from './data';
import { rpc } from './hooks';
import { formatChord, isTerminal, isTextInput, matchesChord, ownsPlainKeys, parseChord } from './keys';
import {
  addProjectFromDialog,
  newRunInProject,
  openProject,
  openSearch,
  removeProject,
  setPinned,
} from './project-actions';
import { selectWorkspaceRuns } from './projects';
import { archiveRunInteractively, discardRunInteractively, refreshPr, stopRunInteractively } from './run-actions';
import { actions, activeProjectOf, dataStore, jumpToNextDecision, type UiState, uiStore } from './store';

export interface CommandContext {
  ui: UiState;
  data: DataState;
  activeRunId: string | null;
  layout: Workspace | null;
}

export type CommandCategory = 'Run' | 'Project' | 'Layout' | 'Focus' | 'Tile' | 'Overlay' | 'Workspace' | 'App';

export interface Command {
  /** Stable id, e.g. `view.code`. The app menu and palette refer to commands by id. */
  id: string;
  title: string;
  category?: CommandCategory;
  /** One or more bindings like `Mod+Alt+H` (see keys.ts). The first is shown in tooltips. */
  keybinding?: string | readonly string[];
  /** Override whether the binding fires while a text input has focus (see module doc). */
  inInput?: boolean;
  /** The binding also fires while an overlay is open (default: overlays own the keyboard; see module doc). */
  inOverlay?: boolean;
  /** Available right now? Disabled commands are skipped by keys and greyed out in the palette. */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => unknown;
  /** Bound and executable, but not listed in the palette. */
  hidden?: boolean;
  /**
   * When several enabled commands share a binding, the highest priority wins (default 0). Tile-scoped
   * commands (e.g. ⌘⏎ "approve" on a focused review) use it to take precedence over global ones.
   */
  priority?: number;
  /**
   * Fires again on key auto-repeat (holding the key): navigation and resizing. Everything else runs once per
   * press, so holding `a` or ⌘⏎ can't approve twice.
   */
  repeatable?: boolean;
}

export interface CommandView extends Command {
  enabled: boolean;
  /** Formatted first keybinding (`⌘⌥H`), or null. */
  shortcut: string | null;
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;
let parsedCache: { version: number; list: { command: Command; chords: ReturnType<typeof parseChord>[] }[] } | null =
  null;

function changed(): void {
  version++;
  parsedCache = null;
  for (const listener of listeners) listener();
}

/** Register (or replace) commands. Returns a disposer. */
export function registerCommands(commands: readonly Command[]): () => void {
  for (const command of commands) registry.set(command.id, command);
  changed();
  return () => {
    for (const command of commands) if (registry.get(command.id) === command) registry.delete(command.id);
    changed();
  };
}

export function registerCommand(command: Command): () => void {
  return registerCommands([command]);
}

export function getCommand(id: string): Command | null {
  return registry.get(id) ?? null;
}

export function listCommands(): Command[] {
  return [...registry.values()];
}

function context(): CommandContext {
  const ui = uiStore.getState();
  return {
    ui,
    data: dataStore.getState(),
    activeRunId: ui.activeRunId,
    // Layout commands only act on what is on screen: the run's tree behind the route map (agents view). The
    // conversation has none, and the Code view keeps its own workspaces (code/state.ts).
    layout: ui.activeRunId && ui.view === 'agents' ? (ui.layouts[ui.activeRunId] ?? null) : null,
  };
}

function bindings(command: Command): string[] {
  if (!command.keybinding) return [];
  return typeof command.keybinding === 'string' ? [command.keybinding] : [...command.keybinding];
}

export function isEnabled(command: Command, ctx: CommandContext = context()): boolean {
  try {
    return command.when ? command.when(ctx) : true;
  } catch {
    return false;
  }
}

/** A command threw or its promise rejected (e.g. `runs.pause` refused): say so, don't fail silently. */
function reportFailure(command: Command, error: unknown): void {
  console.error(`[legion] command ${command.id} failed`, error);
  const code = (error as { code?: unknown } | null)?.code;
  const message =
    code === 'disconnected'
      ? 'the engine is not connected'
      : code === 'not_implemented'
        ? 'this engine does not support it yet'
        : error instanceof Error
          ? error.message
          : String(error);
  toast(`${command.title.replace(/…$/, '')} failed: ${message}`, 'error');
}

/** Run a command by id. Resolves to false when it doesn't exist, isn't available or fails (with a toast). */
export async function executeCommand(id: string): Promise<boolean> {
  const command = registry.get(id);
  if (!command) {
    console.warn(`[legion] unknown command ${id}`);
    return false;
  }
  const ctx = context();
  if (!isEnabled(command, ctx)) return false;
  try {
    await command.run(ctx);
    return true;
  } catch (error) {
    reportFailure(command, error);
    return false;
  }
}

/** `⌘K`-style label of a command's first binding. */
export function shortcutFor(id: string): string | null {
  const binding = bindings(registry.get(id) ?? { id, title: '', run: () => {} })[0];
  return binding ? formatChord(binding) : null;
}

/** Tooltip text: `Command palette  ⌘K`. */
export function commandTooltip(id: string, title?: string): string {
  const command = registry.get(id);
  const shortcut = shortcutFor(id);
  const label = title ?? command?.title ?? id;
  return shortcut ? `${label}  ${shortcut}` : label;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** All palette-visible commands with their enabled state and formatted shortcut. Re-renders on state changes. */
export function useCommands(): CommandView[] {
  useSyncExternalStore(subscribe, () => version);
  // Re-evaluate `when` when the UI or data change.
  useStore(uiStore);
  useStore(dataStore, (s) => s.seq);
  const ctx = context();
  return listCommands()
    .filter((c) => !c.hidden)
    .map((c) => ({ ...c, enabled: isEnabled(c, ctx), shortcut: shortcutFor(c.id) }));
}

// ---------------------------------------------------------------------------------------------
// Key dispatch
// ---------------------------------------------------------------------------------------------

function parsedBindings() {
  if (parsedCache?.version === version) return parsedCache.list;
  const list = listCommands()
    .map((command) => ({ command, chords: bindings(command).map(parseChord) }))
    .sort((a, b) => (b.command.priority ?? 0) - (a.command.priority ?? 0));
  parsedCache = { version, list };
  return list;
}

/**
 * Key-dispatch guard: may `command` handle a key event right now? Separate from `when` (which says whether
 * the command is available at all, e.g. for the palette) because it depends on where the key was pressed.
 */
export function keyGuard(
  command: Command,
  ctx: CommandContext,
  where: { modChord: boolean; inInput: boolean; inTerminal: boolean },
): boolean {
  if (ctx.ui.overlay !== null && !command.inOverlay) return false;
  if (!where.modChord && where.inTerminal) return false;
  if (where.inInput && (where.modChord ? command.inInput === false : command.inInput !== true)) return false;
  return isEnabled(command, ctx);
}

/** Global keydown handler. Returns true when a command handled the event. */
export function handleKeyDown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  // A confirm dialog is up: it owns every key (Esc must not close the overlay underneath).
  if (isConfirmOpen()) return false;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return false;
  // A popover (picker list) owns its plain keys: Esc closes it, not the overlay underneath.
  if (!event.metaKey && !event.ctrlKey && ownsPlainKeys(event.target)) return false;
  const inInput = isTextInput(event.target);
  const inTerminal = isTerminal(event.target);
  const ctx = context();
  for (const { command, chords } of parsedBindings()) {
    for (const chord of chords) {
      if (!matchesChord(chord, event)) continue;
      if (!keyGuard(command, ctx, { modChord: chord.mod || chord.ctrl, inInput, inTerminal })) continue;
      event.preventDefault();
      event.stopPropagation();
      // Auto-repeat of a held key: swallowed unless the command is meant to repeat.
      if (event.repeat && !command.repeatable) return true;
      try {
        void Promise.resolve(command.run(ctx)).catch((error: unknown) => reportFailure(command, error));
      } catch (error) {
        reportFailure(command, error);
      }
      return true;
    }
  }
  return false;
}

/**
 * Esc leaves a conversation's agents for the board. It listens in the bubble phase, after everything on the
 * page: a tile or popover that takes Esc for itself (clearing a selection, closing the folded map) gets it first.
 */
export function handleAgentsEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (isConfirmOpen() || ownsPlainKeys(event.target) || isTextInput(event.target) || isTerminal(event.target))
    return false;
  const { ui } = context();
  if (ui.view !== 'agents' || ui.overlay !== null) return false;
  event.preventDefault();
  void executeCommand('view.agents.leave');
  return true;
}

/** Install the global key handler and the menu command channel. Returns a disposer. */
export function installKeybindings(target: Window = window): () => void {
  const onKey = (event: KeyboardEvent) => void handleKeyDown(event);
  const onEscape = (event: KeyboardEvent) => void handleAgentsEscape(event);
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown } | null;
    if (event.source === target && data?.type === 'legion:command' && typeof data.id === 'string')
      void executeCommand(data.id);
  };
  const onFocus = (event: FocusEvent) => actions.setTerminalLocked(isTerminal(event.target));
  target.addEventListener('keydown', onKey, true);
  target.addEventListener('keydown', onEscape);
  target.addEventListener('message', onMessage);
  target.addEventListener('focusin', onFocus);
  // The app menu (main process) may expose a command channel on the bridge in a later version.
  const bridge = (target as Window & { legion?: { onCommand?: (cb: (id: string) => void) => () => void } }).legion;
  const offBridge = typeof bridge?.onCommand === 'function' ? bridge.onCommand((id) => void executeCommand(id)) : null;
  return () => {
    target.removeEventListener('keydown', onKey, true);
    target.removeEventListener('keydown', onEscape);
    target.removeEventListener('message', onMessage);
    target.removeEventListener('focusin', onFocus);
    offBridge?.();
  };
}

// ---------------------------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------------------------

const activeRun = (ctx: CommandContext) => (ctx.activeRunId ? (ctx.data.runs[ctx.activeRunId] ?? null) : null);

const projectInView = (ctx: CommandContext) => activeProjectOf(ctx.ui, ctx.data);
/** The project home is on screen (no run focused). */
const onProjectHome = (ctx: CommandContext) => ctx.activeRunId === null && projectInView(ctx) !== null;

export function builtinCommands(): Command[] {
  const commands: Command[] = [
    // Overlays -----------------------------------------------------------------------------------
    {
      id: 'composer.open',
      inOverlay: true,
      title: 'New run…',
      category: 'Run',
      // ⌘N is a new conversation on the board; the full composer is ⌘⇧N everywhere.
      keybinding: 'Mod+Shift+N',
      // Opened from a project (its home or one of its runs): that project is preselected.
      run: () => newRunInProject(),
    },

    // Projects -----------------------------------------------------------------------------------------
    {
      id: 'project.add',
      inOverlay: true,
      title: 'Add a project…',
      category: 'Project',
      keybinding: 'Mod+O',
      // The composer's repository picker has its own ⌘O (browse for a folder); it keeps it while open.
      when: (ctx) => ctx.ui.overlay !== 'composer',
      run: () => actions.openOverlay('addProject'),
    },
    {
      id: 'project.browse',
      title: 'Add a project from a folder…',
      category: 'Project',
      run: () => addProjectFromDialog(),
    },
    {
      id: 'project.home',
      title: 'Go to project home',
      category: 'Project',
      keybinding: 'Mod+Shift+H',
      when: (ctx) => projectInView(ctx) !== null && !onProjectHome(ctx),
      run: (ctx) => {
        const project = projectInView(ctx);
        if (project) openProject(project.id);
      },
    },
    {
      id: 'file.goto',
      inOverlay: true,
      title: 'Go to file…',
      category: 'Project',
      keybinding: 'Mod+P',
      when: (ctx) => projectInView(ctx) !== null,
      run: (ctx) => (ctx.ui.overlay === 'goto' ? actions.closeOverlay() : actions.openOverlay('goto')),
    },
    {
      id: 'project.search',
      inOverlay: true,
      title: 'Search in project…',
      category: 'Project',
      keybinding: 'Mod+Shift+F',
      when: (ctx) => projectInView(ctx) !== null,
      run: (ctx) => {
        const project = projectInView(ctx);
        if (!project) return;
        actions.closeOverlay();
        openSearch(project.id);
      },
    },
    {
      id: 'project.pin',
      title: 'Pin project to the top of the rail',
      category: 'Project',
      when: (ctx) => projectInView(ctx)?.pinned === false,
      run: (ctx) => {
        const project = projectInView(ctx);
        if (project) return setPinned(project, true);
      },
    },
    {
      id: 'project.unpin',
      title: 'Unpin project',
      category: 'Project',
      when: (ctx) => projectInView(ctx)?.pinned === true,
      run: (ctx) => {
        const project = projectInView(ctx);
        if (project) return setPinned(project, false);
      },
    },
    {
      id: 'project.remove',
      title: 'Remove project from Legion (keeps the folder)',
      category: 'Project',
      when: onProjectHome,
      run: (ctx) => {
        const project = projectInView(ctx);
        if (project) return removeProject(project);
      },
    },
    // Views -------------------------------------------------------------------------------------------
    {
      id: 'view.chat',
      title: 'Show the conversation',
      category: 'Layout',
      when: (ctx) => ctx.ui.view !== 'chat' && (activeRun(ctx) !== null || projectInView(ctx) !== null),
      run: (ctx) => (ctx.ui.view === 'agents' ? boardActions.backFromAgents() : actions.setView('chat')),
    },
    // The agents are the inside of one conversation, not a view of their own: ⌘E on the focused tile goes in,
    // ⌘E or Esc comes back out to it. A conversation without a plan or tasks has nothing to show; ⌘E does nothing.
    {
      id: 'view.agents',
      title: "Show this conversation's agents",
      category: 'Layout',
      keybinding: 'Mod+E',
      when: (ctx) => ctx.ui.view === 'chat' && hasAgents(ctx.data, ctx.activeRunId),
      run: () => actions.setView('agents'),
    },
    {
      id: 'view.agents.leave',
      title: 'Back to the board',
      category: 'Layout',
      keybinding: 'Mod+E',
      when: (ctx) => ctx.ui.view === 'agents',
      run: () => boardActions.backFromAgents(),
    },
    {
      id: 'view.code',
      title: "Show the code: the project's workspaces",
      category: 'Layout',
      keybinding: 'Mod+Shift+E',
      when: (ctx) => ctx.ui.view !== 'code' && projectInView(ctx) !== null,
      run: () => actions.setView('code'),
    },
    {
      id: 'palette.open',
      inOverlay: true,
      title: 'Command palette',
      category: 'Overlay',
      keybinding: 'Mod+K',
      run: () => actions.toggleOverlay('palette'),
    },
    {
      id: 'settings.open',
      inOverlay: true,
      title: 'Settings…',
      category: 'App',
      keybinding: 'Mod+,',
      run: (ctx) => (ctx.ui.overlay === 'settings' ? actions.closeOverlay() : actions.openSettings()),
    },
    {
      id: 'overlay.close',
      title: 'Close overlay',
      category: 'Overlay',
      keybinding: 'Escape',
      inInput: true,
      inOverlay: true,
      hidden: true,
      when: (ctx) => ctx.ui.overlay !== null,
      run: () => actions.closeOverlay(),
    },

    {
      id: 'decision.next',
      inOverlay: true,
      title: 'Next decision waiting for you',
      category: 'Focus',
      keybinding: ['Mod+U', 'Mod+I'],
      run: () => {
        if (jumpToNextDecision()) actions.closeOverlay();
        else toast('Nothing is waiting for you.', 'info');
      },
    },

    // Run ----------------------------------------------------------------------------------------------
    {
      id: 'run.pause',
      title: 'Pause run',
      category: 'Run',
      when: (ctx) => {
        const run = activeRun(ctx);
        return !!run && !run.paused && !TERMINAL_RUN_STATUSES.has(run.status);
      },
      run: (ctx) => rpc('runs.pause', { runId: ctx.activeRunId as string }),
    },
    {
      id: 'run.resume',
      title: 'Resume run',
      category: 'Run',
      when: (ctx) => {
        const run = activeRun(ctx);
        return !!run && run.paused;
      },
      run: (ctx) => rpc('runs.resume', { runId: ctx.activeRunId as string }),
    },
    {
      id: 'run.discard',
      title: 'Remove everything the run left…',
      category: 'Run',
      when: (ctx) => isArchived(activeRun(ctx)),
      run: async (ctx) => {
        const run = activeRun(ctx);
        if (run) await discardRunInteractively(run);
      },
    },
    {
      id: 'run.stop',
      title: 'Stop run…',
      category: 'Run',
      when: (ctx) => {
        const run = activeRun(ctx);
        return !!run && !TERMINAL_RUN_STATUSES.has(run.status);
      },
      run: async (ctx) => {
        const run = activeRun(ctx);
        if (run) await stopRunInteractively(run);
      },
    },
    {
      id: 'run.archive',
      title: 'Archive run (cleans up its worktrees)',
      category: 'Run',
      when: (ctx) => canArchive(activeRun(ctx)),
      run: async (ctx) => {
        const run = activeRun(ctx);
        if (!run) return;
        try {
          await archiveRunInteractively(run);
        } catch (error) {
          toast(`Couldn't archive: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      },
    },
    {
      id: 'run.refreshPr',
      title: 'Refresh pull request status',
      category: 'Run',
      when: (ctx) => runPr(activeRun(ctx))?.state === 'open',
      run: async (ctx) => {
        try {
          await refreshPr(ctx.activeRunId as string);
        } catch (error) {
          toast(`Couldn't refresh the PR: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      },
    },
  ];

  commands.push(...boardCommands(), ...codeCommands());

  // Workspaces ⌘1–9: runs in rail order (grouped by project).
  for (let n = 1; n <= 9; n++) {
    commands.push({
      id: `workspace.${n}`,
      title: `Go to workspace ${n}`,
      category: 'Workspace',
      keybinding: `Mod+${n}`,
      hidden: n > 1,
      when: (ctx) => selectWorkspaceRuns(ctx.data).length >= n,
      run: (ctx) => {
        const run = selectWorkspaceRuns(ctx.data)[n - 1];
        if (run) actions.setActiveRun(run.id);
      },
    });
  }
  return commands;
}
