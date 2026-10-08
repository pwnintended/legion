/**
 * A terminal tile: the tile frame, a head that says where the shell is (a task's worktree, a takeover of an
 * agent's session, the repository), and the terminal body. Closing it ends the shell.
 */
import type { EngineKind } from '@shared/domain';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { commandTooltip } from '../app/commands';
import type { DataState } from '../app/data';
import { useData } from '../app/hooks';
import { Icon } from '../chrome/icons';
import { EngineChip } from '../chrome/ui';
import { TileBody } from '../layout/TileFrame';
import { FullscreenButton } from './parts';
import { setTerminal, type TerminalParams, toggleFullscreen, updateWorkspace, type Workspace } from './state';
import { leaves } from './tree';

type Label = { title: string; note: string | null; engine: EngineKind | null };

/** What a terminal tile is called: by the task whose worktree it is in, else by its folder. */
export function terminalLabel(state: DataState, params: TerminalParams): Label {
  const attempt = params.attemptId ? state.attempts[params.attemptId] : undefined;
  if (attempt) {
    const task = attempt.taskId ? state.tasks[attempt.taskId] : undefined;
    return {
      title: task ? `Takeover · ${task.nodeId}` : `Takeover · ${attempt.role}`,
      note: null,
      engine: attempt.engine,
    };
  }
  const cwd = params.cwd;
  if (!cwd) return { title: 'Terminal', note: null, engine: null };
  const folder = cwd.split('/').filter(Boolean).at(-1) ?? cwd;
  const task = Object.values(state.tasks).find((t) => t.worktreePath === cwd);
  if (task) return { title: `${task.nodeId} worktree`, note: folder === task.nodeId ? null : folder, engine: null };
  const project = Object.values(state.projects).find((p) => p.path === cwd);
  return { title: 'Terminal', note: project?.name ?? folder, engine: null };
}

/** Every terminal of a workspace by name; terminals that would share a name are numbered in layout order. */
export function terminalLabels(state: DataState, ws: Pick<Workspace, 'root' | 'tiles'>): Record<string, Label> {
  const out: Record<string, Label> = {};
  const ids = leaves(ws.root).filter((id) => ws.tiles[id]?.kind === 'terminal');
  for (const id of ids) {
    const tile = ws.tiles[id];
    if (tile?.kind === 'terminal') out[id] = terminalLabel(state, tile.params);
  }
  const count = new Map<string, number>();
  for (const id of ids) count.set(out[id]?.title ?? '', (count.get(out[id]?.title ?? '') ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const id of ids) {
    const label = out[id];
    if (!label || (count.get(label.title) ?? 0) < 2) continue;
    const n = (seen.get(label.title) ?? 0) + 1;
    seen.set(label.title, n);
    out[id] = { ...label, title: `${label.title} ${n}` };
  }
  return out;
}

export function TerminalFrame({
  projectId,
  ws,
  id,
  params,
  focused,
  canFullscreen,
  onClose,
}: {
  projectId: string;
  ws: Workspace;
  id: string;
  params: TerminalParams;
  focused: boolean;
  canFullscreen: boolean;
  onClose: () => void;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const label = useData(useShallow((s) => terminalLabels(s, ws)[id] ?? terminalLabel(s, params)));
  return (
    <section
      className="tile cw-tile"
      tabIndex={-1}
      aria-label={label.note ? `${label.title}, ${label.note}` : label.title}
      data-code-tile={id}
      data-focused={focused}
      data-testid="code-terminal"
    >
      <header className="tile-head cw-head">
        <Icon name="terminal" size={14} className="cw-head-icon" />
        <span className="tile-title cw-head-title">{label.title}</span>
        {label.note ? <span className="cw-head-note mono">{label.note}</span> : null}
        {label.engine ? <EngineChip engine={label.engine} /> : null}
        <span className="cw-grow" />
        <div className="tile-actions cw-actions" ref={setSlot}>
          {canFullscreen ? (
            <FullscreenButton
              on={ws.fullscreen === id}
              onClick={() => updateWorkspace(projectId, ws.id, (w) => toggleFullscreen(w, id), true)}
            />
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Close the terminal (ends its shell)"
            title={commandTooltip('code.close', 'Close (ends its shell)')}
            onClick={onClose}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>
      <div className="tile-body" data-tile-body>
        <TileBody
          runId={ws.runId ?? ws.id}
          tile={{ id, kind: 'terminal', params, auto: false }}
          focused={focused}
          visible
          actionsSlot={slot}
          onParams={(_, next) => updateWorkspace(projectId, ws.id, (w) => setTerminal(w, id, next as TerminalParams))}
        />
      </div>
    </section>
  );
}
