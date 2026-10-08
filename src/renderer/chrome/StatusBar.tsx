/**
 * Status bar: usage. The run's spend and each engine's rate-limit windows; in the agents view the route map's
 * keys, in the code view the workspace's (or, with a terminal focused, that keys go to it). Where the run
 * stands and what needs the human live in the conversation (progress strip, needs-you bar) and the title bar.
 */
import { useActiveRun, useRateLimits, useRunCost, useUi } from '../app/hooks';
import { formatCost } from '../layout/describe';
import { Bar } from './ui';

export function StatusBar() {
  const run = useActiveRun();
  const locked = useUi((s) => s.terminalLocked);
  const view = useUi((s) => s.view);
  const cost = useRunCost(run?.id);
  const limits = useRateLimits();

  return (
    <footer
      className="mono flex h-[26px] flex-none items-center gap-3.5 overflow-hidden border-t border-[var(--chrome-line)] bg-mantle px-2.5 text-[11px] whitespace-nowrap text-overlay2"
      data-testid="statusbar"
    >
      {view === 'agents' ? (
        <span className="faint" data-testid="map-hint">
          ⌘E/Esc board · ⌘⌥J/K stations · ⌘⌥H/L tabs
        </span>
      ) : null}
      {view === 'code' ? (
        <span className="faint" data-testid="code-hint">
          {locked
            ? 'keys go to the terminal · ⌘-chords still work · ⌘⌥H/L leave it'
            : '⌘T terminal · ⌘D/⌘⇧D split · ⌘⌥HJKL focus · ⌘⌥⇧ move · ⌘⌃ resize · ⌘⌥T/S/E tabs·stack·split · ⌘1–9 workspaces'}
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
