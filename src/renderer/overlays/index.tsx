/**
 * Overlay host, mounted once by App: shows the composer (⌘N), inbox (⌘I) or palette (⌘K) from
 * `uiStore.overlay`, restores focus when it closes, and renders transient toasts.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';
import { useUi } from '../app/hooks';
import type { Overlay } from '../app/store';
import { ComposerOverlay } from './Composer';
import { ConfirmHost } from './Confirm';
import { InboxOverlay } from './Inbox';
import { useToasts } from './nav';
import './overlays.css';
import { PaletteOverlay } from './Palette';
import { SettingsOverlay } from './Settings';

const VIEWS: Record<Overlay, () => React.JSX.Element> = {
  composer: ComposerOverlay,
  inbox: InboxOverlay,
  palette: PaletteOverlay,
  settings: SettingsOverlay,
};

/** Put focus back where it was (a rail button, ...) or on the focused tile once an overlay closes. */
function restoreFocus(previous: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement as HTMLElement | null;
    const stillInOverlay = active?.closest('[data-overlay-root]');
    if (active && active !== document.body && !stillInOverlay) return;
    if (previous?.isConnected && !previous.closest('[data-overlay-root], [data-workspace]')) {
      previous.focus({ preventScroll: true });
      return;
    }
    const tile = document.querySelector<HTMLElement>('[data-workspace] [data-focused="true"]');
    if (tile) tile.focus({ preventScroll: true });
    else active?.blur();
  });
}

export default function Overlays() {
  const overlay = useUi((s) => s.overlay);
  const previous = useRef<HTMLElement | null>(null);
  const was = useRef<Overlay | null>(null);

  useLayoutEffect(() => {
    if (overlay && !was.current) previous.current = document.activeElement as HTMLElement | null;
    if (!overlay && was.current) restoreFocus(previous.current);
    was.current = overlay;
  }, [overlay]);

  const View = overlay ? VIEWS[overlay] : null;
  return (
    <>
      <AnimatePresence>{View && overlay ? <View key={overlay} /> : null}</AnimatePresence>
      <ConfirmHost />
      <Toasts />
    </>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast toast-${t.tone}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16 }}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
