import type { TerminalMessage } from '@shared/rpc';
import { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { useEngine } from '../../app/engine';
import { prefsStore } from '../../app/prefs';
import { actions } from '../../app/store';
import { setTileParams } from '../../layout/tree';
import type { TileProps } from '../../layout/types';
import { openOrAttach } from './attach';
import { TERMINAL_FONT_FAMILY, terminalTheme, terminalThemeLatte } from './theme';
import { webglPool } from './webgl-pool';

type Status = 'idle' | 'connecting' | 'live' | 'exited' | 'error';

/** Refit only after the container's size has been stable this long (layout animations keep it changing). */
const SETTLE_MS = 140;
/** Tell the engine how much output was written to xterm every time this many bytes accumulate. */
const ACK_EVERY = 32 * 1024;

interface Live {
  term: Terminal;
  fit: FitAddon;
  port: MessagePort | null;
  terminalId: string | null;
  opening: boolean;
  disposed: boolean;
  lastCols: number;
  lastRows: number;
  webgl: { addon: WebglAddon; release: () => void } | null;
}

/**
 * A raw terminal on an engine pty (shell in a directory, or a resumed agent session). Output arrives on
 * a dedicated MessagePort; the engine sends the scrollback as the first message when a view attaches.
 * Keys go to the program ("locked"); only ⌘-chords pass through to the app's keybindings.
 *
 * The engine terminal id is kept in the tile's params: the tile unmounts whenever its column scrolls far
 * away or the layout mode / run changes, and on remount it re-attaches to the same process (scrollback
 * included) instead of starting a new shell and orphaning the old one, dev server and all.
 */
export default function TerminalTile({ tileId, runId, params, focused, visible }: TileProps<'terminal'>) {
  const engine = useEngine();
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const target = params.attemptId
    ? ({ kind: 'attempt', attemptId: params.attemptId } as const)
    : params.cwd
      ? ({ kind: 'shell', cwd: params.cwd } as const)
      : null;
  const targetKey = target ? (target.kind === 'attempt' ? `a:${target.attemptId}` : `s:${target.cwd}`) : '';

  // biome-ignore lint/correctness/useExhaustiveDependencies: the session is keyed by tile + target.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!target) {
      setStatus('error');
      setDetail('No working directory or session for this terminal.');
      return;
    }

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 12.5,
      lineHeight: 1.18,
      letterSpacing: 0,
      scrollback: 5000,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      smoothScrollDuration: 0,
      theme: prefsStore.getState().flavour === 'latte' ? terminalThemeLatte : terminalTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const live: Live = {
      term,
      fit,
      port: null,
      terminalId: null,
      opening: false,
      disposed: false,
      lastCols: 0,
      lastRows: 0,
      webgl: null,
    };
    liveRef.current = live;
    setStatus('connecting');
    setDetail(null);

    // Locked mode: everything goes to the program except ⌘-chords, which bubble to the app.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.metaKey) {
        if (event.key === 'c' && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          event.preventDefault();
        }
        return false;
      }
      return true;
    });
    // Native paste (⌘V, context menu) is handled by xterm's textarea, including bracketed paste.
    term.onData((data) => live.port?.postMessage({ type: 'input', data }));

    let written = 0;
    let acked = 0;
    const attachPort = (port: MessagePort): void => {
      live.port = port;
      port.onmessage = (event: MessageEvent<TerminalMessage>) => {
        const message = event.data;
        if (message.type === 'data') {
          const length = message.data.length;
          term.write(message.data, () => {
            written += length;
            if (written - acked >= ACK_EVERY) {
              port.postMessage({ type: 'ack', bytes: written - acked });
              acked = written;
            }
          });
        } else if (message.type === 'exit') {
          term.write(
            `\r\n\x1b[2m[process exited${message.code === null ? '' : ` with code ${message.code}`}]\x1b[0m\r\n`,
          );
          setStatus('exited');
          setDetail(message.code === null ? null : `exit ${message.code}`);
        }
      };
      // The first ack switches on engine-side flow control for this view; flush sub-threshold remainders.
      port.postMessage({ type: 'ack', bytes: 0 });
      ackTimer = setInterval(() => {
        if (written > acked) {
          port.postMessage({ type: 'ack', bytes: written - acked });
          acked = written;
        }
      }, 100);
    };
    let ackTimer: ReturnType<typeof setInterval> | null = null;

    const open = async (cols: number, rows: number): Promise<void> => {
      if (live.opening || live.terminalId || !target) return;
      live.opening = true;
      const known = paramsRef.current.terminalId;
      try {
        const opened = await openOrAttach((input, options) => engine.call('terminals.open', input, options), {
          target,
          terminalId: known,
          cols,
          rows,
        });
        if (live.disposed) {
          // Unmounted (e.g. StrictMode) before the engine answered: detach, and don't leave a process we just
          // started running for nobody. A terminal we re-attached to stays (it belongs to the tile).
          opened.port.close();
          if (!opened.reattached)
            void engine.call('terminals.close', { terminalId: opened.terminalId }).catch(() => {});
          return;
        }
        live.terminalId = opened.terminalId;
        attachPort(opened.port);
        if (opened.reattached) {
          // The process may still have the size of the view it had before.
          void engine.call('terminals.resize', { terminalId: opened.terminalId, cols, rows }).catch(() => {});
        } else if (opened.terminalId !== known) {
          // Remember the terminal so the next mount re-attaches to it.
          actions.updateLayout(runId, (layout) =>
            setTileParams(layout, tileId, { ...paramsRef.current, terminalId: opened.terminalId }),
          );
        }
        setStatus('live');
        if (visibleRef.current) term.focus();
      } catch (error) {
        if (live.disposed) return;
        setStatus('error');
        setDetail(error instanceof Error ? error.message : String(error));
      } finally {
        live.opening = false;
      }
    };

    const refit = (): void => {
      if (live.disposed || !visibleRef.current) return;
      if (host.offsetWidth < 20 || host.offsetHeight < 20) return;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      if (dims.cols !== term.cols || dims.rows !== term.rows) fit.fit();
      if (!live.terminalId) {
        void open(dims.cols, dims.rows);
      } else if (dims.cols !== live.lastCols || dims.rows !== live.lastRows) {
        void engine
          .call('terminals.resize', { terminalId: live.terminalId, cols: dims.cols, rows: dims.rows })
          .catch(() => {});
      }
      live.lastCols = dims.cols;
      live.lastRows = dims.rows;
    };

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefit = (): void => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(refit, SETTLE_MS);
    };
    const observer = new ResizeObserver(scheduleRefit);
    observer.observe(host);
    // CSS transitions on ancestors: refit once they have finished, in addition to the size-stable debounce.
    const onTransitionEnd = (): void => scheduleRefit();
    document.addEventListener('transitionend', onTransitionEnd, true);
    void document.fonts?.ready.then(scheduleRefit);
    scheduleRefit();

    return () => {
      live.disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (ackTimer) clearInterval(ackTimer);
      observer.disconnect();
      document.removeEventListener('transitionend', onTransitionEnd, true);
      live.webgl?.release();
      live.webgl = null;
      // Detach only: closing the port leaves the process running in the engine (shells are reaped after
      // a grace period, takeover sessions are kept until closed explicitly).
      live.port?.close();
      term.dispose();
      liveRef.current = null;
    };
  }, [engine, tileId, targetKey]);

  // Visibility: refit when shown; focus follows tile focus.
  useEffect(() => {
    if (!visible) return;
    const live = liveRef.current;
    if (!live) return;
    const timer = setTimeout(() => {
      const host = hostRef.current;
      if (!host || live.disposed || host.offsetWidth < 20) return;
      const dims = live.fit.proposeDimensions();
      if (dims && (dims.cols !== live.term.cols || dims.rows !== live.term.rows)) live.fit.fit();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    if (focused && visible) liveRef.current?.term.focus();
    else if (!focused) liveRef.current?.term.blur();
  }, [focused, visible]);

  // WebGL only while visible and focused, within the global pool; DOM renderer otherwise.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluated on visibility/focus/session change.
  useEffect(() => {
    const live = liveRef.current;
    if (!live || !visible || !focused) return;
    let cancelled = false;
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (cancelled || live.disposed || live.webgl) return;
        const addon = new WebglAddon();
        const drop = (): void => {
          if (live.webgl?.addon !== addon) return;
          live.webgl.release();
          live.webgl = null;
          try {
            addon.dispose();
          } catch {
            // already disposed with the terminal
          }
        };
        const release = webglPool.acquire(tileId, drop);
        live.webgl = { addon, release };
        addon.onContextLoss(drop);
        try {
          live.term.loadAddon(addon);
        } catch {
          drop();
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      const webgl = live.webgl;
      if (webgl) {
        live.webgl = null;
        webgl.release();
        try {
          webgl.addon.dispose();
        } catch {
          // terminal already torn down
        }
      }
    };
  }, [focused, visible, tileId, status === 'live']);

  const label = params.attemptId ? 'session' : (params.cwd?.split('/').filter(Boolean).at(-1) ?? 'terminal');
  return (
    <div className="flex h-full min-h-0 flex-col bg-base" data-tile="terminal" data-status={status}>
      <div className="flex h-[22px] shrink-0 items-center gap-2 border-b border-surface0 bg-mantle px-2.5 font-mono text-[10px] text-overlay2">
        <span
          className="rounded-sm bg-surface0 px-1.5 py-px font-sans text-[10.5px] font-medium text-subtext0"
          title="Keys go to the terminal. Only ⌘-chords reach Legion."
        >
          locked
        </span>
        <span className="truncate text-subtext0">{label}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {detail && <span className={status === 'error' ? 'text-error' : ''}>{detail}</span>}
          <span
            className={`size-1.5 rounded-full ${
              status === 'live'
                ? 'bg-ok'
                : status === 'error'
                  ? 'bg-error'
                  : status === 'exited'
                    ? 'bg-overlay0'
                    : 'bg-running'
            }`}
          />
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
