/**
 * Floating panel chrome shared by the composer, inbox and palette: scrim, spring in/out (transform/opacity
 * only, reduced motion → fade), focus trap, initial focus. Esc is the registry's `overlay.close` command.
 */
import { motion, useIsPresent, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { actions } from '../app/store';
import { SPRING } from '../theme/motion';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type Placement = 'center' | 'right';

export function OverlayPanel({
  label,
  placement,
  width,
  top,
  children,
  testId,
  onKeyDown,
}: {
  label: string;
  placement: Placement;
  width: number;
  top: number;
  children: ReactNode;
  testId: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? el).focus({ preventScroll: true });
  }, []);

  const trap = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const el = ref.current;
      if (!el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    onKeyDown?.(event);
  };

  const offset = placement === 'right' ? { x: 18, y: 0 } : { x: 0, y: -10 };
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, ...offset, scale: placement === 'right' ? 1 : 0.985 };
  const shown = { opacity: 1, x: 0, y: 0, scale: 1 };

  return (
    <div className="ovl-layer" data-overlay-root inert={!present || undefined}>
      <motion.button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        className="ovl-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={() => actions.closeOverlay()}
      />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
        className={`ovl ovl-${placement}`}
        style={{ width, top }}
        initial={hidden}
        animate={shown}
        exit={{ ...hidden, transition: { duration: 0.12 } }}
        transition={reduced ? { duration: 0.12 } : SPRING}
        onKeyDown={trap}
      >
        {children}
      </motion.div>
    </div>
  );
}
