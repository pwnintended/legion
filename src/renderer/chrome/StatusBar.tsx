/**
 * Status bar: usage. The run's spend and each engine's rate-limit windows; in the agents view the route map's
 * keys, in the code view the workspace's (or, with a terminal focused, that keys go to it). It always starts with
 * the way to every key: "? keys" (⌘? while something has the keyboard, since a bare ? would be typed). Where the
 * run stands and what needs the human live in the conversation (progress strip, needs-you bar) and the title bar.
 */
import { useEffect, useState } from 'react';
import { executeCommand } from '../app/commands';
import { useActiveRun, useRateLimits, useRunCost, useUi } from '../app/hooks';
import { formatChord, IS_MAC, isTerminal, isTextInput, formatModifiers as mods, PANE_MODIFIERS } from '../app/keys';
import { formatCost } from '../layout/describe';
import { keysChord } from '../overlays/Keys';
import { Bar } from './ui';

/** Does something that takes plain keys have the focus (a text field, the editor, a terminal)? */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const update = () =>
      queueMicrotask(() => setTyping(isTextInput(document.activeElement) || isTerminal(document.activeElement)));
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return typing;
}

function KeysHint() {
  const typing = useTyping();
  const overlay = useUi((s) => s.overlay);
  // An overlay's field has the focus while it is up; what matters is where focus goes back to.
  const chord = keysChord(typing && overlay === null);
  return (
    <button
      type="button"
      className="sb-keys"
      data-testid="keys-hint"
      title={`Keyboard shortcuts: ${formatChord('Shift+?')}, or ${formatChord('Mod+Shift+?')} while typing`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void executeCommand('help.keys')}
    >
      <span className="kbd">{chord}</span>
      keys
    </button>
  );
}

export function StatusBar() {
  const run = useActiveRun();
  const locked = useUi((s) => s.terminalLocked);
  const view = useUi((s) => s.view);
  const cost = useRunCost(run?.id);
  const limits = useRateLimits();

  return (
    <footer
      className="mono flex h-[26px] flex-none items-center gap-3.5 overflow-hidden px-2.5 text-[11px] whitespace-nowrap text-overlay2"
      data-testid="statusbar"
    >
      <KeysHint />
      {view === 'agents' ? (
        <span className="faint" data-testid="map-hint">
          {`${formatChord('Mod+E')}/Esc board · ${mods(PANE_MODIFIERS)}J/K stations · ${mods(PANE_MODIFIERS)}H/L tabs`}
        </span>
      ) : null}
      {view === 'code' ? (
        <span className="faint" data-testid="code-hint">
          {locked
            ? `keys go to the terminal · ${IS_MAC ? '⌘-chords' : 'Ctrl+Shift and Ctrl+Alt chords'} still work · ${mods(PANE_MODIFIERS)}HJKL leave it`
            : `${formatChord('Mod+T')} terminal · ${formatChord('Mod+D')}/${formatChord('Mod+Shift+D')} split · ${mods(PANE_MODIFIERS)}HJKL focus · ${mods(`${PANE_MODIFIERS}+Shift`)} move · ${mods('Mod+Ctrl')} resize · ${mods('Mod+Alt')}T/S/E tabs·stack·split · ${mods('Mod')}1–9 workspaces`}
        </span>
      ) : null}

      <span className="flex-1" />

      {run ? <span title="Spend on this run">{formatCost(cost)} this run</span> : null}
      {limits.map((limit) => (
        <span
          key={`${limit.engine}:${limit.window}`}
          className="hidden items-center gap-1.5 md:inline-flex"
          title={limit.resetsAt ? `resets ${new Date(limit.resetsAt).toLocaleString()}` : undefined}
        >
          <span style={{ color: limit.engine === 'codex' ? 'var(--teal)' : 'var(--mauve)' }}>{limit.engine}</span>
          {shortWindow(limit.window)}
          <Bar
            pct={limit.usedPct}
            color={
              limit.usedPct >= 90
                ? 'var(--red)'
                : limit.usedPct >= 75
                  ? 'var(--peach)'
                  : limit.engine === 'codex'
                    ? 'var(--teal)'
                    : 'var(--mauve)'
            }
          />
          {Math.round(limit.usedPct)}%
        </span>
      ))}
    </footer>
  );
}

function shortWindow(window: string): string {
  if (window === 'weekly') return 'wk';
  return window;
}
